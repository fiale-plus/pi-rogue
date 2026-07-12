import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryGatePredict, inspectBinaryGateArtifact } from "./router.js";

describe("binary gate artifact status", () => {
  it("reports a missing artifact without seeding arbitrary paths", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-rogue-gate-missing-")), "missing.json");
    const status = inspectBinaryGateArtifact(path, false);

    expect(status).toMatchObject({ available: false, usable: false, source: "missing" });
    expect(status.path).toBe(path);
  });

  it("reports malformed artifacts as unusable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-rogue-gate-malformed-")), "gate.json");
    writeFileSync(path, "{not json", "utf8");

    const status = inspectBinaryGateArtifact(path, false);

    expect(status.available).toBe(true);
    expect(status.usable).toBe(false);
    expect(status.source).toBe("malformed");
    expect(status.error).toBeTruthy();
  });

  it("rejects weak-label research models as non-promotable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-rogue-gate-weak-")), "gate.json");
    writeFileSync(path, JSON.stringify({
      kind: "binary-logreg-v2",
      labels: ["continue", "escalate"],
      features: [],
      idf: [],
      bias: [0, 0],
      weights: [[], []],
      config: { weakLabelResearch: true },
    }), "utf8");

    const status = inspectBinaryGateArtifact(path, false);
    expect(status).toMatchObject({ available: true, usable: false, source: "unsupported" });
  });

  it("reports valid v2 artifacts as usable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-rogue-gate-valid-")), "gate.json");
    writeFileSync(path, JSON.stringify({
      kind: "binary-logreg-v2",
      labels: ["continue", "escalate"],
      features: [],
      idf: [],
      bias: [0, 0],
      weights: [[], []],
      thresholds: { default: 0.5, preflight: 0.6 },
    }), "utf8");

    const status = inspectBinaryGateArtifact(path, false);

    expect(status).toMatchObject({ available: true, usable: true, source: "installed", kind: "binary-logreg-v2", features: 0, stacked: false });
    expect(status.thresholds?.preflight).toBe(0.6);
  });
});

