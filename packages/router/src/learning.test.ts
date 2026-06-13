import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideRoute } from "./decision.js";
import { buildRouteEvent } from "./ledger.js";
import {
  generateCapabilityCards,
  generateTeacherReflection,
  shadowEvaluate,
  writeCapabilityCards,
  writeShadowEval,
  writeTeacherReflection,
} from "./learning.js";
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
      contextTokensApprox: 1000,
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

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-learning-")), name);
}

describe("trajectory router local learning and eval", () => {
  it("generates local observed capability cards from route events", () => {
    const first = checkpoint();
    const second = checkpoint({
      checkpointId: "session-1:event-11",
      phase: "implementation",
      features: { sameCommandRepeatedCount: 1, sameErrorRepeatedCount: 0, loopScore: 0.1, progressScore: 0.9, contextTokensApprox: 2000 },
    });
    const events = [
      buildRouteEvent(first, decideRoute(first), "2026-06-12T00:00:02.000Z"),
      buildRouteEvent(second, decideRoute(second), "2026-06-12T00:00:03.000Z"),
    ];
    const cards = generateCapabilityCards(events, "2026-06-12T00:00:04.000Z", [{
      schema: "pi-router.outcome.v1",
      outcomeId: "outcome-1",
      recordedAt: "2026-06-12T00:00:04.000Z",
      sessionId: first.sessionId,
      checkpointId: first.checkpointId,
      taskType: "debug",
      taskStatus: "partial",
      testsPassedAfter: null,
      verifierImproved: null,
      acceptedDiff: null,
      userInterrupted: false,
      userOverrodeDecision: false,
      finalFilesTouched: 1,
      finalDiffLines: 12,
      wallTimeMs: null,
      cloudCostUsd: null,
      frontierCalls: 0,
      localTurns: 1,
      reworkTurns: 1,
      evidence: { source: "manual" },
    }]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      schema: "pi-router.model-capability-card.v1",
      modelId: "local/qwen",
      provider: "local",
      seed: { source: "none" },
      observed: {
        source: "local Pi telemetry",
        events: 2,
        sessions: 1,
        averageLoopScore: 0.325,
        averageProgressScore: 0.675,
        averageContextTokensApprox: 1500,
      },
      promotion: { manualOnly: true, promoted: false },
    });
    expect(cards[0].observed.actions.escalate_debug_diagnosis).toBe(1);
    expect(cards[0].observed.actions.continue_current).toBe(1);
    expect(cards[0].observed.outcomes).toMatchObject({ linked: 1, partial: 1, averageReworkTurns: 1 });
  });

  it("fails capability-card generation when required events input is missing", () => {
    expect(() => writeCapabilityCards("/tmp/pi-router-missing-events.jsonl", tempFile("cards.jsonl"))).toThrow(/required route events file not found/);
  });

  it("writes capability cards as JSONL", () => {
    const eventPath = tempFile("events.jsonl");
    const outputPath = tempFile("cards.jsonl");
    const item = checkpoint();
    writeFileSync(eventPath, `${JSON.stringify(buildRouteEvent(item, decideRoute(item)))}\n`);

    const cards = writeCapabilityCards(eventPath, outputPath);

    expect(cards).toHaveLength(1);
    expect(readFileSync(outputPath, "utf8")).toContain("pi-router.model-capability-card.v1");
  });

  it("generates teacher labels and reflection artifacts without transcript content", () => {
    const sensitiveText = "raw command npm test with SECRET_TOKEN=abc";
    const item = checkpoint();
    const reflection = generateTeacherReflection([item], { teacher: "local-rule", generatedAt: "2026-06-12T00:00:05.000Z" });
    const serialized = JSON.stringify(reflection);

    expect(reflection.labels).toHaveLength(1);
    expect(reflection.labels[0]).toMatchObject({
      schema: "pi-router.teacher-label.v1",
      checkpointId: item.checkpointId,
      sessionId: item.sessionId,
      source: "local-rule",
      suggestedAction: "escalate_debug_diagnosis",
    });
    expect(reflection.markdown).toContain("Manual promotion only");
    expect(serialized).not.toContain(sensitiveText);
    expect(serialized).not.toContain("npm test");
    expect(serialized).not.toContain("SECRET_TOKEN");
  });

  it("marks imported teacher decisions with teacher-output provenance", () => {
    const decisionPath = tempFile("teacher-decisions.jsonl");
    const item = checkpoint();
    writeFileSync(decisionPath, `${JSON.stringify({ ...decideRoute(item), action: "run_verifier" })}\n`);

    const reflection = generateTeacherReflection([item], { teacher: "configured-teacher", teacherOutputPath: decisionPath });

    expect(reflection.labels[0]).toMatchObject({ source: "teacher-output", suggestedAction: "run_verifier", teacher: "configured-teacher" });
  });

  it("requires explicit teacher output for non-local teachers", () => {
    expect(() => generateTeacherReflection([checkpoint()], { teacher: "configured-teacher" })).toThrow(/requires --teacher-output/);
  });

  it("writes reflection labels and markdown", () => {
    const checkpointPath = tempFile("checkpoints.jsonl");
    const labelsPath = tempFile("teacher-labels.jsonl");
    const reflectionPath = tempFile("reflection.md");
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint())}\n`);

    const result = writeTeacherReflection({ checkpointPath, labelsPath, reflectionPath, teacher: "local-rule" });

    expect(result.labels).toHaveLength(1);
    expect(readFileSync(labelsPath, "utf8")).toContain("pi-router.teacher-label.v1");
    expect(readFileSync(reflectionPath, "utf8")).toContain("Pi router teacher reflection");
  });

  it("shadow-evaluates policy decisions against historical ledger events", () => {
    const item = checkpoint();
    const actualDecision = { ...decideRoute(item), action: "continue_current" as const };
    const report = shadowEvaluate([item], [buildRouteEvent(item, actualDecision)], "2026-06-12T00:00:06.000Z");

    expect(report).toMatchObject({
      schema: "pi-router.shadow-eval.v1",
      checkpoints: 1,
      comparedEvents: 1,
      divergences: 1,
      divergenceRate: 1,
      manualPromotionRequired: true,
    });
    expect(report.actionCounts.escalate_debug_diagnosis).toBe(1);
    expect(report.ledgerActionCounts.continue_current).toBe(1);
  });

  it("fails shadow eval when an explicit ledger path is missing", () => {
    const checkpointPath = tempFile("checkpoints.jsonl");
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint())}\n`);

    expect(() => writeShadowEval(checkpointPath, tempFile("shadow.json"), "/tmp/pi-router-missing-ledger.jsonl")).toThrow(/required route events file not found/);
  });

  it("writes shadow eval reports", () => {
    const checkpointPath = tempFile("checkpoints.jsonl");
    const outputPath = tempFile("shadow.json");
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint())}\n`);

    const report = writeShadowEval(checkpointPath, outputPath);

    expect(report.checkpoints).toBe(1);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).schema).toBe("pi-router.shadow-eval.v1");
  });
});
