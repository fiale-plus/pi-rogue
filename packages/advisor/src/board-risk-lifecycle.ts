import { createHash } from "node:crypto";
import type { BoardLedger, BoardRisk } from "./board.js";

export type BoardRiskLifecycleStatus = "open" | "resolved" | "dismissed" | "reopened" | "stale" | "escalated" | "accepted-until-new-evidence";

export interface BoardRiskLifecycleEntry {
  fingerprint: string;
  type: BoardRisk["type"];
  status: BoardRiskLifecycleStatus;
  firstSeenTurn?: number;
  lastSeenTurn?: number;
  lastNotifiedTurn?: number;
  lastEvidenceFingerprint?: string;
  lastNotifiedEvidenceFingerprint?: string;
  cooldownUntilTurn?: number;
  resolvedAtTurn?: number;
  reopenedAtTurn?: number;
  staleAtTurn?: number;
  suppressedCount: number;
  visibleCount: number;
  evidencePointers: string[];
}

export interface BoardRiskLifecycleState {
  entries: Record<string, BoardRiskLifecycleEntry>;
  lastEvidenceFingerprint?: string;
}

export interface BoardRiskLifecycleUpdate {
  state: BoardRiskLifecycleState;
  visibleRisks: BoardRisk[];
  suppressedRiskIds: string[];
  reopenedRiskIds: string[];
  resolvedRiskIds: string[];
  staleRiskIds: string[];
  evidenceFingerprint: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function riskFingerprint(risk: BoardRisk): string {
  return digest(stableJson({
    type: risk.type,
    severity: risk.severity,
    evidence: risk.evidence,
    evidencePointers: [...risk.evidencePointers].sort(),
  }));
}

function evidenceFingerprint(ledger: BoardLedger): string {
  const validationEpoch = (ledger.progress.lastValidationTurn ?? 0) + 1;
  const normalizedChangedFileTurns = Object.fromEntries(
    Object.entries(ledger.changedFileTurns)
      .map(([file, turn]) => [file, Math.min(Number(turn) || validationEpoch, validationEpoch)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return digest(stableJson({
    session: ledger.session,
    changedFiles: ledger.changedFiles,
    normalizedChangedFileTurns,
    evidence: ledger.evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      timestamp: item.timestamp,
      terminal: item.terminal,
      summary: item.summary,
    })),
    failures: ledger.failures.map((failure) => ({
      key: failure.key,
      count: failure.count,
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
    })),
  }));
}

function cloneState(previous: BoardRiskLifecycleState | undefined): BoardRiskLifecycleState {
  return {
    entries: previous ? Object.fromEntries(Object.entries(previous.entries).map(([key, entry]) => [key, { ...entry, evidencePointers: [...entry.evidencePointers] }])) : {},
    lastEvidenceFingerprint: previous?.lastEvidenceFingerprint,
  };
}

export function defaultBoardRiskLifecycleState(): BoardRiskLifecycleState {
  return { entries: {} };
}

export function normalizeBoardRiskLifecycleState(raw: unknown): BoardRiskLifecycleState {
  if (!raw || typeof raw !== "object") return defaultBoardRiskLifecycleState();
  const record = raw as Partial<BoardRiskLifecycleState>;
  const entries = record.entries && typeof record.entries === "object" ? record.entries as Record<string, Partial<BoardRiskLifecycleEntry>> : {};
  const normalizedEntries: Record<string, BoardRiskLifecycleEntry> = {};
  for (const [fingerprint, entry] of Object.entries(entries)) {
    normalizedEntries[fingerprint] = {
      fingerprint,
      type: entry.type === "repeated_failure" || entry.type === "missing_validation" || entry.type === "no_progress" || entry.type === "subagent_contradiction" || entry.type === "stale_evidence" ? entry.type : "no_progress",
      status: entry.status === "resolved" || entry.status === "dismissed" || entry.status === "reopened" || entry.status === "stale" || entry.status === "escalated" || entry.status === "accepted-until-new-evidence" ? entry.status : "open",
      firstSeenTurn: Number.isFinite(Number(entry.firstSeenTurn)) ? Number(entry.firstSeenTurn) : undefined,
      lastSeenTurn: Number.isFinite(Number(entry.lastSeenTurn)) ? Number(entry.lastSeenTurn) : undefined,
      lastNotifiedTurn: Number.isFinite(Number(entry.lastNotifiedTurn)) ? Number(entry.lastNotifiedTurn) : undefined,
      lastEvidenceFingerprint: typeof entry.lastEvidenceFingerprint === "string" ? entry.lastEvidenceFingerprint : undefined,
      lastNotifiedEvidenceFingerprint: typeof entry.lastNotifiedEvidenceFingerprint === "string" ? entry.lastNotifiedEvidenceFingerprint : undefined,
      cooldownUntilTurn: Number.isFinite(Number(entry.cooldownUntilTurn)) ? Number(entry.cooldownUntilTurn) : undefined,
      resolvedAtTurn: Number.isFinite(Number(entry.resolvedAtTurn)) ? Number(entry.resolvedAtTurn) : undefined,
      reopenedAtTurn: Number.isFinite(Number(entry.reopenedAtTurn)) ? Number(entry.reopenedAtTurn) : undefined,
      staleAtTurn: Number.isFinite(Number(entry.staleAtTurn)) ? Number(entry.staleAtTurn) : undefined,
      suppressedCount: Number.isFinite(Number(entry.suppressedCount)) ? Number(entry.suppressedCount) : 0,
      visibleCount: Number.isFinite(Number(entry.visibleCount)) ? Number(entry.visibleCount) : 0,
      evidencePointers: Array.isArray(entry.evidencePointers) ? entry.evidencePointers.map(String).slice(0, 16) : [],
    };
  }
  return {
    entries: normalizedEntries,
    lastEvidenceFingerprint: typeof record.lastEvidenceFingerprint === "string" ? record.lastEvidenceFingerprint : undefined,
  };
}

export function updateBoardRiskLifecycle(previous: BoardRiskLifecycleState | undefined, ledger: BoardLedger, risks: BoardRisk[]): BoardRiskLifecycleUpdate {
  const state = cloneState(previous);
  const turn = ledger.progress.turns;
  const currentEvidenceFingerprint = evidenceFingerprint(ledger);
  const currentRisks = new Map(risks.map((risk) => [riskFingerprint(risk), risk]));
  const visibleRisks: BoardRisk[] = [];
  const suppressedRiskIds: string[] = [];
  const reopenedRiskIds: string[] = [];
  const resolvedRiskIds: string[] = [];
  const staleRiskIds: string[] = [];
  const hasNewTerminalGreen = ledger.evidence.some((item) => item.status === "green" && item.terminal);

  for (const risk of risks) {
    const fingerprint = riskFingerprint(risk);
    const previousEntry = state.entries[fingerprint];
    const entry: BoardRiskLifecycleEntry = previousEntry ? { ...previousEntry, evidencePointers: [...previousEntry.evidencePointers] } : {
      fingerprint,
      type: risk.type,
      status: "open",
      suppressedCount: 0,
      visibleCount: 0,
      evidencePointers: [],
    };
    const sameEvidence = entry.lastEvidenceFingerprint === currentEvidenceFingerprint;
    const alreadyNotified = entry.lastNotifiedEvidenceFingerprint === currentEvidenceFingerprint;
    const seenBefore = Boolean(previousEntry);

    entry.type = risk.type;
    entry.fingerprint = fingerprint;
    entry.lastSeenTurn = turn;
    entry.lastEvidenceFingerprint = currentEvidenceFingerprint;
    entry.evidencePointers = [...risk.evidencePointers].sort();

    if (!seenBefore) {
      entry.firstSeenTurn = turn;
      entry.status = "open";
      entry.lastNotifiedTurn = turn;
      entry.lastNotifiedEvidenceFingerprint = currentEvidenceFingerprint;
      entry.cooldownUntilTurn = turn + 2;
      entry.visibleCount += 1;
      visibleRisks.push(risk);
    } else if (alreadyNotified) {
      entry.status = "accepted-until-new-evidence";
      entry.cooldownUntilTurn = Math.max(entry.cooldownUntilTurn ?? turn, turn + 2);
      entry.suppressedCount += 1;
      suppressedRiskIds.push(fingerprint);
    } else if (!sameEvidence) {
      if (previousEntry?.lastNotifiedEvidenceFingerprint) {
        entry.status = "reopened";
        entry.reopenedAtTurn = turn;
        reopenedRiskIds.push(fingerprint);
      } else {
        entry.status = "open";
      }
      entry.lastNotifiedTurn = turn;
      entry.lastNotifiedEvidenceFingerprint = currentEvidenceFingerprint;
      entry.cooldownUntilTurn = turn + 2;
      entry.visibleCount += 1;
      visibleRisks.push(risk);
    } else {
      entry.status = "open";
      entry.lastNotifiedTurn = turn;
      entry.lastNotifiedEvidenceFingerprint = currentEvidenceFingerprint;
      entry.cooldownUntilTurn = turn + 2;
      entry.visibleCount += 1;
      visibleRisks.push(risk);
    }

    state.entries[fingerprint] = entry;
  }

  for (const [fingerprint, entry] of Object.entries(state.entries)) {
    if (currentRisks.has(fingerprint)) continue;
    if (entry.status === "resolved" || entry.status === "dismissed") continue;
    if (hasNewTerminalGreen) {
      entry.status = "stale";
      entry.staleAtTurn = turn;
      staleRiskIds.push(fingerprint);
    } else {
      entry.status = "resolved";
      entry.resolvedAtTurn = turn;
      resolvedRiskIds.push(fingerprint);
    }
    entry.lastSeenTurn = turn;
    entry.lastEvidenceFingerprint = currentEvidenceFingerprint;
    entry.lastNotifiedEvidenceFingerprint = currentEvidenceFingerprint;
    entry.lastNotifiedTurn = turn;
    state.entries[fingerprint] = entry;
  }

  state.lastEvidenceFingerprint = currentEvidenceFingerprint;
  return {
    state,
    visibleRisks,
    suppressedRiskIds,
    reopenedRiskIds,
    resolvedRiskIds,
    staleRiskIds,
    evidenceFingerprint: currentEvidenceFingerprint,
  };
}
