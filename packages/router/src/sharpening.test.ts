import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouteEvent, type RouteEvent } from "./ledger.js";
import { generateSharpeningHints, writeSharpeningHints } from "./sharpening.js";
import type { RouterOutcome } from "./outcomes.js";
import type { RouteAction, RouteDecision, RouterCheckpoint, TaskStatus } from "./types.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-sharpening-")), name);
}

function checkpoint(id: string, model: string, provider: string, progressScore: number, loopScore: number): RouterCheckpoint {
  return {
    schema: "pi-router.checkpoint.v1",
    sessionId: `session-${id.slice(0, 1)}`,
    checkpointId: `session-${id.slice(0, 1)}:event-${id}`,
    createdAt: "2026-06-14T00:00:00.000Z",
    rawSessionRef: {
      schema: "pi-router.raw-session-ref.v1",
      path: "/tmp/raw-session-with-SECRET_TOKEN.jsonl",
      fromEvent: 1,
      toEvent: 2,
      fromByte: 10,
      toByte: 20,
      contentHash: `hash-${id}`,
    },
    harness: "pi",
    phase: "implementation",
    activeModel: model,
    provider,
    features: {
      turnIndex: 2,
      sameCommandRepeatedCount: 1,
      sameErrorRepeatedCount: 0,
      errorChanged: true,
      testsImproved: null,
      filesTouched: 1,
      diffLines: 12,
      diffFilesChanged: 1,
      diffLinesAdded: 8,
      diffLinesDeleted: 4,
      diffChurnScore: 0,
      toolThrashScore: 0,
      goalDriftScore: 0,
      loopScore,
      progressScore,
      verifierUsed: true,
      noVerifierUsed: false,
      toolCallsLast10Turns: 3,
      contextTokensApprox: 1000,
      gitDirty: null,
    },
    recent: { touchedFileHashes: ["file-hash"] },
    sourceEvent: { index: 2, byteStart: 10, byteEnd: 20, id: `event-${id}`, timestamp: "2026-06-14T00:00:01.000Z", type: "message", role: "toolResult" },
  };
}

function decision(checkpointId: string, action: RouteAction): RouteDecision {
  return {
    schema: "pi-router.decision.v1",
    checkpointId,
    action,
    adviceShape: "none",
    contextPolicy: "none",
    confidence: 0.75,
    reason: "test decision",
    policyVersion: "test-policy",
  };
}

function event(id: string, action: RouteAction, model: string, provider: string, progressScore: number, loopScore: number): RouteEvent {
  const item = checkpoint(id, model, provider, progressScore, loopScore);
  return buildRouteEvent(item, decision(item.checkpointId, action), `2026-06-14T00:00:${id.padStart(2, "0")}.000Z`);
}

function outcomeFor(routeEvent: RouteEvent, status: TaskStatus): RouterOutcome {
  return {
    schema: "pi-router.outcome.v1",
    outcomeId: `outcome-${routeEvent.eventId}`,
    recordedAt: "2026-06-14T00:01:00.000Z",
    sessionId: routeEvent.sessionId,
    checkpointId: routeEvent.checkpointId,
    routeEventId: routeEvent.eventId,
    taskType: "implementation",
    taskStatus: status,
    testsPassedAfter: null,
    verifierImproved: null,
    acceptedDiff: null,
    userInterrupted: false,
    userOverrodeDecision: false,
    finalFilesTouched: 1,
    finalDiffLines: 12,
    wallTimeMs: null,
    cloudCostUsd: null,
    frontierCalls: providerIsFrontier(routeEvent.runtime.activeModel) ? 1 : 0,
    localTurns: providerIsFrontier(routeEvent.runtime.activeModel) ? 0 : 1,
    reworkTurns: 0,
    evidence: { source: "manual", routeEventId: routeEvent.eventId },
  };
}

function providerIsFrontier(model?: string): boolean {
  return Boolean(model && /gpt|claude|gemini/i.test(model));
}

