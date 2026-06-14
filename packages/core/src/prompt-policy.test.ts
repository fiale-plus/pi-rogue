import { describe, expect, it } from "vitest";
import {
  PI_ROGUE_SYSTEM_PROMPT_VERSION,
  buildPiRogueSystemPromptV1,
  detectPiRoguePromptFamily,
} from "./prompt-policy.js";

describe("pi-rogue prompt policy", () => {
  it("classifies current and expected model-family targets conservatively", () => {
    expect(detectPiRoguePromptFamily("openai-codex", "gpt-5.5")).toBe("gpt");
    expect(detectPiRoguePromptFamily(undefined, "qwen3.6-35b-a3b-128k")).toBe("qwen_oss");
    expect(detectPiRoguePromptFamily("ollama", "llama3.3")).toBe("qwen_oss");
    expect(detectPiRoguePromptFamily("ollama", "gpt-oss-120b")).toBe("qwen_oss");
    expect(detectPiRoguePromptFamily(undefined, "gpt-oss-120b")).toBe("qwen_oss");
    expect(detectPiRoguePromptFamily(undefined, "glm-4.6")).toBe("open_weight_sota");
    expect(detectPiRoguePromptFamily("ollama", "glm-4.6")).toBe("open_weight_sota");
    expect(detectPiRoguePromptFamily(undefined, "minimax-m2")).toBe("open_weight_sota");
    expect(detectPiRoguePromptFamily("openai-compatible", "mystery-model")).toBe("unknown");
    expect(detectPiRoguePromptFamily("custom", "mystery-model")).toBe("unknown");
  });

  it("builds an opt-in universal prompt without vendor-persona leakage", () => {
    const prompt = buildPiRogueSystemPromptV1({
      provider: "openai-codex",
      model: "gpt-5.5",
      activeCommands: ["/advisor", "/goal", "/loop"],
      availableTools: ["read", "edit", "bash"],
      extraConstraints: ["Keep PR #140 unmerged until explicit approval."],
    });

    expect(prompt).toContain(PI_ROGUE_SYSTEM_PROMPT_VERSION);
    expect(prompt).toContain("Do not merge PRs");
    expect(prompt).toContain("Keep command names and behavior unchanged");
    expect(prompt).toContain("/advisor");
    expect(prompt).toContain("read");
    expect(prompt).toContain("GPT-family overlay");
    expect(prompt).not.toMatch(/Claude Fable|Anthropic's products|Mythos-class/i);
  });

  it("uses a shorter concrete overlay for Qwen and OSS-family models", () => {
    const prompt = buildPiRogueSystemPromptV1({ model: "qwen3.6-35b-a3b-128k" });

    expect(prompt).toContain("Qwen/OSS-family overlay");
    expect(prompt).toContain("prefer numbered steps over nested tags");
    expect(prompt).toContain("do not invent it");
    expect(prompt).toContain("smaller action/validation loops");
  });
});