describe("binary gate model", () => {
  it("returns a decision when model is available", () => {
    const result = binaryGatePredict("test");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("classifies short prompts and returns a valid decision", () => {
    const result = binaryGatePredict("fix typo");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThan(0.5);
    }
  });

  it("handles empty text gracefully", () => {
    const result = binaryGatePredict("");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("handles very long text without crashing", () => {
    const longText = "a".repeat(10000);
    const result = binaryGatePredict(longText);
    if (result) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("handles unicode text", () => {
    const result = binaryGatePredict("Привет мир 你好世界 مرحبا بالعالم");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("handles special characters and potential injection", () => {
    const result = binaryGatePredict("fix <script>alert('xss')</script> && rm -rf /");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("handles URLs", () => {
    const result = binaryGatePredict("check https://example.com/path?query=value&foo=bar");
    if (result) {
      expect(["continue", "escalate"]).toContain(result.decision);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});


import { predictWithModel } from "./router.js";
import type { BinaryGateModel, StackedGateModel } from "./router.js";
import { trajectoryFeatureVector, TRAJECTORY_FEATURE_NAMES } from "./binary-gate-eval.js";

// A minimal v2 model with no features: scores are just `bias`, so the escalate
// logit is bias[1]-bias[0]. Lets us assert calibration + threshold behavior directly.
function tinyModel(over: Partial<BinaryGateModel>): BinaryGateModel {
  return {
    kind: "binary-logreg-v2",
    labels: ["continue", "escalate"],
    features: [],
    idf: [],
    bias: [0, 0],
    weights: [[], []],
    ...over,
  } as BinaryGateModel;
}

describe("binary gate v2 calibrated predictions", () => {
  it("returns calibrated probability, threshold, and trusted source for a v2 model", () => {
    const model = tinyModel({ bias: [-2, 2] }); // escalate logit 4 -> p~0.98
    const result = predictWithModel(model, "anything");
    expect(result.source).toBe("model-v2");
    expect(result.trusted).toBe(true);
    expect(result.probability).toBeGreaterThan(0.9);
    expect(result.decision).toBe("escalate");
    expect(result.threshold).toBe(0.5);
    expect(result.confidence).toBeCloseTo(result.probability, 6);
  });

  it("respects per-phase thresholds so the same input can escalate or continue by phase", () => {
    const model = tinyModel({
      bias: [-2, 2], // p~0.982
      thresholds: { default: 0.5, preflight: 0.99, review: 0.5 },
    });
    expect(predictWithModel(model, "x", "preflight").decision).toBe("continue");
    expect(predictWithModel(model, "x", "review").decision).toBe("escalate");
  });

  it("applies Platt calibration to the escalate logit", () => {
    const model = tinyModel({ bias: [0, 0], calibration: { method: "platt", a: 1, b: -2 } });
    // logit 0 -> sigmoid(-2) ~ 0.12 -> continue at default threshold 0.5
    const result = predictWithModel(model, "x");
    expect(result.probability).toBeCloseTo(0.1192, 2);
    expect(result.decision).toBe("continue");
  });

  it("v1 assets keep the legacy trust gate (low confidence is not trusted)", () => {
    const model = tinyModel({ kind: "binary-logreg-v1", bias: [0, 0] }); // p=0.5, conf=0.5
    const result = predictWithModel(model, "x");
    expect(result.source).toBe("model-v1-legacy");
    expect(result.trusted).toBe(false);
  });
});

describe("binary gate v4 stacked trajectory model", () => {
  // Stacked second-stage: input = [textGateProb, ...8 trajectory features].
  // weights[0] is the text-gate-prob weight; the rest align to TRAJECTORY_FEATURE_NAMES.
  function stackedModel(over: Partial<StackedGateModel>): StackedGateModel {
    return {
      trajectoryFeatures: [...TRAJECTORY_FEATURE_NAMES],
      bias: 0,
      weights: [1, 0, 0, 0, 0, 0, 0, 0, 0], // identity on text-gate prob by default
      ...over,
    } as StackedGateModel;
  }

  it("falls back to text-only when no trajectory features are passed", () => {
    const model = tinyModel({ bias: [-2, 2], stacked: stackedModel({ bias: -10, weights: [0, 5, 0, 0, 0, 0, 0, 0, 0] }) });
    const textOnly = predictWithModel(model, "x");
    // Without trajectory, the stacked path is skipped, so probability stays ~0.98.
    expect(textOnly.probability).toBeGreaterThan(0.9);
    expect(textOnly.decision).toBe("escalate");
  });

  it("ignores stacked thresholds when trajectory is missing", () => {
    const model = tinyModel({
      bias: [-2, 2],
      thresholds: { default: 0.99, preflight: 0.99, review: 0.99 },
      stacked: stackedModel({
        bias: -10,
        weights: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        thresholds: { default: 0.01, preflight: 0.01, review: 0.01, closeout: 0.01 },
      }),
    });
    const result = predictWithModel(model, "x", "review");
    expect(result.threshold).toBe(0.99);
    expect(result.decision).toBe("continue");
  });

  it("applies the stacked second-stage when trajectory features are provided", () => {
    // Text gate says escalate (prob ~0.98), but a strong negative weight on
    // failed=false + a big negative bias should flip it to continue.
    const model = tinyModel({
      bias: [-2, 2],
      stacked: stackedModel({ bias: -8, weights: [0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    });
    const result = predictWithModel(model, "x", "review", { failed: false, fileChanged: true });
    expect(result.probability).toBeLessThan(0.5);
    expect(result.decision).toBe("continue");
  });

  it("trajectory features can escalate a text-continue case", () => {
    // Text gate says continue (prob ~0.02); a positive weight on failed should escalate.
    const model = tinyModel({
      bias: [2, -2],
      stacked: stackedModel({ bias: 0, weights: [0, 0, 0, 0, 0, 0, 5, 0, 0] }), // failed weight = 5
    });
    const result = predictWithModel(model, "x", "review", { failed: true });
    expect(result.probability).toBeGreaterThan(0.5);
    expect(result.decision).toBe("escalate");
  });

  it("falls back to text-only when stacked weights are malformed", () => {
    const model = tinyModel({
      bias: [-2, 2],
      stacked: stackedModel({ bias: -8, weights: [1, 2, 3] }),
    });
    const textOnly = predictWithModel(model, "x", "review");
    const withTrajectory = predictWithModel(model, "x", "review", { failed: true, fileChanged: true });
    expect(withTrajectory.probability).toBeCloseTo(textOnly.probability, 6);
    expect(withTrajectory.decision).toBe(textOnly.decision);
  });

  it("trajectoryFeatureVector normalizes missing fields to neutral values", () => {
    expect(trajectoryFeatureVector(undefined)).toHaveLength(TRAJECTORY_FEATURE_NAMES.length);
    const v = trajectoryFeatureVector({ loopScore: 0.9, diffLines: 1000, failed: true, turns: 200 });
    expect(v[0]).toBeCloseTo(0.9, 6); // loopScore clamped
    expect(v[3]).toBeLessThanOrEqual(1); // diffLines log1p-capped
    expect(v[5]).toBe(1); // failed boolean
    expect(v[7]).toBeLessThanOrEqual(1); // turns log1p-capped
    const sparse = trajectoryFeatureVector({});
    expect(sparse.every((x) => x === 0)).toBe(true);
  });
});