describe("router sharpening hints", () => {
  it("generates deterministic provenance-backed model preference hints without transcript content", () => {
    const qwen = [
      event("11", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.9, 0.05),
      event("12", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.85, 0.1),
      event("13", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.88, 0.08),
      event("14", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.86, 0.12),
      event("15", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.82, 0.1),
    ];
    const gpt = [
      event("21", "run_verifier", "gpt-5.5", "openai-codex", 0.62, 0.35),
      event("22", "run_verifier", "gpt-5.5", "openai-codex", 0.58, 0.4),
      event("23", "run_verifier", "gpt-5.5", "openai-codex", 0.65, 0.32),
      event("24", "run_verifier", "gpt-5.5", "openai-codex", 0.6, 0.38),
      event("25", "run_verifier", "gpt-5.5", "openai-codex", 0.61, 0.37),
    ];
    const artifact = generateSharpeningHints({
      events: [...gpt, ...qwen].reverse(),
      outcomes: [...qwen.map((item) => outcomeFor(item, "success")), ...gpt.map((item) => outcomeFor(item, "partial"))],
      generatedAt: "2026-06-14T00:02:00.000Z",
      inputs: { events: "events.jsonl", outcomes: "outcomes.jsonl" },
    });

    expect(artifact).toMatchObject({
      schema: "pi-router.sharpening-hints.v1",
      generatedAt: "2026-06-14T00:02:00.000Z",
      totals: { events: 10, outcomes: 10, sessions: 2, models: 2 },
      manualPromotionRequired: true,
    });
    const prefer = artifact.hints.find((hint) => hint.kind === "prefer_model_for_action");
    expect(prefer).toMatchObject({
      action: "run_verifier",
      modelId: "qwen3.6-35b-a3b-128k",
      provider: "local",
      confidence: "medium",
      guardrails: { manualPromotionOnly: true, sparse: false },
    });
    expect(prefer?.provenance.comparedWith?.[0]).toMatchObject({ modelId: "gpt-5.5", provider: "openai-codex", events: 5 });
    expect(JSON.stringify(artifact)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(artifact)).not.toContain("raw-session");
  });

  it("marks sparse hints low-confidence and sample-size capped", () => {
    const local = [event("31", "continue_current", "qwen-local", "local", 0.9, 0.05)];
    const cloud = [event("41", "continue_current", "gpt-5.5", "openai-codex", 0.4, 0.6)];

    const artifact = generateSharpeningHints({ events: [...local, ...cloud], generatedAt: "2026-06-14T00:03:00.000Z" });
    const hint = artifact.hints.find((item) => item.kind === "prefer_model_for_action");

    expect(hint?.confidence).toBe("low");
    expect(hint?.guardrails).toMatchObject({ sparse: true, sampleSizeCapped: true, manualPromotionOnly: true });
  });

  it("emits local savings candidates only as manual hints", () => {
    const events = [
      event("51", "continue_current", "qwen3.6-35b-a3b-128k", "local", 0.9, 0.05),
      event("52", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.88, 0.08),
      event("53", "summarize_context", "qwen3.6-35b-a3b-128k", "local", 0.85, 0.1),
    ];

    const artifact = generateSharpeningHints({ events, generatedAt: "2026-06-14T00:04:00.000Z" });
    const savings = artifact.hints.find((hint) => hint.kind === "savings_candidate");

    expect(savings).toMatchObject({ modelId: "qwen3.6-35b-a3b-128k", provider: "local", confidence: "low" });
    expect(savings?.rationale).toContain("manual hint, not an automatic promotion");
  });

  it("writes sharpening hints and fails clearly for missing event inputs", () => {
    const eventPath = tempFile("events.jsonl");
    const outputPath = tempFile("hints.json");
    const item = event("61", "run_verifier", "qwen3.6-35b-a3b-128k", "local", 0.9, 0.05);
    writeFileSync(eventPath, `${JSON.stringify(item)}\n`);

    const artifact = writeSharpeningHints({ eventsPath: eventPath, outputPath, generatedAt: "2026-06-14T00:05:00.000Z" });

    expect(artifact.schema).toBe("pi-router.sharpening-hints.v1");
    expect(JSON.parse(readFileSync(outputPath, "utf8")).schema).toBe("pi-router.sharpening-hints.v1");
    expect(() => writeSharpeningHints({ eventsPath: "/tmp/pi-router-missing-events.jsonl", outputPath })).toThrow(/required route events file not found/);
  });
});
