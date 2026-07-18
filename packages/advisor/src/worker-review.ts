/**
 * Worker output-review helper for Issue #356.
 *
 * Converts a completed worker result into a BoardEvent `subagent_return`,
 * runs buildBoardLedger/detectBoardRisks/decideBoardAction, and returns
 * the read-only decision plus risks.
 *
 * This helper is strictly read-only: it never dispatches, steers, mutates
 * policy, or calls a model.
 */

import {
  buildBoardLedger,
  decideBoardAction,
  detectBoardRisks,
  type BoardDecision,
  type BoardEvent,
  type BoardLedger,
  type BoardRisk,
  type SubagentReturnSummary,
} from "./board.js";

/** Input shape expected by the worker-review helper. */
export interface WorkerReviewInput {
  /** Unique worker/session id. */
  id: string;
  /** Worker role name (e.g. "local-worker-poc", "reviewer"). */
  role: string;
  /** Optional topic label for contradiction detection. */
  topic?: string;
  /** Worker verdict: green (done/correct), red (failed), or unknown (unclear). */
  verdict: "green" | "red" | "unknown";
  /** Human-readable summary of what the worker did. */
  summary: string;
  /** Optional confidence score [0..1]. */
  confidence?: number;
  /** Optional turn number. */
  turn?: number;
  /** Optional timestamp (ISO string). */
  timestamp?: string;
  /** Optional parent session metadata for the ledger. */
  sessionId?: string;
  /** Optional repo metadata for the ledger. */
  repo?: string;
}

/** Read-only result from reviewing a worker return. */
export interface WorkerReviewResult {
  /** The board event emitted for this worker return. */
  event: BoardEvent & { type: "subagent_return" };
  /** The full board ledger built from the event (with empty risks if no prior events). */
  ledger: BoardLedger;
  /** The read-only decision derived from the ledger. */
  decision: BoardDecision;
  /** Detected risks (may be empty for clean green returns). */
  risks: BoardRisk[];
  /** The subagent summary stored in the ledger. */
  subagentSummary: SubagentReturnSummary;
}

/**
 * Review a single completed worker result.
 *
 * 1. Converts the input into a `subagent_return` BoardEvent.
 * 2. Builds a ledger from that single event (plus optional session metadata).
 * 3. Runs detectBoardRisks and decideBoardAction.
 * 4. Returns the read-only decision plus risks.
 *
 * This function is pure and side-effect-free. It never calls models,
 * dispatches workers, steers execution, or mutates any policy.
 */
export function reviewWorkerResult(input: WorkerReviewInput): WorkerReviewResult {
  const event: BoardEvent & { type: "subagent_return" } = {
    type: "subagent_return",
    id: input.id,
    role: input.role,
    topic: input.topic,
    verdict: input.verdict,
    summary: input.summary,
    confidence: input.confidence,
    turn: input.turn,
    timestamp: input.timestamp,
  };

  const events: BoardEvent[] = [];

  // Include session metadata if provided
  if (input.sessionId || input.repo) {
    events.push({
      type: "session",
      id: input.sessionId ?? "session",
      repo: input.repo,
    });
  }

  // Include the subagent_return event
  events.push(event);

  // Build the ledger from events
  const ledger = buildBoardLedger(events);

  // Run risk detection (already called by buildBoardLedger, but explicit for clarity)
  const risks = detectBoardRisks(ledger);

  // Derive the decision
  const decision = decideBoardAction({ ...ledger, risks });

  // Build the subagent summary
  const subagentSummary: SubagentReturnSummary = {
    id: input.id,
    role: input.role,
    topic: input.topic,
    verdict: input.verdict,
    summary: input.summary,
    confidence: input.confidence,
    turn: input.turn,
  };

  return { event, ledger, decision, risks, subagentSummary };
}

/**
 * Review a completed worker result and return only the decision and risks.
 *
 * This is a convenience wrapper around reviewWorkerResult that returns
 * a minimal shape suitable for quick decision-making without the full
 * ledger.
 */
export function reviewWorkerResultBrief(input: WorkerReviewInput): {
  decision: BoardDecision;
  risks: BoardRisk[];
} {
  const result = reviewWorkerResult(input);
  return {
    decision: result.decision,
    risks: result.risks,
  };
}
