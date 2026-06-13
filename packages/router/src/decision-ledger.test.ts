import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideRoute, readCheckpointJsonl, selectCheckpoint } from "./decision.js";
import { appendRouteEvent, buildRouteEvent, readRouteEvents } from "./ledger.js";
import type { RouterCheckpoint } from "./types.js";

type CheckpointOverrides = Partial<Omit<RouterCheckpoint, "features" | "recent">> & {
  features?: Partial<RouterCheckpoint["features"]>;
  recent?: Partial<RouterCheckpoint["recent"]>;
};

function checkpoint(overrides: CheckpointOverrides = {}): RouterCheckpoint {
  const base: RouterCheckpoint = {
    schema: "pi-router.checkpoint.v1",
    sessionId: "session-1",
    checkpointId: "session-1:event-10",
    createdAt: "2026-06-12T00:00:00.000Z",
    rawSessionRef: {
      schema: "pi-router.raw-session-ref.v1",
      path: "/tmp/raw-session.jsonl",
      fromEvent: 1,
      toEvent: 10,
      fromByte: 100,
      toByte: 200,
      contentHash: "hash-only",
    },
    harness: "pi",
    repoHash: "repo-hash",
    goalHash: "goal-hash",
    phase: "debug",
    activeModel: "local/qwen",
    provider: "local",
    features: {
      turnIndex: 10,
      sameCommandRepeatedCount: 2,
      sameErrorRepeatedCount: 2,
      errorChanged: false,
      testsImproved: null,
      filesTouched: 1,
      diffLines: 12,
      diffFilesChanged: 1,
      diffLinesAdded: 8,
      diffLinesDeleted: 4,
      diffChurnScore: 0,
      toolThrashScore: 0.25,
      goalDriftScore: 0,
      loopScore: 0.55,
      progressScore: 0.45,
      verifierUsed: true,
      noVerifierUsed: false,
      toolCallsLast10Turns: 4,
      contextTokensApprox: 1234,
      gitDirty: null,
    },
    recent: {
      lastUserGoalHash: "goal-hash",
      lastCommandHash: "command-hash",
      lastErrorHash: "error-hash",
      touchedFileHashes: ["file-hash"],
    },
    sourceEvent: {
      index: 10,
      byteStart: 100,
      byteEnd: 200,
      id: "event-id",
      timestamp: "2026-06-12T00:00:01.000Z",
      type: "message",
      role: "toolResult",
    },
  };
  return { ...base, ...overrides, features: { ...base.features, ...overrides.features }, recent: { ...base.recent, ...overrides.recent } };
}

describe("trajectory router decision and ledger", () => {
  it("emits strict JSON decisions from conservative local-first rules", () => {
    const decision = decideRoute(checkpoint());

    expect(decision).toEqual({
      schema: "pi-router.decision.v1",
      checkpointId: "session-1:event-10",
      action: "escalate_debug_diagnosis",
      adviceShape: "debug_diagnosis",
      contextPolicy: "focused_error_and_diff",
      confidence: 0.82,
      reason: "same error repeated in debug phase; ask stronger/different model for diagnosis",
      policyVersion: "pi-router.rule-policy.v0",
    });
  });

  it("keeps normal progress local/current", () => {
    const decision = decideRoute(checkpoint({
      phase: "implementation",
      features: {
        sameCommandRepeatedCount: 1,
        sameErrorRepeatedCount: 0,
        loopScore: 0.1,
        progressScore: 0.8,
      },
    }));

    expect(decision.action).toBe("continue_current");
    expect(decision.adviceShape).toBe("none");
    expect(decision.contextPolicy).toBe("none");
  });

  it("selects the last checkpoint by default or an explicit checkpoint id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-router-decision-"));
    const file = join(dir, "checkpoints.jsonl");
    const first = checkpoint({ checkpointId: "first" });
    const second = checkpoint({ checkpointId: "second" });
    writeFileSync(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const checkpoints = readCheckpointJsonl(file);

    expect(selectCheckpoint(checkpoints).checkpointId).toBe("second");
    expect(selectCheckpoint(checkpoints, "first").checkpointId).toBe("first");
    expect(() => selectCheckpoint(checkpoints, "missing")).toThrow(/checkpoint not found/);
  });

  it("appends route ledger events without raw transcript content", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-router-ledger-"));
    const file = join(dir, "events.jsonl");
    const sensitiveText = "npm test src/secret.test.ts failed with API_TOKEN=abc";
    const routeCheckpoint = checkpoint();
    const decision = decideRoute(routeCheckpoint);
    const event = buildRouteEvent(routeCheckpoint, decision, "2026-06-12T00:00:02.000Z");

    appendRouteEvent(file, event);
    const events = readRouteEvents(file);
    const raw = readFileSync(file, "utf8");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema: "pi-router.route-event.v1",
      checkpointId: routeCheckpoint.checkpointId,
      sessionId: routeCheckpoint.sessionId,
      decision,
      runtime: { activeModel: "local/qwen", provider: "local", contextTokensApprox: 1234 },
      observed: { followed: null },
    });
    expect(raw).not.toContain(sensitiveText);
    expect(raw).not.toContain("npm test");
    expect(raw).not.toContain("API_TOKEN");
    expect(raw).toContain("hash-only");
  });
});
