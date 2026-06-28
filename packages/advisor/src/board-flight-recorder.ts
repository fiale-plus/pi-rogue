import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardDecision, BoardLedger, BoardRisk, BoardSeverity } from "./board.js";

export type BoardFlightMode = "shadow";

export interface BoardFlightRecord {
  schema: "pi-rogue.advisor-board.flight.v1";
  decisionId: string;
  sessionId?: string;
  worktree?: string;
  turn: number;
  at: string;
  source?: string;
  mode: BoardFlightMode;
  decision: BoardDecision["action"];
  visibleToUser: boolean;
  riskIds: string[];
  riskTypes: BoardRisk["type"][];
  riskSeverities: BoardSeverity[];
  riskFingerprint: string;
  ledgerHash: string;
  evidencePointers: string[];
  budget: {
    turns: number;
    costUsd: number;
    modelCalls: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsd: number;
  };
  latencyMs: number;
  progress: {
    turns: number;
    lastProgressTurn?: number;
    lastChangeTurn?: number;
    lastValidationTurn?: number;
  };
  counts: {
    changedFiles: number;
    evidence: number;
    failures: number;
    subagents: number;
    risks: number;
  };
}

export interface BoardFlightRecordInput {
  ledger: BoardLedger;
  decision: BoardDecision;
  latencyMs: number;
  at?: string;
  source?: string;
  mode?: BoardFlightMode;
  visibleToUser?: boolean;
  modelCalls?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd?: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function riskFingerprint(ledger: BoardLedger): string {
  const payload = ledger.risks
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((risk) => ({
      id: risk.id,
      type: risk.type,
      severity: risk.severity,
      evidence: risk.evidence,
      evidencePointers: [...risk.evidencePointers].sort(),
    }));
  return digest(stableJson(payload));
}

function ledgerFingerprint(ledger: BoardLedger): string {
  const payload = {
    session: ledger.session,
    changedFiles: ledger.changedFiles,
    changedFileTurns: ledger.changedFileTurns,
    evidence: ledger.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      turn: item.turn,
      timestamp: item.timestamp,
      terminal: item.terminal,
      summary: item.summary,
    })),
    failures: ledger.failures.map((failure) => ({
      key: failure.key,
      count: failure.count,
      firstTurn: failure.firstTurn,
      lastTurn: failure.lastTurn,
      tool: failure.tool,
      messages: failure.messages,
    })),
    subagents: ledger.subagents.map((item) => ({
      id: item.id,
      role: item.role,
      topic: item.topic,
      verdict: item.verdict,
      summary: item.summary,
      confidence: item.confidence,
      turn: item.turn,
    })),
    progress: ledger.progress,
    risks: ledger.risks.map((risk) => ({
      id: risk.id,
      type: risk.type,
      severity: risk.severity,
      evidencePointers: [...risk.evidencePointers].sort(),
    })),
  };
  return digest(stableJson(payload));
}

function collectEvidencePointers(ledger: BoardLedger): string[] {
  const pointers = ledger.risks.flatMap((risk) => risk.evidencePointers);
  const evidenceIds = ledger.evidence.map((item) => item.id);
  const failurePointers = ledger.failures.map((failure) => `failure:${failure.tool ?? "tool"}:${failure.key}`);
  const subagentPointers = ledger.subagents.map((item) => `subagent:${item.id}`);
  return unique([...pointers, ...evidenceIds, ...failurePointers, ...subagentPointers]).slice(0, 16);
}

export function buildBoardFlightRecord(input: BoardFlightRecordInput): BoardFlightRecord {
  const riskHash = riskFingerprint(input.ledger);
  const ledgerHash = ledgerFingerprint(input.ledger);
  const turn = input.ledger.progress.turns;
  const mode = input.mode ?? "shadow";
  const visibleToUser = input.visibleToUser ?? (mode === "shadow" ? false : input.decision.action === "would_whisper");
  const decisionId = `flight:${digest(stableJson({
    sessionId: input.ledger.session.id,
    turn,
    action: input.decision.action,
    severity: input.decision.action === "would_whisper" ? input.decision.severity : undefined,
    riskHash,
    ledgerHash,
  })).slice(0, 12)}`;

  return {
    schema: "pi-rogue.advisor-board.flight.v1",
    decisionId,
    sessionId: input.ledger.session.id,
    worktree: input.ledger.session.worktree,
    turn,
    at: input.at ?? new Date().toISOString(),
    source: input.source,
    mode,
    decision: input.decision.action,
    visibleToUser,
    riskIds: input.ledger.risks.map((risk) => risk.id),
    riskTypes: input.ledger.risks.map((risk) => risk.type),
    riskSeverities: input.ledger.risks.map((risk) => risk.severity),
    riskFingerprint: riskHash,
    ledgerHash,
    evidencePointers: collectEvidencePointers(input.ledger),
    budget: {
      turns: turn,
      costUsd: input.ledger.progress.costUsd,
      modelCalls: input.modelCalls ?? 0,
      estimatedInputTokens: input.estimatedInputTokens ?? 0,
      estimatedOutputTokens: input.estimatedOutputTokens ?? 0,
      estimatedCostUsd: input.estimatedCostUsd ?? 0,
    },
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    progress: {
      turns: turn,
      lastProgressTurn: input.ledger.progress.lastProgressTurn,
      lastChangeTurn: input.ledger.progress.lastChangeTurn,
      lastValidationTurn: input.ledger.progress.lastValidationTurn,
    },
    counts: {
      changedFiles: input.ledger.changedFiles.length,
      evidence: input.ledger.evidence.length,
      failures: input.ledger.failures.length,
      subagents: input.ledger.subagents.length,
      risks: input.ledger.risks.length,
    },
  };
}

export function serializeBoardFlightRecord(record: BoardFlightRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function appendBoardFlightRecord(filePath: string, record: BoardFlightRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, serializeBoardFlightRecord(record), "utf8");
}
