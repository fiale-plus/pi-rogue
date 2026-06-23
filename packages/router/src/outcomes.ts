import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashText } from "./hash.js";
import { readCheckpointJsonl } from "./decision.js";
import { readRouteEvents, type RouteEvent } from "./ledger.js";
import type { RouterCheckpoint, TaskStatus, TaskType } from "./types.js";

export const ROUTER_OUTCOME_SCHEMA = "pi-router.outcome.v1" as const;
export const ROUTER_OUTCOME_ENRICH_SUMMARY_SCHEMA = "pi-router.outcome-enrich-summary.v1" as const;

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
  routeStatus?: RouteEvent["observed"]["routingStatus"];
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
    blockedBy?: "policy" | "infra_auth";
  };
  }

export interface OutcomeWriteSummary {
  schema: "pi-router.outcomes-summary.v1";
  output: string;
  outcomes: number;
  inferred: number;
}

export interface OutcomeEnrichSummary {
  schema: typeof ROUTER_OUTCOME_ENRICH_SUMMARY_SCHEMA;
  output: string;
  inputOutcomes: number;
  outputOutcomes: number;
  enriched: number;
}

function roundStatus(_event: RouteEvent, _checkpoint?: RouterCheckpoint): TaskStatus {
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
    userInterrupted: false,
    userOverrodeDecision: Boolean(event.observed.overriddenBy),
    routeStatus: event.observed.routingStatus,
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
      blockedBy: event.observed.blockedBy,
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
    .map((line, index) => {
      try {
        const outcome = JSON.parse(line) as RouterOutcome;
        if (outcome.schema !== ROUTER_OUTCOME_SCHEMA) throw new Error("invalid schema");
        return outcome;
      } catch (error) {
        throw new Error(`invalid outcome JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function writeOutcomesJsonl(outcomes: RouterOutcome[], path: string): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, outcomes.map((outcome) => JSON.stringify(outcome)).join("\n") + (outcomes.length ? "\n" : ""));
}

function routeEventForOutcome(outcome: RouterOutcome, byId: Map<string, RouteEvent>, byCheckpoint: Map<string, RouteEvent>): RouteEvent | undefined {
  return (outcome.routeEventId ? byId.get(outcome.routeEventId) : undefined) ?? (outcome.checkpointId ? byCheckpoint.get(outcome.checkpointId) : undefined);
}

function checkpointForOutcome(outcome: RouterOutcome, event: RouteEvent | undefined, byCheckpoint: Map<string, RouterCheckpoint>): RouterCheckpoint | undefined {
  return (outcome.checkpointId ? byCheckpoint.get(outcome.checkpointId) : undefined) ?? (event ? byCheckpoint.get(event.checkpointId) : undefined);
}

function inferredStatus(outcome: RouterOutcome, checkpoint?: RouterCheckpoint, event?: RouteEvent, testsPassed: boolean | null = outcome.testsPassedAfter): TaskStatus {
  const stopWasFollowed = event?.decision.action === "stop_and_ask_user" && event.observed.followed === true && !event.observed.overriddenBy;
  if (stopWasFollowed || outcome.userInterrupted) return outcome.taskStatus === "unknown" ? "abandoned" : outcome.taskStatus;
  if (testsPassed === true && Math.max(outcome.finalDiffLines, checkpoint?.features.diffLines ?? 0, event?.metrics.diffLines ?? 0) > 0) return "success";
  if (testsPassed === true && outcome.taskStatus === "unknown") return "partial";
  if (testsPassed === false && outcome.taskStatus === "unknown") return "failed";
  if (outcome.taskStatus === "partial" && testsPassed === true && Math.max(outcome.finalDiffLines, checkpoint?.features.diffLines ?? 0, event?.metrics.diffLines ?? 0) > 0) return "success";
  return outcome.taskStatus;
}

export function enrichOutcome(outcome: RouterOutcome, options: { checkpoint?: RouterCheckpoint; event?: RouteEvent; recordedAt?: string } = {}): RouterOutcome {
  const checkpoint = options.checkpoint;
  const event = options.event;
  const testsPassedAfter = outcome.testsPassedAfter;
  const verifierImproved = outcome.verifierImproved
    ?? (checkpoint?.features.testsImproved !== null && checkpoint?.features.testsImproved !== undefined ? checkpoint.features.testsImproved : null);
  const taskStatus = inferredStatus(outcome, checkpoint, event, testsPassedAfter);
  const evidenceDiffLines = checkpoint?.features.diffLines ?? event?.metrics.diffLines ?? 0;
  const evidenceFilesTouched = checkpoint
    ? ((checkpoint.features.diffFilesChanged ?? 0) > 0 ? checkpoint.features.diffFilesChanged : checkpoint.features.filesTouched)
    : event?.metrics.diffFilesChanged ?? 0;
  const evidenceErrorRepeats = checkpoint?.features.sameErrorRepeatedCount ?? event?.metrics.sameErrorRepeatedCount ?? 0;
  const finalDiffLines = Math.max(outcome.finalDiffLines, evidenceDiffLines);
  const finalFilesTouched = Math.max(outcome.finalFilesTouched, evidenceFilesTouched);
  const reworkTurns = Math.max(outcome.reworkTurns, evidenceErrorRepeats > 1 ? evidenceErrorRepeats - 1 : 0);
  const acceptedDiff = outcome.acceptedDiff
    ?? (finalDiffLines > 0 && testsPassedAfter === true ? true : testsPassedAfter === false || taskStatus === "abandoned" ? false : null);
  const notes = JSON.stringify({ enrichedFromCheckpoint: checkpoint?.checkpointId, routeEventId: event?.eventId, taskStatus, testsPassedAfter, verifierImproved, acceptedDiff });

  return {
    ...outcome,
    recordedAt: options.recordedAt ?? outcome.recordedAt,
    checkpointId: outcome.checkpointId ?? event?.checkpointId,
    routeEventId: outcome.routeEventId ?? event?.eventId,
    taskType: outcome.taskType === "unknown" ? taskTypeFromCheckpoint(checkpoint) : outcome.taskType,
    taskStatus,
    testsPassedAfter,
    verifierImproved,
    acceptedDiff,
    userInterrupted: outcome.userInterrupted || Boolean(event?.decision.action === "stop_and_ask_user" && event.observed.followed === true && !event.observed.overriddenBy),
    userOverrodeDecision: outcome.userOverrodeDecision || Boolean(event?.observed.overriddenBy),
    routeStatus: outcome.routeStatus ?? event?.observed.routingStatus,
    finalFilesTouched,
    finalDiffLines,
    reworkTurns,
    evidence: {
      ...outcome.evidence,
      rawSessionRef: outcome.evidence.rawSessionRef ?? checkpoint?.rawSessionRef ?? event?.rawSessionRef,
      routeEventId: outcome.evidence.routeEventId ?? event?.eventId,
      notesHash: outcome.evidence.notesHash ?? hashText(notes),
      blockedBy: outcome.evidence.blockedBy ?? event?.observed.blockedBy,
    },
  };
}

function validateOutcomeLinks(outcomes: RouterOutcome[], checkpoints: RouterCheckpoint[], events: RouteEvent[]): void {
  const checkpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.checkpointId));
  const eventIds = new Set(events.map((event) => event.eventId));
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const eventCheckpointIds = new Set(events.map((event) => event.checkpointId));
  for (const outcome of outcomes) {
    if (events.length > 0 && outcome.routeEventId && !eventIds.has(outcome.routeEventId)) throw new Error(`outcome routeEventId not found: ${outcome.routeEventId}`);
    if (outcome.routeEventId && outcome.checkpointId) {
      const event = eventById.get(outcome.routeEventId);
      if (event && event.checkpointId !== outcome.checkpointId) throw new Error(`outcome routeEventId/checkpointId mismatch: ${outcome.routeEventId}`);
    }
    if ((checkpoints.length > 0 || events.length > 0) && outcome.checkpointId && !checkpointIds.has(outcome.checkpointId) && !eventCheckpointIds.has(outcome.checkpointId)) throw new Error(`outcome checkpointId not found: ${outcome.checkpointId}`);
  }
}

export function enrichOutcomes(outcomes: RouterOutcome[], checkpoints: RouterCheckpoint[] = [], events: RouteEvent[] = [], recordedAt?: string): RouterOutcome[] {
  validateOutcomeLinks(outcomes, checkpoints, events);
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const eventByCheckpoint = new Map(events.map((event) => [event.checkpointId, event]));
  return outcomes.map((outcome) => {
    const event = routeEventForOutcome(outcome, eventById, eventByCheckpoint);
    const checkpoint = checkpointForOutcome(outcome, event, checkpointById);
    return enrichOutcome(outcome, { checkpoint, event, recordedAt });
  });
}

export function writeInferredOutcomes(options: { checkpointPath: string; eventsPath: string; outputPath: string }): OutcomeWriteSummary {
  if (!existsSync(resolve(options.eventsPath))) throw new Error(`required route events file not found: ${options.eventsPath}`);
  const checkpoints = readCheckpointJsonl(options.checkpointPath);
  const events = readRouteEvents(options.eventsPath);
  const outcomes = inferOutcomes(events, checkpoints);
  writeOutcomesJsonl(outcomes, options.outputPath);
  return { schema: "pi-router.outcomes-summary.v1", output: resolve(options.outputPath), outcomes: outcomes.length, inferred: outcomes.length };
}

export function writeEnrichedOutcomes(options: { outcomesPath: string; outputPath: string; checkpointPath?: string; eventsPath?: string }): OutcomeEnrichSummary {
  if (!options.checkpointPath && !options.eventsPath) throw new Error("outcome enrichment requires --checkpoint-file or --events evidence");
  if (options.eventsPath && !existsSync(resolve(options.eventsPath))) throw new Error(`route events file not found: ${options.eventsPath}`);
  if (options.checkpointPath && !existsSync(resolve(options.checkpointPath))) throw new Error(`checkpoint file not found: ${options.checkpointPath}`);
  const input = readOutcomes(options.outcomesPath);
  const checkpoints = options.checkpointPath ? readCheckpointJsonl(options.checkpointPath) : [];
  const events = options.eventsPath ? readRouteEvents(options.eventsPath) : [];
  if (checkpoints.length === 0 && events.length === 0) {
    if (options.checkpointPath && !options.eventsPath) throw new Error(`checkpoint file contains no checkpoints: ${options.checkpointPath}`);
    if (options.eventsPath && !options.checkpointPath) throw new Error(`route events file contains no events: ${options.eventsPath}`);
    throw new Error("outcome enrichment evidence files contain no usable checkpoint or route events");
  }
  const enriched = enrichOutcomes(input, checkpoints, events);
  writeOutcomesJsonl(enriched, options.outputPath);
  return {
    schema: ROUTER_OUTCOME_ENRICH_SUMMARY_SCHEMA,
    output: resolve(options.outputPath),
    inputOutcomes: input.length,
    outputOutcomes: enriched.length,
    enriched: enriched.filter((outcome, index) => JSON.stringify(outcome) !== JSON.stringify(input[index])).length,
  };
}
