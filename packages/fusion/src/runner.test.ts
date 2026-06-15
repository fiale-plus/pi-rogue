import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { parseJudgeAnalysis, runFusionCompletion } from "./runner.js";
import type { FusionRecipe } from "./types.js";

const context: Context = {
  messages: [{ role: "user", timestamp: Date.now(), content: "Should we use Fusion for this architecture decision?" }],
};

const recipe: FusionRecipe = {
  schema: "pi-rogue.fusion.recipe.v1",
  kind: "fusion",
  id: "test-fusion",
  model: "judge/model",
  analysis_models: ["panel/a", "panel/b"],
  max_completion_tokens: 500,
};

describe("fusion runner", () => {
  it("runs panel, judge, and synthesis", async () => {
    const calls: string[] = [];
    const panelSystemPrompts: string[] = [];
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-1",
      completer: {
        async complete(request) {
          calls.push(request.model);
          if (request.model.startsWith("panel/")) panelSystemPrompts.push(request.context.systemPrompt ?? "");
          if (request.model === "judge/model" && request.context.systemPrompt?.includes("Return ONLY valid JSON")) {
            return JSON.stringify({
              consensus: ["Fusion helps expensive architecture decisions"],
              contradictions: [],
              partial_coverage: [],
              unique_insights: ["panel/a notes cost"],
              blind_spots: ["no benchmark yet"],
              confidence: "medium",
            });
          }
          if (request.model === "judge/model") return "Final synthesized answer";
          return `answer from ${request.model}`;
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.responses).toHaveLength(2);
    expect(result.analysis?.consensus).toContain("Fusion helps expensive architecture decisions");
    expect(result.final_text).toBe("Final synthesized answer");
    expect(calls).toEqual(expect.arrayContaining(["panel/a", "panel/b", "judge/model"]));
    expect(calls.filter((call) => call === "judge/model")).toHaveLength(2);
    expect(panelSystemPrompts).toHaveLength(2);
    expect(panelSystemPrompts.every((prompt) => prompt.includes("Do not call tools, edit files, write state, run commands"))).toBe(true);
  });

  it("keeps partial panel failures recoverable", async () => {
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-2",
      completer: {
        async complete(request) {
          if (request.model === "panel/b") throw new Error("rate limited");
          if (request.model === "judge/model" && request.context.systemPrompt?.includes("Return ONLY valid JSON")) return "not json";
          if (request.model === "judge/model") return "Panel-only final";
          return "panel ok";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.responses).toHaveLength(1);
    expect(result.failed_models).toEqual([{ model: "panel/b", error: "rate limited" }]);
    expect(result.degraded).toBe("judge_failed");
    expect(result.final_text).toBe("Panel-only final");
  });

  it("fails when all panel models fail", async () => {
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-3",
      completer: { async complete() { throw new Error("down"); } },
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("all panel models failed");
    expect(result.failed_models).toHaveLength(2);
  });

  it("parses judge JSON with fenced repair", () => {
    const analysis = parseJudgeAnalysis("```json\n{\"consensus\":[\"x\"],\"contradictions\":[],\"partial_coverage\":[],\"unique_insights\":[],\"blind_spots\":[],\"confidence\":\"high\"}\n```");
    expect(analysis?.confidence).toBe("high");
    expect(analysis?.consensus).toEqual(["x"]);
  });
});
