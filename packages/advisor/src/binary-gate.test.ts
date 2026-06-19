import { describe, expect, it } from "vitest";
import { binaryGatePredict } from "./router.js";

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
import type { BinaryGateModel } from "./router.js";

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
