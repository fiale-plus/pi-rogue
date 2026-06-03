import { describe, it, expect } from "vitest";
import { normalizeGuardrailsConfig, type GuardrailsConfig, type GuardrailsMode } from "./config.js";

describe("normalizeGuardrailsConfig", () => {
  it("provides defaults for empty input", () => {
    const result = normalizeGuardrailsConfig({});
    expect(result.mode).toBe("ask");
    expect(result.llmReview.enabled).toBe(false);
    expect(result.extraDangerousFragments).toEqual([]);
  });

  it("preserves valid mode", () => {
    expect(normalizeGuardrailsConfig({ mode: "block" }).mode).toBe("block");
    expect(normalizeGuardrailsConfig({ mode: "allow" }).mode).toBe("allow");
    expect(normalizeGuardrailsConfig({ mode: "ask" }).mode).toBe("ask");
  });

  it("defaults invalid mode to ask", () => {
    expect(normalizeGuardrailsConfig({ mode: "invalid" as GuardrailsMode }).mode).toBe("ask");
  });

  it("normalizes llmReview.enabled to boolean", () => {
    expect(normalizeGuardrailsConfig({ llmReview: { enabled: true } }).llmReview.enabled).toBe(true);
    expect(normalizeGuardrailsConfig({ llmReview: { enabled: false } }).llmReview.enabled).toBe(false);
    expect(normalizeGuardrailsConfig({ llmReview: {} as any }).llmReview.enabled).toBe(false);
  });

  it("deduplicates and trims extra fragments", () => {
    const result = normalizeGuardrailsConfig({
      extraDangerousFragments: ["  rm  ", "  sudo ", "rm  "],
    });
    expect(result.extraDangerousFragments).toEqual(["rm", "sudo"]);
  });

  it("handles null/undefined fragments gracefully", () => {
    const result = normalizeGuardrailsConfig({
      extraDangerousFragments: null as unknown as string[],
    });
    expect(result.extraDangerousFragments).toEqual([]);
  });

  it("defaults askOnWarn to false", () => {
    const result = normalizeGuardrailsConfig({});
    expect(result.askOnWarn).toBe(false);
  });

  it("accepts allow mode and keep askOnWarn explicit", () => {
    const result = normalizeGuardrailsConfig({ mode: "off", askOnWarn: true });
    expect(result.mode).toBe("off");
    expect(result.askOnWarn).toBe(true);
  });

  it("keeps llm model override when provided", () => {
    const result = normalizeGuardrailsConfig({
      llmReview: {
        enabled: true,
        model: "provider/model",
      },
    });
    expect(result.llmReview.model).toBe("provider/model");
  });

  it("normalizes local tiny model aliases", () => {
    const result = normalizeGuardrailsConfig({
      llmReview: {
        enabled: true,
        model: "tiny",
      },
    });
    expect(result.llmReview.model).toBe("local");

    const result2 = normalizeGuardrailsConfig({
      llmReview: {
        enabled: true,
        model: "binary",
      },
    });
    expect(result2.llmReview.model).toBe("local");
  });

  it("defaults llm model when blank", () => {
    const result = normalizeGuardrailsConfig({
      llmReview: {
        enabled: true,
        model: "   ",
      },
    });
    expect(result.llmReview.model).toBeUndefined();
  });

  it("produces a valid config with llm model", () => {
    const cfg = normalizeGuardrailsConfig({
      llmReview: {
        enabled: true,
        model: "provider/model",
      },
      extraDangerousFragments: [],
    });
    expect(cfg.llmReview).toBeDefined();
    expect(cfg.llmReview.model).toBe("provider/model");
  });
  it("produces a valid config", () => {
    const cfg: GuardrailsConfig = normalizeGuardrailsConfig({ mode: "ask", llmReview: { enabled: false }, extraDangerousFragments: [] });
    expect(cfg.mode).toBeDefined();
    expect(cfg.llmReview).toBeDefined();
    expect(Array.isArray(cfg.extraDangerousFragments)).toBe(true);
  });
});
