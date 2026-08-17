import { createHash } from "node:crypto";
import { decideBoardAction, type BoardDecision, type BoardLedger } from "./board.js";

export type BoardWatchMode = "off" | "shadow" | "intervene";

export interface BoardWatchConfig {
  mode: BoardWatchMode;
  cooldownTurns: number;
  maxInterventions: number;
}

export interface BoardWatchState {
  runs: number;
  interventions: number;
  suppressed: number;
  lastAt?: string;
  lastTurn?: number;
  lastRiskFingerprint?: string;
  lastDecision?: BoardDecision;
}

export interface BoardWatchAdvice {
  fingerprint: string;
  content: string;
  details: {
    kind: "board-watch";
    decision: "would_whisper";
    severity: "note" | "important" | "blocker";
    riskIds: string[];
    nonBinding: true;
    readOnly: true;
  };
}

export interface BoardWatchResult {
  state: BoardWatchState;
  decision: BoardDecision;
  advice?: BoardWatchAdvice;
  skipped?: "off" | "silent" | "ledger_update" | "duplicate" | "cooldown" | "limit";
}

export function defaultBoardWatchConfig(): BoardWatchConfig {
  return { mode: "shadow", cooldownTurns: 3, maxInterventions: 4 };
}

export function normalizeBoardWatchConfig(raw: unknown): BoardWatchConfig {
  const defaults = defaultBoardWatchConfig();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Record<string, unknown>;
  const bounded = (value: unknown, fallback: number, min: number, max: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
  };
  return {
    mode: record.mode === "off" || record.mode === "intervene" ? record.mode : "shadow",
    cooldownTurns: bounded(record.cooldownTurns, defaults.cooldownTurns, 0, 100),
    maxInterventions: bounded(record.maxInterventions, defaults.maxInterventions, 0, 32),
  };
}

export function defaultBoardWatchState(): BoardWatchState {
  return { runs: 0, interventions: 0, suppressed: 0 };
}

export function normalizeBoardWatchState(raw: unknown): BoardWatchState {
  if (!raw || typeof raw !== "object") return defaultBoardWatchState();
  const record = raw as Record<string, unknown>;
  const count = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
  return {
    runs: count(record.runs),
    interventions: count(record.interventions),
    suppressed: count(record.suppressed),
    lastAt: typeof record.lastAt === "string" ? record.lastAt : undefined,
    lastTurn: Number.isFinite(Number(record.lastTurn)) ? Math.max(0, Math.floor(Number(record.lastTurn))) : undefined,
    lastRiskFingerprint: typeof record.lastRiskFingerprint === "string" ? record.lastRiskFingerprint : undefined,
    lastDecision: record.lastDecision as BoardDecision | undefined,
  };
}

function fingerprint(ledger: BoardLedger, decision: BoardDecision): string {
  return createHash("sha256")
    .update(JSON.stringify({ risks: ledger.risks.map((risk) => ({ id: risk.id, type: risk.type, severity: risk.severity })).sort((a, b) => a.id.localeCompare(b.id)), decision }))
    .digest("hex")
    .slice(0, 16);
}

function adviceText(decision: Extract<BoardDecision, { action: "would_whisper" }>, ledger: BoardLedger): string {
  const risks = ledger.risks.filter((risk) => decision.riskIds.includes(risk.id)).slice(0, 3);
  const pointers = risks.flatMap((risk) => risk.evidencePointers).slice(0, 5);
  return [
    "Advisory Board suggestion (read-only, non-binding): pause and consider the following before continuing.",
    `Severity: ${decision.severity}.`,
    `Reason: ${decision.reason}`,
    pointers.length ? `Evidence: ${pointers.join(", ")}` : "Evidence: compact Board ledger only.",
    "The main model may accept, ignore, or ask for clarification; no action was taken automatically.",
  ].join("\n").slice(0, 1800);
}

export function runBoardWatch(config: BoardWatchConfig, previous: BoardWatchState, ledger: BoardLedger, turn: number, now = new Date().toISOString()): BoardWatchResult {
  const prior = normalizeBoardWatchState(previous);
  const state: BoardWatchState = {
    ...prior,
    runs: prior.runs + 1,
    lastAt: now,
    lastTurn: turn,
  };
  const decision = decideBoardAction(ledger);
  state.lastDecision = decision;
  if (config.mode === "off") return { state, decision, skipped: "off" };
  if (decision.action !== "would_whisper") return { state, decision, skipped: decision.action };

  const id = fingerprint(ledger, decision);
  if (prior.lastRiskFingerprint === id) {
    state.suppressed += 1;
    return { state, decision, skipped: "duplicate" };
  }
  if (prior.lastTurn !== undefined && turn - prior.lastTurn < config.cooldownTurns) {
    state.suppressed += 1;
    return { state, decision, skipped: "cooldown" };
  }
  if (prior.interventions >= config.maxInterventions) {
    state.suppressed += 1;
    return { state, decision, skipped: "limit" };
  }
  state.lastRiskFingerprint = id;
  if (config.mode !== "intervene") return { state, decision };
  state.interventions += 1;
  return {
    state,
    decision,
    advice: {
      fingerprint: id,
      content: adviceText(decision, ledger),
      details: { kind: "board-watch", decision: "would_whisper", severity: decision.severity, riskIds: decision.riskIds.slice(0, 8), nonBinding: true, readOnly: true },
    },
  };
}
