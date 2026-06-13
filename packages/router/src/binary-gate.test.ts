import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trainBinaryGate, writeBinaryGateTraining } from "./binary-gate.js";
import type { RouterTrainingRow } from "./dataset.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-router-gate-")), name);
}

function row(id: string, label: "continue" | "intervene" | "unknown", overrides: Partial<RouterTrainingRow["features"]> = {}, source: RouterTrainingRow["labels"]["source"] = label === "unknown" ? "unknown" : "teacher"): RouterTrainingRow {
  return {
    schema: "pi-router.training-row.v1",
    checkpointId: id,
    sessionId: "session-1",
    rawSessionRef: { schema: "pi-router.raw-session-ref.v1", path: "/tmp/session.jsonl", fromEvent: 0, toEvent: 1, fromByte: 0, toByte: 1, contentHash: "hash" },
    features: {
      phase: "implementation",
      activeModel: "qwen",
      provider: "local",
      contextTokensApprox: 1000,
      sameCommandRepeatedCount: 1,
      sameErrorRepeatedCount: 0,
      loopScore: 0.1,
      progressScore: 0.9,
      verifierUsed: true,
      noVerifierUsed: false,
      diffLines: 10,
      diffFilesChanged: 1,
      diffChurnScore: 0.01,
      filesTouched: 1,
      ...overrides,
    },
    labels: { routeAction: label === "intervene" ? "run_verifier" : label === "continue" ? "continue_current" : null, binaryGate: label, source, confidence: label === "unknown" ? null : 0.8 },
    outcome: { taskStatus: "unknown", testsPassedAfter: null, acceptedDiff: null, userOverrodeDecision: null, reworkTurns: null },
    provenance: { localRuleAction: label === "intervene" ? "run_verifier" : "continue_current", excludedLocalRuleAsTruth: false },
  };
}

describe("router binary gate training", () => {
  it("trains a threshold artifact and reports candidate vs rule baseline", () => {
    const rows = [
      row("continue-1", "continue"),
      row("intervene-1", "intervene", { phase: "debug", loopScore: 0.8, progressScore: 0.2, sameErrorRepeatedCount: 3, noVerifierUsed: true, verifierUsed: false }),
      row("unknown-1", "unknown"),
    ];

    const evalRows = [
      row("eval-continue-1", "continue"),
      row("eval-intervene-1", "intervene", { phase: "debug", loopScore: 0.7, progressScore: 0.3, sameErrorRepeatedCount: 2 }),
    ];

    const { artifact, report } = trainBinaryGate(rows, evalRows, "2026-06-14T00:00:00.000Z");

    expect(artifact).toMatchObject({ schema: "pi-router.binary-gate-artifact.v1", manualPromotionRequired: true, training: { rows: 3, labeledRows: 2 }, evaluation: { rows: 2, labeledRows: 2 } });
    expect(report).toMatchObject({ schema: "pi-router.binary-gate-eval.v1", trainRows: 3, trainLabeledRows: 2, evalRows: 2, evalLabeledRows: 2, manualPromotionRequired: true });
    expect(report.thresholdSweep.length).toBeGreaterThan(1);
    expect(report.candidate.truePositive + report.candidate.trueNegative + report.candidate.falsePositive + report.candidate.falseNegative).toBe(2);
  });

  it("writes gate artifact and eval report", () => {
    const input = tempFile("training.jsonl");
    const evalInput = tempFile("eval.jsonl");
    const artifact = tempFile("gate.json");
    const report = tempFile("report.json");
    writeFileSync(input, [
      JSON.stringify(row("continue-1", "continue")),
      JSON.stringify(row("intervene-1", "intervene", { loopScore: 0.9, progressScore: 0.1, noVerifierUsed: true })),
    ].join("\n") + "\n");
    writeFileSync(evalInput, [
      JSON.stringify(row("eval-continue-1", "continue")),
      JSON.stringify(row("eval-intervene-1", "intervene", { loopScore: 0.8, progressScore: 0.2, sameErrorRepeatedCount: 3 })),
    ].join("\n") + "\n");

    const summary = writeBinaryGateTraining({ trainingRowsPath: input, evalRowsPath: evalInput, artifactPath: artifact, reportPath: report });

    expect(summary).toMatchObject({ schema: "pi-router.binary-gate-train-summary.v1", trainRows: 2, trainLabeledRows: 2, evalRows: 2, evalLabeledRows: 2 });
    expect(JSON.parse(readFileSync(artifact, "utf8")).schema).toBe("pi-router.binary-gate-artifact.v1");
    expect(JSON.parse(readFileSync(report, "utf8")).schema).toBe("pi-router.binary-gate-eval.v1");
    expect(() => writeBinaryGateTraining({ trainingRowsPath: input, evalRowsPath: input, artifactPath: tempFile("bad-gate.json"), reportPath: tempFile("bad-report.json") })).toThrow(/distinct --eval-dataset/);
  });

  it("rejects unusable labels", () => {
    expect(() => trainBinaryGate([row("rule-1", "continue", {}, "local-rule"), row("rule-2", "intervene", {}, "local-rule")], [row("eval-1", "continue"), row("eval-2", "intervene")])).toThrow(/no usable/);
    expect(() => trainBinaryGate([row("only-continue", "continue")], [row("eval-1", "continue"), row("eval-2", "intervene")])).toThrow(/both continue and intervene/);
  });
});
