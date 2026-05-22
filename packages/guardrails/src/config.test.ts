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
    expect(result.extraDangerousFragments).toContain("rm");
    expect(result.extraDangerousFragments).toContain("sudo");
  });

  it("handles null/undefined fragments gracefully", () => {
    const result = normalizeGuardrailsConfig({
      extraDangerousFragments: null as unknown as string[],
    });
    expect(result.extraDangerousFragments).toEqual([]);
  });

  it("produces a valid config", () => {
    const cfg: GuardrailsConfig = normalizeGuardrailsConfig({ mode: "ask", llmReview: { enabled: false }, extraDangerousFragments: [] });
    expect(cfg.mode).toBeDefined();
    expect(cfg.llmReview).toBeDefined();
    expect(Array.isArray(cfg.extraDangerousFragments)).toBe(true);
  });
});
