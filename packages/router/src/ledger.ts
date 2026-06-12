import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decisionId } from "./decision.js";
import type { RouteDecision, RouterCheckpoint } from "./types.js";

export const ROUTE_EVENT_SCHEMA = "pi-router.route-event.v1" as const;

export interface RouteRuntimeFacts {
  activeModel?: string;
  provider?: string;
  contextTokensApprox: number | null;
  gitDirty: boolean | null;
}

export interface RouteEvent {
  schema: typeof ROUTE_EVENT_SCHEMA;
  eventId: string;
  recordedAt: string;
  checkpointId: string;
  sessionId: string;
  rawSessionRef: RouterCheckpoint["rawSessionRef"];
  sourceEvent: RouterCheckpoint["sourceEvent"];
  decision: RouteDecision;
  runtime: RouteRuntimeFacts;
  observed: {
    followed: boolean | null;
    overriddenBy?: string;
  };
  metrics: {
    loopScore: number;
    progressScore: number;
    sameCommandRepeatedCount: number;
    sameErrorRepeatedCount: number;
    verifierUsed: boolean;
  };
}

export function buildRouteEvent(checkpoint: RouterCheckpoint, decision: RouteDecision, recordedAt = new Date().toISOString()): RouteEvent {
  return {
    schema: ROUTE_EVENT_SCHEMA,
    eventId: decisionId(decision, checkpoint),
    recordedAt,
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    rawSessionRef: checkpoint.rawSessionRef,
    sourceEvent: checkpoint.sourceEvent,
    decision,
    runtime: {
      activeModel: checkpoint.activeModel,
      provider: checkpoint.provider,
      contextTokensApprox: checkpoint.features.contextTokensApprox,
      gitDirty: checkpoint.features.gitDirty,
    },
    observed: {
      followed: null,
    },
    metrics: {
      loopScore: checkpoint.features.loopScore,
      progressScore: checkpoint.features.progressScore,
      sameCommandRepeatedCount: checkpoint.features.sameCommandRepeatedCount,
      sameErrorRepeatedCount: checkpoint.features.sameErrorRepeatedCount,
      verifierUsed: checkpoint.features.verifierUsed,
    },
  };
}

export function appendRouteEvent(path: string, event: RouteEvent): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(event)}\n`, { flag: "a" });
}

export function readRouteEvents(path: string): RouteEvent[] {
  const resolved = resolve(path);
  try {
    return readFileSync(resolved, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RouteEvent];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
