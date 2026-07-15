import { describe, expect, it } from "vitest";
import { isFusionModelRef, parseModelRef, validateFusionRecipe, validateFusionRecipes } from "./recipe.js";

const baseRecipe = {
  schema: "pi-rogue.fusion.recipe.v1",
  kind: "fusion",
  id: "local-self2",
  model: "local/qwen3.6-35b-a3b-128k",
  analysis_models: ["local/qwen3.6-35b-a3b-128k", "local/qwen3.6-35b-a3b-128k"],
  max_completion_tokens: 900,
  temperature: 0.5,
};

describe("fusion recipe validation", () => {
  it("accepts OpenRouter-style comparable-panel recipes", () => {
    const result = validateFusionRecipe(baseRecipe);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.id).toBe("local-self2");
      expect(result.recipe.analysis_models).toHaveLength(2);
      expect(result.recipe.temperature).toBe(0.5);
    }
  });

  it("accepts explicit min_panel_success override", () => {
    const result = validateFusionRecipe({
      ...baseRecipe,
      min_panel_success: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.min_panel_success).toBe(1);
    }
  });

  it("rejects min_panel_success outside valid range", () => {
    const above = validateFusionRecipe({
      ...baseRecipe,
      min_panel_success: 3,
    });
    const below = validateFusionRecipe({
      ...baseRecipe,
      min_panel_success: 0,
    });

    expect(above.ok).toBe(false);
    expect(below.ok).toBe(false);
    if (!above.ok) expect(above.errors.join("\n")).toContain("min_panel_success must be <= 2");
    if (!below.ok) expect(below.errors.join("\n")).toContain("min_panel_success must be at least 1");
  });

  it("rejects explicit zero or negative execution timeouts", () => {
    const zero = validateFusionRecipe({ ...baseRecipe, timeout_ms: 0 });
    const negative = validateFusionRecipe({ ...baseRecipe, per_model_timeout_ms: -1 });

    expect(zero.ok).toBe(false);
    expect(negative.ok).toBe(false);
    if (!zero.ok) expect(zero.errors.join("\n")).toContain("timeout_ms must be a positive integer");
    if (!negative.ok) expect(negative.errors.join("\n")).toContain("per_model_timeout_ms must be a positive integer");
  });

  it("rejects role-pass and recursive fusion refs", () => {
    const result = validateFusionRecipe({
      ...baseRecipe,
      model: "fusion/other",
      passes: [{ role: "critic", model: "local/qwen" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("recursive");
  });

  it("rejects agent_fusion-only fields in kind=fusion", () => {
    const result = validateFusionRecipe({
      ...baseRecipe,
      analysis_agents: [{ agent: "reviewer", model: "local/qwen3.6-35b-a3b-128k" }],
      coordination: "pi-intercom",
      max_parallel: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("analysis_agents is not supported in kind=fusion");
      expect(result.errors.join("\n")).toContain("coordination is not supported in kind=fusion");
    }
  });

  it("requires provider/model model references", () => {
    expect(() => parseModelRef("qwen3.6-35b-a3b-128k")).toThrow(/provider\/model/);
    expect(parseModelRef("openai-codex/gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  });

  it("loads arrays or { recipes } and rejects duplicate ids", () => {
    const ok = validateFusionRecipes({ recipes: [baseRecipe] });
    expect(ok.ok).toBe(true);

    const dup = validateFusionRecipes([baseRecipe, baseRecipe]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join("\n")).toContain("duplicate id");
  });

  it("detects fusion provider refs", () => {
    expect(isFusionModelRef("fusion/local-self2")).toBe(true);
    expect(isFusionModelRef("openai/gpt")).toBe(false);
  });
});
