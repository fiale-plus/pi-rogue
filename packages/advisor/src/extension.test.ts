import { describe, it, expect } from "vitest";
import {
  type AdvisorConfig,
  type AdvisorMode,
  SOTA_MODELS,
} from "./extension.js";

describe("SOTA_MODELS", () => {
  it("includes gpt-5.5 and claude-opus-4-6", () => {
    const ids = SOTA_MODELS.map((m) => `${m.provider}/${m.model}`);
    expect(ids).toContain("openai-codex/gpt-5.5");
    expect(ids).toContain("anthropic/claude-opus-4-6");
  });

  it("all have labels", () => {
    for (const model of SOTA_MODELS) {
      expect(model.label).toBeTruthy();
    }
  });
});

describe("AdvisorConfig", () => {
  it("has valid default values", () => {
    const config: AdvisorConfig = {
      enabled: true,
      mode: "tool",
      provider: "openai-codex",
      model: "gpt-5.5",
      fallbackModel: "claude-opus-4-6",
      reasoning: "medium",
      maxTokens: 900,
      cacheEnabled: true,
      logMetrics: true,
    };
    expect(config.enabled).toBe(true);
    expect(config.mode).toBe("tool");
    expect(config.model).toBe("gpt-5.5");
    expect(config.maxTokens).toBeGreaterThan(0);
  });

  it("accepts all valid modes", () => {
    const modes: AdvisorMode[] = ["tool", "prompt", "disabled"];
    for (const mode of modes) {
      const config: AdvisorConfig = {
        enabled: mode !== "disabled",
        mode,
        provider: "openai-codex",
        model: "gpt-5.5",
        fallbackModel: "claude-opus-4-6",
        reasoning: "medium",
        maxTokens: 900,
        cacheEnabled: true,
        logMetrics: true,
      };
      expect(config.mode).toBe(mode);
      expect(config.enabled).toBe(mode !== "disabled");
    }
  });
});
