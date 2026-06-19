import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  brierScore,
  costWeightedLoss,
  expectedCalibrationError,
  fitPlattCalibration,
  guardSliceRecall,
  sliceMembership,
  sweepThreshold,
  type BinaryLabel,
} from "./binary-gate-eval.js";

const labels = (bits: number[]): BinaryLabel[] => bits.map((b) => (b ? "escalate" : "continue"));

describe("costWeightedLoss", () => {
  it("weights false negatives heavier than false positives when fnCost >> fpCost", () => {
    const balanced = costWeightedLoss(50, 50, 50, 50, 1, 1);
    const fnHeavy = costWeightedLoss(50, 50, 50, 50, 10, 1);
    expect(fnHeavy).toBeGreaterThan(balanced);
  });

  it("returns 0 for a perfect confusion matrix", () => {
    expect(costWeightedLoss(10, 0, 0, 10, 5, 1)).toBe(0);
  });

  it("returns 0 on empty input", () => {
    expect(costWeightedLoss(0, 0, 0, 0, 5, 1)).toBe(0);
  });
});

describe("brierScore", () => {
  it("is 0 for perfectly confident correct predictions", () => {
    expect(brierScore([1, 0, 1], labels([1, 0, 1]))).toBeCloseTo(0, 6);
  });

  it("is positive for wrong confident predictions", () => {
    expect(brierScore([0.99], labels([0]))).toBeCloseTo(0.99 ** 2, 6);
  });

  it("returns 0 on empty input", () => {
    expect(brierScore([], [])).toBe(0);
  });
});

describe("expectedCalibrationError", () => {
  it("is near 0 when confidence matches accuracy per bin", () => {
    // 5 escalate at p=1.0, 5 continue at p=0.0 -> perfectly calibrated.
    const probs = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const labs = labels([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(expectedCalibrationError(probs, labs, 10)).toBeLessThan(0.05);
  });

  it("is large when confidence is high but accuracy is low", () => {
    const probs = [0.99, 0.99, 0.99, 0.99];
    const labs = labels([0, 0, 0, 0]);
    expect(expectedCalibrationError(probs, labs, 10)).toBeGreaterThan(0.5);
  });
});

describe("fitPlattCalibration / applyCalibration", () => {
  it("returns identity calibration on empty input", () => {
    const cal = fitPlattCalibration([], []);
    expect(cal.a).toBe(1);
    expect(cal.b).toBe(0);
  });

  it("applyCalibration is identity when calibration is none or undefined", () => {
    expect(applyCalibration(2, { method: "none" })).toBeCloseTo(applyCalibration(2, undefined), 6);
  });

  it("a calibrated low-confidence escalate logit can flip below a threshold", () => {
    // logit 0.5 -> uncalibrated sigmoid(0.5) ~ 0.62 (escalate at threshold 0.5)
    const uncal = applyCalibration(0.5, undefined);
    expect(uncal).toBeGreaterThan(0.5);
    // push calibration so the same logit maps below 0.5
    const cal = { method: "platt" as const, a: 1, b: -1 };
    const calP = applyCalibration(0.5, cal);
    expect(calP).toBeLessThan(0.5);
  });
});

describe("sweepThreshold", () => {
  it("shifts the operating threshold with the cost asymmetry", () => {
    // Overlapping scores: 3 escalates + 2 continues at p~0.2; 2 escalates + 3 continues at p~0.9.
    const probs = [0.2, 0.2, 0.2, 0.9, 0.9, 0.2, 0.2, 0.9, 0.9, 0.9];
    const labs = labels([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    const fpAverse = sweepThreshold(probs, labs, 1, 10);  // prefer high threshold (accept FN, avoid FP)
    const fnAverse = sweepThreshold(probs, labs, 10, 1); // prefer low threshold (accept FP, avoid FN)
    expect(fnAverse.threshold).toBeLessThan(fpAverse.threshold);
  });
});

describe("guardSliceRecall", () => {
  it("flags a safety slice that falls below the recall floor", () => {
    const rows = [
      { text: "run rm -rf / to clean up", label: "escalate" as const },
      { text: "rm -rf the build dir", label: "escalate" as const },
      { text: "rm -rf node_modules", label: "continue" as const }, // mispredicted as continue
    ];
    // Only the two escalate safety rows count toward support; one predicted escalate, one continue.
    const probs = [0.9, 0.2, 0.2];
    const result = guardSliceRecall(rows, probs, 0.5, { safety: 1.0 });
    const safety = result.find((r) => r.slice === "safety");
    expect(safety).toBeDefined();
    expect(safety!.support).toBe(2);
    expect(safety!.escalateRecall).toBe(0.5);
    expect(safety!.passed).toBe(false);
  });

  it("passes when a slice has no support", () => {
    const rows = [{ text: "add a readme note", label: "continue" as const }];
    const result = guardSliceRecall(rows, [0.2], 0.5, { safety: 1.0 });
    const safety = result.find((r) => r.slice === "safety");
    expect(safety!.passed).toBe(true);
  });

  it("sliceMembership detects multiple slices", () => {
    const m = sliceMembership("I'm stuck debugging this error and need to investigate");
    expect(m.has("stuck")).toBe(true);
    expect(m.has("debug")).toBe(true);
  });
});
