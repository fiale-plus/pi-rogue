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
