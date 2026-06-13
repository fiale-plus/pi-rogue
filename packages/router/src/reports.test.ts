import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRouterReport } from "./reports.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-report-")), name);
}

const rawRef = { schema: "pi-router.raw-session-ref.v1", path: "/tmp/session.jsonl", fromEvent: 0, toEvent: 1, fromByte: 0, toByte: 1, contentHash: "hash" };

function event(action = "run_verifier") {
  return {
    schema: "pi-router.route-event.v1",
    eventId: "event-1",
    recordedAt: "2026-06-14T00:00:00.000Z",
    checkpointId: "checkpoint-1",
    sessionId: "session-1",
    rawSessionRef: rawRef,
    sourceEvent: { index: 0, timestamp: null },
    decision: { schema: "pi-router.route-decision.v1", decisionId: "decision-1", checkpointId: "checkpoint-1", action, reason: "test", confidence: 0.5, policyVersion: "test", alternatives: [] },
    runtime: { activeModel: "qwen", provider: "local", contextTokensApprox: 1000, gitDirty: true },
    observed: { followed: false, overriddenBy: "continue_current" },
    metrics: { loopScore: 0.2, progressScore: 0.8, sameCommandRepeatedCount: 1, sameErrorRepeatedCount: 0, verifierUsed: true, diffLines: 10, diffFilesChanged: 1 },
  };
}

function outcome() {
  return {
    schema: "pi-router.outcome.v1",
    outcomeId: "outcome-1",
    recordedAt: "2026-06-14T00:00:00.000Z",
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
    routeEventId: "event-1",
    taskType: "implementation",
    taskStatus: "success",
    testsPassedAfter: true,
    verifierImproved: true,
    acceptedDiff: true,
    userInterrupted: false,
    userOverrodeDecision: true,
    finalFilesTouched: 1,
    finalDiffLines: 10,
    wallTimeMs: null,
    cloudCostUsd: null,
    frontierCalls: 0,
    localTurns: 2,
    reworkTurns: 0,
    evidence: { source: "manual", rawSessionRef: rawRef, routeEventId: "event-1", notesHash: "notes" },
  };
}

function trainingRow(label: "continue" | "intervene" | "unknown") {
  return {
    schema: "pi-router.training-row.v1",
    checkpointId: `checkpoint-${label}`,
    sessionId: "session-1",
    rawSessionRef: rawRef,
    features: { phase: "implementation", activeModel: "qwen", provider: "local", contextTokensApprox: 1000, sameCommandRepeatedCount: 1, sameErrorRepeatedCount: 0, loopScore: 0.1, progressScore: 0.9, verifierUsed: true, noVerifierUsed: false, diffLines: 10, diffFilesChanged: 1, diffChurnScore: 0.01, filesTouched: 1 },
    labels: { routeAction: label === "unknown" ? null : "continue_current", binaryGate: label, source: label === "unknown" ? "unknown" : "teacher", confidence: label === "unknown" ? null : 0.8 },
    outcome: { taskStatus: "unknown", testsPassedAfter: null, acceptedDiff: null, userOverrodeDecision: null, reworkTurns: null },
    provenance: { localRuleAction: "continue_current", excludedLocalRuleAsTruth: label === "unknown" },
  };
}

describe("router report", () => {
  it("writes JSON and Markdown summaries", () => {
    const eventsPath = tempFile("events.jsonl");
    const outcomesPath = tempFile("outcomes.jsonl");
    const rowsPath = tempFile("training.jsonl");
    const gatePath = tempFile("gate-report.json");
    const outputPath = tempFile("report.json");
    const markdownPath = tempFile("report.md");
    writeFileSync(eventsPath, `${JSON.stringify(event())}\n`);
    writeFileSync(outcomesPath, `${JSON.stringify(outcome())}\n`);
    writeFileSync(rowsPath, [JSON.stringify(trainingRow("continue")), JSON.stringify(trainingRow("unknown"))].join("\n") + "\n");
    writeFileSync(gatePath, JSON.stringify({ schema: "pi-router.binary-gate-eval.v1", candidate: { accuracy: 0.8, f1: 0.7 }, ruleBaseline: { accuracy: 0.6, f1: 0.5 } }));

    const report = writeRouterReport({ eventsPath, outcomesPath, trainingRowsPath: rowsPath, gateReportPath: gatePath, outputPath, markdownPath });

    expect(report).toMatchObject({ schema: "pi-router.report.v1", routeEvents: { total: 1, mismatches: 1 }, outcomes: { total: 1, linked: 1 }, trainingRows: { total: 2, labeled: 1, localRuleExcluded: 1 } });
    expect(JSON.parse(readFileSync(outputPath, "utf8")).schema).toBe("pi-router.report.v1");
    expect(readFileSync(markdownPath, "utf8")).toContain("# Pi router report");
  });

  it("requires at least one report input and rejects missing provided inputs", () => {
    expect(() => writeRouterReport({ outputPath: tempFile("report.json") })).toThrow(/requires at least one input/);
    expect(() => writeRouterReport({ eventsPath: tempFile("missing-events.jsonl"), outputPath: tempFile("report.json") })).toThrow(/report input file not found/);
  });
});
