import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashText } from "./hash.js";
import { readCheckpointJsonl } from "./decision.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import type { RouterCheckpoint, TaskStatus, TaskType } from "./types.js";

export const ROUTER_OUTCOME_SCHEMA = "pi-router.outcome.v1" as const;

export interface RouterOutcome {
  schema: typeof ROUTER_OUTCOME_SCHEMA;
  outcomeId: string;
  recordedAt: string;
  sessionId: string;
  checkpointId?: string;
  routeEventId?: string;
  taskType: TaskType;
  taskStatus: TaskStatus;
  testsPassedAfter: boolean | null;
  verifierImproved: boolean | null;
  acceptedDiff: boolean | null;
  userInterrupted: boolean;
  userOverrodeDecision: boolean;
  finalFilesTouched: number;
  finalDiffLines: number;
  wallTimeMs: number | null;
  cloudCostUsd: number | null;
  frontierCalls: number;
  localTurns: number;
  reworkTurns: number;
  evidence: {
    source: "inferred" | "manual";
    rawSessionRef?: RouterCheckpoint["rawSessionRef"];
    routeEventId?: string;
    notesHash?: string;
  };
}

export interface OutcomeWriteSummary {
  schema: "pi-router.outcomes-summary.v1";
  output: string;
  outcomes: number;
  inferred: number;
}

function roundStatus(event: RouteEvent, checkpoint?: RouterCheckpoint): TaskStatus {
  if (event.decision.action === "stop_and_ask_user") return "unknown";
  if (checkpoint?.features.verifierUsed && checkpoint.features.progressScore >= 0.75) return "partial";
  return "unknown";
}

function taskTypeFromCheckpoint(checkpoint?: RouterCheckpoint): TaskType {
  const phase = checkpoint?.phase ?? "unknown";
  return phase === "implementation" || phase === "debug" || phase === "review" || phase === "research" || phase === "ops" || phase === "planning"
    ? phase
    : "unknown";
}

function isFrontierModel(model?: string): boolean {
  return Boolean(model && /(gpt-5|gpt-4|claude|gemini|opus|sonnet)/i.test(model));
}

function isLocalModel(model?: string): boolean {
  return Boolean(model && /(qwen|llama|mlx|ollama|local)/i.test(model));
}

export function buildUnknownOutcome(event: RouteEvent, checkpoint?: RouterCheckpoint, recordedAt = new Date().toISOString()): RouterOutcome {
  const model = event.runtime.activeModel;
  return {
    schema: ROUTER_OUTCOME_SCHEMA,
    outcomeId: hashText("outcome", event.eventId, checkpoint?.rawSessionRef.contentHash ?? event.rawSessionRef.contentHash),
    recordedAt,
    sessionId: event.sessionId,
    checkpointId: event.checkpointId,
    routeEventId: event.eventId,
    taskType: taskTypeFromCheckpoint(checkpoint),
    taskStatus: roundStatus(event, checkpoint),
    testsPassedAfter: null,
    verifierImproved: null,
    acceptedDiff: null,
    userInterrupted: event.decision.action === "stop_and_ask_user",
    userOverrodeDecision: Boolean(event.observed.overriddenBy),
    finalFilesTouched: checkpoint ? ((checkpoint.features.diffFilesChanged ?? 0) > 0 ? (checkpoint.features.diffFilesChanged ?? 0) : checkpoint.features.filesTouched) : 0,
    finalDiffLines: checkpoint?.features.diffLines ?? 0,
    wallTimeMs: null,
    cloudCostUsd: null,
    frontierCalls: isFrontierModel(model) ? 1 : 0,
    localTurns: isLocalModel(model) ? 1 : 0,
    reworkTurns: checkpoint?.features.sameErrorRepeatedCount && checkpoint.features.sameErrorRepeatedCount > 1 ? checkpoint.features.sameErrorRepeatedCount - 1 : 0,
    evidence: {
      source: "inferred",
      rawSessionRef: checkpoint?.rawSessionRef ?? event.rawSessionRef,
      routeEventId: event.eventId,
    },
  };
}

export function inferOutcomes(events: RouteEvent[], checkpoints: RouterCheckpoint[], recordedAt = new Date().toISOString()): RouterOutcome[] {
  const byCheckpoint = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
  return events.map((event) => buildUnknownOutcome(event, byCheckpoint.get(event.checkpointId), recordedAt));
}

export function readOutcomes(path?: string): RouterOutcome[] {
  if (!path) return [];
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`outcomes file not found: ${path}`);
  return readFileSync(resolved, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try { return [JSON.parse(line) as RouterOutcome]; } catch { return []; }
    });
}

export function writeOutcomesJsonl(outcomes: RouterOutcome[], path: string): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, outcomes.map((outcome) => JSON.stringify(outcome)).join("\n") + (outcomes.length ? "\n" : ""));
}

export function writeInferredOutcomes(options: { checkpointPath: string; eventsPath: string; outputPath: string }): OutcomeWriteSummary {
  if (!existsSync(resolve(options.eventsPath))) throw new Error(`required route events file not found: ${options.eventsPath}`);
  const checkpoints = readCheckpointJsonl(options.checkpointPath);
  const events = readRouteEvents(options.eventsPath);
  const outcomes = inferOutcomes(events, checkpoints);
  writeOutcomesJsonl(outcomes, options.outputPath);
  return { schema: "pi-router.outcomes-summary.v1", output: resolve(options.outputPath), outcomes: outcomes.length, inferred: outcomes.length };
}
