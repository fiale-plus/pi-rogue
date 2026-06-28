import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_BOARD_SMOKE_MODELS, runBudgetBoardSmoke } from "./budget-board-smoke.js";

describe("budget-board smoke", () => {
  it("validates the profile posture without live model calls or global config writes", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-budget-board-smoke-test-"));
    try {
      const result = runBudgetBoardSmoke({ tempRoot: root, models: DEFAULT_BUDGET_BOARD_SMOKE_MODELS });

      expect(result.schema).toBe("pi-rogue.budget-board-smoke.v1");
      expect(result.ok).toBe(true);
      expect(result.noLiveModelCalls).toBe(true);
      expect(result.profile).toBe("budget-board");
      expect(result.driverRecommendation).toBe("openai-codex/gpt-5.5-mini");
      expect(result.advisorModel).toBe("openai-codex/gpt-5.5");
      expect(result.checks.map((item) => [item.id, item.status])).toEqual([
        ["strong-advisor-model", "pass"],
        ["driver-recommendation-only", "pass"],
        ["no-live-model-calls", "pass"],
        ["writes-advisor-config-only", "pass"],
        ["profile-enabled", "pass"],
        ["board-modes", "pass"],
        ["policy-status", "pass"],
      ]);
      expect(existsSync(join(root, "advisor", "config.json"))).toBe(true);
      expect(existsSync(join(root, "config.json"))).toBe(false);
      expect(existsSync(join(root, "router", "config.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when the strong advisor model is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-budget-board-smoke-missing-"));
    try {
      const result = runBudgetBoardSmoke({
        tempRoot: root,
        models: [{ provider: "openai-codex", id: "gpt-5.5-mini", input: ["text"] }],
      });

      expect(result.ok).toBe(false);
      expect(result.advisorModel).toMatch(/no preferred strong advisor model/);
      expect(result.checks.find((item) => item.id === "strong-advisor-model")?.status).toBe("fail");
      expect(result.checks.find((item) => item.id === "profile-enabled")?.detail).toMatch(/strong advisor model is missing/);
      expect(existsSync(join(root, "advisor", "config.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
