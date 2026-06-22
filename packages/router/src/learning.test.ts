import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideRoute } from "./decision.js";
import { buildRouteEvent } from "./ledger.js";
import {
  generateCapabilityCards,
  generateTeacherReflection,
  isV2Card,
  getCardTier,
  getCardCost,
  getCardContextWindow,
  shadowEvaluate,
  writeCapabilityCards,
  writeShadowEval,
  writeTeacherReflection,
  MODEL_CAPABILITY_CARD_SCHEMA_V2,
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
      schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
      modelId: "local/qwen",
      provider: "local",
      capabilities: { tier: "local", contextWindow: 131072, tags: ["local"] },
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
    expect(readFileSync(outputPath, "utf8")).toContain(MODEL_CAPABILITY_CARD_SCHEMA_V2);
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

  describe("v2 capability cards with structured metadata", () => {
    it("generates v2 cards with capabilities metadata for known models", () => {
      const item = checkpoint({ activeModel: "openai/gpt-4", provider: "openai" });
      const events = [buildRouteEvent(item, decideRoute(item))];
      const cards = generateCapabilityCards(events);

      expect(cards).toHaveLength(1);
      expect(cards[0].schema).toBe(MODEL_CAPABILITY_CARD_SCHEMA_V2);
      expect(cards[0].capabilities).toMatchObject({
        tier: "premium",
        cost: { input: 0.01, output: 0.03 },
        tags: ["premium", "gpt"],
      });
    });

    it("generates v2 cards with capabilities for local models", () => {
      const item = checkpoint({ activeModel: "local/qwen", provider: "local" });
      const events = [buildRouteEvent(item, decideRoute(item))];
      const cards = generateCapabilityCards(events);

      expect(cards[0].capabilities?.tier).toBe("local");
      expect(cards[0].capabilities?.contextWindow).toBe(131072);
    });

    it("generates v2 cards with capabilities for cheap models", () => {
      const item = checkpoint({ activeModel: "anthropic/claude-sonnet-4", provider: "anthropic" });
      const events = [buildRouteEvent(item, decideRoute(item))];
      const cards = generateCapabilityCards(events);

      expect(cards[0].capabilities?.tier).toBe("premium");
      expect(cards[0].capabilities?.cost).toMatchObject({ input: 0.008, output: 0.024 });
    });

    it("uses default tier for unknown models", () => {
      const item = checkpoint({ activeModel: "unknown-model", provider: "unknown" });
      const events = [buildRouteEvent(item, decideRoute(item))];
      const cards = generateCapabilityCards(events);

      expect(cards[0].capabilities).toBeUndefined();
    });

    it("isV2Card correctly discriminates v1 vs v2 cards", () => {
      const v1Card = {
        schema: "pi-router.model-capability-card.v1",
        modelId: "test",
        provider: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        seed: { source: "none", purpose: "test" },
        observed: {
          source: "local Pi telemetry",
          events: 1,
          sessions: 1,
          actions: {},
          averageLoopScore: 0.5,
          averageProgressScore: 0.5,
          averageContextTokensApprox: null,
          outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
        },
        promotion: { manualOnly: true, promoted: false },
      } as const;

      const v2Card = {
        schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
        modelId: "test",
        provider: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        capabilities: { tier: "local" },
        seed: { source: "none", purpose: "test" },
        observed: {
          source: "local Pi telemetry",
          events: 1,
          sessions: 1,
          actions: {},
          averageLoopScore: 0.5,
          averageProgressScore: 0.5,
          averageContextTokensApprox: null,
          outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
        },
        promotion: { manualOnly: true, promoted: false },
      } as const;

      expect(isV2Card(v1Card as any)).toBe(false);
      expect(isV2Card(v2Card as any)).toBe(true);
    });

    it("getCardTier returns tier from v2 cards", () => {
      const v2Card = {
        schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
        modelId: "test",
        provider: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        capabilities: { tier: "cheap" },
        seed: { source: "none", purpose: "test" },
        observed: {
          source: "local Pi telemetry",
          events: 1,
          sessions: 1,
          actions: {},
          averageLoopScore: 0.5,
          averageProgressScore: 0.5,
          averageContextTokensApprox: null,
          outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
        },
        promotion: { manualOnly: true, promoted: false },
      } as const;

      expect(getCardTier(v2Card as any)).toBe("cheap");
    });

    it("getCardCost returns cost from v2 cards", () => {
      const v2Card = {
        schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
        modelId: "test",
        provider: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        capabilities: { cost: { input: 0.001, output: 0.002 } },
        seed: { source: "none", purpose: "test" },
        observed: {
          source: "local Pi telemetry",
          events: 1,
          sessions: 1,
          actions: {},
          averageLoopScore: 0.5,
          averageProgressScore: 0.5,
          averageContextTokensApprox: null,
          outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
        },
        promotion: { manualOnly: true, promoted: false },
      } as const;

      expect(getCardCost(v2Card as any)).toEqual({ input: 0.001, output: 0.002 });
    });

    it("getCardContextWindow returns context window from v2 cards", () => {
      const v2Card = {
        schema: MODEL_CAPABILITY_CARD_SCHEMA_V2,
        modelId: "test",
        provider: "test",
        generatedAt: "2026-01-01T00:00:00Z",
        capabilities: { contextWindow: 131072 },
        seed: { source: "none", purpose: "test" },
        observed: {
          source: "local Pi telemetry",
          events: 1,
          sessions: 1,
          actions: {},
          averageLoopScore: 0.5,
          averageProgressScore: 0.5,
          averageContextTokensApprox: null,
          outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
        },
        promotion: { manualOnly: true, promoted: false },
      } as const;

      expect(getCardContextWindow(v2Card as any)).toBe(131072);
    });
  });
});
