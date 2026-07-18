import { randomUUID } from "node:crypto";
import {
  appendSubagentLedgerEvent,
  buildSubagentLedgerEvent,
  hashText,
  type SubagentLedgerEvent,
  type SubagentOutcome,
  type SubagentReturnContract,
  type SubagentRole,
  type SubagentToolPolicy,
  type ContextPolicy,
} from "@fiale-plus/pi-rogue-router";

export const WORKER_TELEMETRY_SCHEMA = "pi-router.subagent-ledger-event.v1" as const;
export type WorkerOutcome = SubagentOutcome;
export type WorkerTelemetryEvent = SubagentLedgerEvent;

type PendingRequest = {
  parentSessionId: string;
  parentCheckpointId: string;
  childSessionId: string;
  model: string;
  inputSummaryHash: string;
  subagentRole: SubagentRole;
  toolPolicy: SubagentToolPolicy;
  contextPolicy: ContextPolicy | "goal_only" | "focused_files" | "repo_card_plus_goal";
  returnContract: SubagentReturnContract;
};

const pendingRequests = new Map<string, PendingRequest>();

export function classifyWorkerOutcome(options: {
  timedOut?: boolean;
  hasError?: boolean;
  exitCode?: number | null;
  abandoned?: boolean;
  hasOutput?: boolean;
  isPartial?: boolean;
}): WorkerOutcome | null {
  if (options.timedOut === true) return "timeout";
  if (options.hasError === true || (options.exitCode !== null && options.exitCode !== undefined && options.exitCode !== 0)) return "failure";
  if (options.abandoned === true) return "abandoned";
  if (options.hasOutput === true && options.isPartial === true) return "partial";
  if (options.hasOutput === true) return "success";
  return null;
}

function summaryHash(kind: string, value: string): string {
  return hashText(kind, value);
}

export function clearWorkerRequestTracking(): void {
  pendingRequests.clear();
}

export function recordWorkerRequest(options: {
  parentSessionId: string;
  childSessionId?: string;
  parentCheckpointId?: string;
  ledgerPath: string;
  model: string;
  inputSummary: string;
  subagentRole?: SubagentRole;
  toolPolicy?: SubagentToolPolicy;
  contextPolicy?: PendingRequest["contextPolicy"];
  returnContract?: SubagentReturnContract;
  recordedAt?: string;
}): WorkerTelemetryEvent {
  const childSessionId = options.childSessionId ?? randomUUID();
  const parentCheckpointId = options.parentCheckpointId ?? `worker:${childSessionId}`;
  const subagentRole = options.subagentRole ?? "implement";
  const toolPolicy = options.toolPolicy ?? "edit_in_worktree";
  const contextPolicy = options.contextPolicy ?? "focused_files";
  const returnContract = options.returnContract ?? "evidence_summary_v1";
  const event = buildSubagentLedgerEvent({
    parentSessionId: options.parentSessionId,
    childSessionId,
    parentCheckpointId,
    subagentRole,
    model: options.model,
    toolPolicy,
    contextPolicy,
    inputSummaryHash: summaryHash("worker-request", options.inputSummary),
    outputSummaryHash: summaryHash("worker-pending", childSessionId),
    acceptedIntoParent: null,
    useful: null,
    causedRework: null,
    returnContract,
    phase: "request",
    outcome: null,
    elapsedMs: null,
    recordedAt: options.recordedAt,
  });
  appendSubagentLedgerEvent(options.ledgerPath, event);
  pendingRequests.set(childSessionId, {
    parentSessionId: options.parentSessionId,
    parentCheckpointId,
    childSessionId,
    model: options.model,
    inputSummaryHash: event.inputSummaryHash,
    subagentRole,
    toolPolicy,
    contextPolicy,
    returnContract,
  });
  return event;
}

export function recordWorkerResult(options: {
  childSessionId: string;
  ledgerPath: string;
  outputSummary?: string;
  elapsedMs?: number | null;
  outcome?: WorkerOutcome | null;
  acceptedIntoParent?: boolean | null;
  useful?: boolean | null;
  causedRework?: boolean | null;
  recordedAt?: string;
}): WorkerTelemetryEvent {
  const pending = pendingRequests.get(options.childSessionId);
  if (!pending) throw new Error(`No pending worker request for child session '${options.childSessionId}'.`);
  pendingRequests.delete(options.childSessionId);
  const event = buildSubagentLedgerEvent({
    parentSessionId: pending.parentSessionId,
    childSessionId: pending.childSessionId,
    parentCheckpointId: pending.parentCheckpointId,
    subagentRole: pending.subagentRole,
    model: pending.model,
    toolPolicy: pending.toolPolicy,
    contextPolicy: pending.contextPolicy,
    inputSummaryHash: pending.inputSummaryHash,
    outputSummaryHash: summaryHash("worker-result", options.outputSummary ?? ""),
    acceptedIntoParent: options.acceptedIntoParent ?? null,
    useful: options.useful ?? null,
    causedRework: options.causedRework ?? null,
    returnContract: pending.returnContract,
    phase: "result",
    outcome: options.outcome ?? null,
    elapsedMs: options.elapsedMs ?? null,
    recordedAt: options.recordedAt,
  });
  appendSubagentLedgerEvent(options.ledgerPath, event);
  return event;
}
