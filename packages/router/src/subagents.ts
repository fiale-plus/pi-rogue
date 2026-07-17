import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashText } from "./hash.js";
import type {
  ContextPolicy,
  RouterCheckpoint,
  SubagentReturnContract,
  SubagentRole,
  SubagentToolPolicy,
} from "./types.js";

export const SUBAGENT_DECISION_SCHEMA = "pi-router.subagent-decision.v1" as const;
export const SUBAGENT_LEDGER_EVENT_SCHEMA = "pi-router.subagent-ledger-event.v1" as const;
export const EVIDENCE_SUMMARY_SCHEMA = "pi-router.evidence-summary.v1" as const;
export type SubagentOutcome = "success" | "timeout" | "failure" | "abandoned" | "partial";

export interface EvidenceSummaryItem {
  kind: "file" | "command" | "session" | "manual";
  ref: string;
  reason: string;
  outputFingerprint?: string;
}

export interface EvidenceSummaryContract {
  schema: typeof EVIDENCE_SUMMARY_SCHEMA;
  status: "success" | "partial" | "failed";
  confidence: number;
  recommendedNextAction: string;
  evidence: EvidenceSummaryItem[];
  findings: string[];
  risks: string[];
  minimalPayloadForParent: string;
  rawTraceRef?: {
    childSessionId?: string;
    path?: string;
    fromEvent?: number;
    toEvent?: number;
  };
}

export interface SubagentRouteDecision {
  schema: typeof SUBAGENT_DECISION_SCHEMA;
  parentCheckpointId: string;
  action: "spawn_subagent";
  subagentRole: SubagentRole;
  targetModel: string;
  toolPolicy: SubagentToolPolicy;
  contextPolicy: ContextPolicy | "goal_only" | "focused_files" | "repo_card_plus_goal";
  returnContract: SubagentReturnContract;
  maxSteps: number;
  maxTokens: number | null;
  confidence: number;
  reason: string;
}

export interface SubagentLedgerEvent {
  schema: typeof SUBAGENT_LEDGER_EVENT_SCHEMA;
  eventId: string;
  recordedAt: string;
  parentSessionId: string;
  childSessionId: string;
  parentCheckpointId: string;
  subagentRole: SubagentRole;
  model: string;
  toolPolicy: SubagentToolPolicy;
  contextPolicy: SubagentRouteDecision["contextPolicy"];
  inputSummaryHash: string;
  outputSummaryHash: string;
  acceptedIntoParent: boolean | null;
  useful: boolean | null;
  causedRework: boolean | null;
  returnContract: SubagentReturnContract;
  /** Optional lifecycle metadata for execution-worker telemetry. */
  phase?: "request" | "result";
  outcome?: SubagentOutcome | null;
  elapsedMs?: number | null;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

export function recommendSubagentDecision(
  checkpoint: RouterCheckpoint,
  profile: Partial<Record<SubagentRole | "worker" | "smart" | "reviewer", string>>,
): SubagentRouteDecision | null {
  if (checkpoint.phase === "research" || (checkpoint.phase === "unknown" && checkpoint.features.toolCallsLast10Turns === 0)) {
    return buildSubagentDecision(checkpoint, {
      subagentRole: "explore",
      targetModel: profile.explore ?? profile.worker ?? "unknown",
      toolPolicy: "read_only",
      contextPolicy: "goal_only",
      confidence: 0.68,
      reason: "repo area or question appears exploratory; a read-only fresh-context scout can reduce main-context pollution",
    });
  }
  if (checkpoint.phase === "debug" && checkpoint.features.sameErrorRepeatedCount >= 2) {
    return buildSubagentDecision(checkpoint, {
      subagentRole: "debug_diagnose",
      targetModel: profile.debug_diagnose ?? profile.smart ?? "unknown",
      toolPolicy: "read_only",
      contextPolicy: "focused_error_and_diff",
      confidence: clampConfidence(0.72 + Math.min(checkpoint.features.sameErrorRepeatedCount, 4) * 0.04),
      reason: "repeated failure fingerprint; ask a focused diagnostic subagent for evidence-backed root cause",
    });
  }
  if (checkpoint.phase === "review" && checkpoint.features.diffLines >= 250) {
    return buildSubagentDecision(checkpoint, {
      subagentRole: "review",
      targetModel: profile.review ?? profile.reviewer ?? profile.smart ?? "unknown",
      toolPolicy: "read_only",
      contextPolicy: "diff_only",
      confidence: 0.74,
      reason: "large review diff; spawn read-only reviewer with diff-only context and evidence contract",
    });
  }
  if (checkpoint.features.noVerifierUsed) {
    return buildSubagentDecision(checkpoint, {
      subagentRole: "verify",
      targetModel: profile.verify ?? profile.worker ?? "unknown",
      toolPolicy: "test_only",
      contextPolicy: "focused_files",
      confidence: 0.7,
      reason: "implementation/debug work changed files without verifier; run bounded verification outside main context",
    });
  }
  return null;
}

export function buildSubagentDecision(
  checkpoint: RouterCheckpoint,
  options: Omit<SubagentRouteDecision, "schema" | "parentCheckpointId" | "action" | "returnContract" | "maxSteps" | "maxTokens"> & Partial<Pick<SubagentRouteDecision, "maxSteps" | "maxTokens" | "returnContract">>,
): SubagentRouteDecision {
  return {
    schema: SUBAGENT_DECISION_SCHEMA,
    parentCheckpointId: checkpoint.checkpointId,
    action: "spawn_subagent",
    subagentRole: options.subagentRole,
    targetModel: options.targetModel,
    toolPolicy: options.toolPolicy,
    contextPolicy: options.contextPolicy,
    returnContract: options.returnContract ?? "evidence_summary_v1",
    maxSteps: options.maxSteps ?? 8,
    maxTokens: options.maxTokens ?? null,
    confidence: clampConfidence(options.confidence),
    reason: options.reason,
  };
}

export function buildSubagentLedgerEvent(options: Omit<SubagentLedgerEvent, "schema" | "eventId" | "recordedAt"> & { recordedAt?: string }): SubagentLedgerEvent {
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  return {
    schema: SUBAGENT_LEDGER_EVENT_SCHEMA,
    eventId: hashText("subagent", options.parentSessionId, options.childSessionId, options.parentCheckpointId, options.subagentRole, options.outputSummaryHash),
    recordedAt,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    parentCheckpointId: options.parentCheckpointId,
    subagentRole: options.subagentRole,
    model: options.model,
    toolPolicy: options.toolPolicy,
    contextPolicy: options.contextPolicy,
    inputSummaryHash: options.inputSummaryHash,
    outputSummaryHash: options.outputSummaryHash,
    acceptedIntoParent: options.acceptedIntoParent,
    useful: options.useful,
    causedRework: options.causedRework,
    returnContract: options.returnContract,
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...(options.elapsedMs !== undefined ? { elapsedMs: options.elapsedMs } : {}),
  };
}

export function appendSubagentLedgerEvent(path: string, event: SubagentLedgerEvent): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function readSubagentLedgerEvents(path: string): SubagentLedgerEvent[] {
  return readFileSync(resolve(path), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SubagentLedgerEvent);
}
