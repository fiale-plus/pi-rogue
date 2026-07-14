import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { disposableMergedSignal, parseJudgeAnalysis, runFusionCompletion } from "./runner.js";
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
  afterEach(() => vi.useRealTimers());

  it("disposes timeout resources after success, throw, and retry attempts", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let panelAttempts = 0;
    const timedRecipe: FusionRecipe = { ...recipe, analysis_models: ["panel/a"], min_panel_success: 1, timeout_ms: 10_000 };
    const result = await runFusionCompletion(timedRecipe, context, {
      completer: {
        async complete(request) {
          if (request.signal) signals.push(request.signal);
          if (request.model === "panel/a" && panelAttempts++ === 0) throw new Error("context_length_exceeded");
          if (request.model === "panel/a") return "Reviewed the implementation and found a concrete cleanup risk.";
          if (request.context.systemPrompt?.includes("Return ONLY valid JSON")) return "not json";
          return "Final answer";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(panelAttempts).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes the timer and parent listener on parent abort and timeout", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const parentMerged = disposableMergedSignal(parent.signal, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    parent.abort(new Error("parent stopped"));
    expect(parentMerged.signal?.aborted).toBe(true);
    expect(parentMerged.signal?.reason).toBe(parent.signal.reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    parentMerged.dispose();

    const timeoutParent = new AbortController();
    const timeoutRemove = vi.spyOn(timeoutParent.signal, "removeEventListener");
    const timed = disposableMergedSignal(timeoutParent.signal, 250);
    vi.advanceTimersByTime(250);
    expect(timed.signal?.aborted).toBe(true);
    expect(String(timed.signal?.reason)).toContain("timeout after 250ms");
    expect(timeoutRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an instant completion process exit before the configured timeout", () => {
    const runnerUrl = pathToFileURL(join(process.cwd(), "packages", "fusion", "src", "runner.ts")).href;
    const program = `
      import { runFusionCompletion } from ${JSON.stringify(runnerUrl)};
      const recipe = { schema: "pi-rogue.fusion.recipe.v1", kind: "fusion", id: "exit-smoke", model: "judge/model", analysis_models: ["panel/a"], min_panel_success: 1, timeout_ms: 5000 };
      const context = { messages: [{ role: "user", timestamp: Date.now(), content: "test" }] };
      const completer = { async complete(request) {
        if (request.model === "panel/a") return "Reviewed the implementation and found a concrete cleanup risk.";
        if (request.context.systemPrompt?.includes("Return ONLY valid JSON")) return "not json";
        return "Final answer";
      } };
      const result = await runFusionCompletion(recipe, context, { completer });
      if (result.status !== "ok") process.exit(2);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 3_000,
    });
    expect(child.status, `${child.error?.message ?? ""}\n${child.stderr}`).toBe(0);
  });

  it("runs panel, judge, and synthesis", async () => {
    const calls: string[] = [];
    const panelSystemPrompts: string[] = [];
    const contextWithSystem: Context = { ...context, systemPrompt: "Respect repo AGENTS.md constraints." };
    const result = await runFusionCompletion(recipe, contextWithSystem, {
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
          return `answer from ${request.model}: reviewed the diff and found one concrete migration risk in auth handling.`;
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
    expect(panelSystemPrompts.every((prompt) => prompt.includes("Respect repo AGENTS.md constraints."))).toBe(true);
    expect(panelSystemPrompts.every((prompt) => prompt.includes("Do not call tools, edit files, write state, run commands"))).toBe(true);
  });

  it("keeps minority panel failures recoverable", async () => {
    const partialRecipe = { ...recipe, analysis_models: ["panel/a", "panel/b", "panel/c"] };
    const result = await runFusionCompletion(partialRecipe, context, {
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
    expect(result.responses).toHaveLength(2);
    expect(result.failed_models).toMatchObject([{ model: "panel/b", error: "rate limited" }]);
    expect(result.degraded).toBe("judge_failed");
    expect(result.final_text).toBe("Panel-only final");
  });

  it("retries a panel with a shorter context when the first attempt exceeds the window", async () => {
    const panelCalls: Record<string, number> = { "panel/a": 0, "panel/b": 0 };
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-2a",
      completer: {
        async complete(request) {
          if (request.model.startsWith("panel/")) {
            panelCalls[request.model] += 1;
            if (request.model === "panel/a" && panelCalls[request.model] === 1) {
              throw new Error('{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model.","param":"input"}}');
            }
            return `answer from ${request.model}`;
          }
          if (request.model === "judge/model" && request.context.systemPrompt?.includes("Return ONLY valid JSON")) {
            return JSON.stringify({
              consensus: ["Fusion helps expensive architecture decisions"],
              contradictions: [],
              partial_coverage: [],
              unique_insights: [],
              blind_spots: [],
              confidence: "medium",
            });
          }
          if (request.model === "judge/model") return "Final synthesized answer";
          return "should not happen";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.responses).toHaveLength(2);
    expect(panelCalls["panel/a"]).toBe(2);
    expect(panelCalls["panel/b"]).toBe(1);
    expect(result.final_text).toBe("Final synthesized answer");
  });

  it("retries context overflow when the provider code is only present in the cause", async () => {
    const panelCalls: Record<string, number> = { "panel/a": 0, "panel/b": 0 };
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-2a-cause",
      completer: {
        async complete(request) {
          if (request.model.startsWith("panel/")) {
            panelCalls[request.model] += 1;
            if (request.model === "panel/a" && panelCalls[request.model] === 1) {
              throw new Error("provider request failed", {
                cause: { error: { type: "invalid_request_error", code: "context_length_exceeded", message: "too many tokens" } },
              });
            }
            return `answer from ${request.model}`;
          }
          if (request.model === "judge/model" && request.context.systemPrompt?.includes("Return ONLY valid JSON")) {
            return JSON.stringify({
              consensus: ["Fusion helps expensive architecture decisions"],
              contradictions: [],
              partial_coverage: [],
              unique_insights: [],
              blind_spots: [],
              confidence: "medium",
            });
          }
          if (request.model === "judge/model") return "Final synthesized answer";
          return "should not happen";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(panelCalls["panel/a"]).toBe(2);
    expect(panelCalls["panel/b"]).toBe(1);
  });

  it("skips judge and synthesis when all panel responses are non-substantive", async () => {
    const calls: string[] = [];
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-2b",
      completer: {
        async complete(request) {
          calls.push(request.model);
          if (request.model.startsWith("panel/")) return "I’ll read the file and report back.";
          return "should not run";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.degraded).toBe("panel_only");
    expect(result.responses).toHaveLength(2);
    expect(result.final_text).toContain("Fusion bypassed judge/synthesis");
    expect(calls.filter((call) => call === "judge/model").length).toBe(0);
  });

  it("skips synthesis when judge hits usage limit", async () => {
    const calls: string[] = [];
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-2c",
      completer: {
        async complete(request) {
          calls.push(request.model);
          if (request.model.startsWith("panel/")) return "Reviewed the change and found one risk around input validation.";
          if (request.model === "judge/model") throw new Error("usage_limit_reached");
          return "synthesis should be skipped";
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(result.degraded).toBe("judge_failed");
    expect(result.judge_error).toContain("usage_limit_reached");
    expect(result.final_text).toContain("judge usage limit reached");
    expect(calls.filter((call) => call === "judge/model")).toHaveLength(1);
  });

  it("fails when all panel models fail", async () => {
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-3",
      completer: { async complete() { throw new Error("down"); } },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("panel quorum not met");
    expect(result.error).toContain("panel models total=2, successful=0");
    expect(result.error).toContain("minimum required 2");
    expect(result.error).toContain("dominant failures: provider_error(2)");
    expect((result.effective_params as any).min_panel_success).toBe(2);
    expect(result.failed_models).toHaveLength(2);
  });

  it("classifies model timeouts separately from aborts", async () => {
    const result = await runFusionCompletion(recipe, context, {
      runId: "run-timeout",
      completer: { async complete() { throw new Error("timeout after 250ms"); } },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("dominant failures: timeout(2)");
    expect(result.failed_models.every((failed) => failed.details?.category === "timeout")).toBe(true);
  });

  it("fails when near-all panel models fail and blocks fusion", async () => {
    const nearAllRecipe = { ...recipe, analysis_models: ["panel/a", "panel/b", "panel/c"], id: "near-all-fusion" };
    const result = await runFusionCompletion(nearAllRecipe, context, {
      runId: "run-4",
      completer: {
        async complete(request) {
          if (request.model === "panel/c") return "panel c answer";
          if (request.model === "panel/a") throw new Error("usage_limit_reached");
          throw new Error("context length issue");
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("panel quorum not met");
    expect(result.error).toContain("panel models total=3, successful=1");
    expect(result.error).toContain("minimum required 2");
    expect(result.error).toContain("panel/a");
    expect(result.error).toContain("panel/b");
    expect(result.responses).toHaveLength(1);
    expect(result.failed_models).toHaveLength(2);
  });

  it("summarizes external provider failure fields in error diagnostics", async () => {
    const nearAllRecipe = {
      ...recipe,
      id: "provider-diagnostics-fusion",
      analysis_models: ["panel/a", "panel/b", "panel/c", "panel/d"],
    };

    const result = await runFusionCompletion(nearAllRecipe, context, {
      runId: "run-5",
      completer: {
        async complete(request) {
          if (request.model === "panel/a") return "panel a answer";
          if (request.model === "panel/b") throw new Error(`{"type":"error","code":"usage_limit_reached","status_code":429,"message":"account usage limit reached","headers":{"X-Codex-Plan-Type":"pro","X-Codex-Primary-Reset-After-Seconds":"180","X-Codex-Primary-Reset-At":"1719000000"}}`);
          if (request.model === "panel/c") throw new Error("usage_limit_reached");
          throw new Error("context too long");
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("panel quorum not met");
    expect(result.error).toContain("minimum required 3");
    expect(result.error).toContain("status=429");
    expect(result.error).toContain("plan=pro");
    expect(result.error).toContain("reset_in=180s");
    expect(result.error).toContain("reset_at=1719000000");
    expect(result.error).toContain("usage_limit_reached");
    expect(result.failed_models).toHaveLength(3);
  });

  it("respects recipe-configured min_panel_success", async () => {
    const strictRecipe = {
      ...recipe,
      id: "strict-fusion",
      analysis_models: ["panel/a", "panel/b", "panel/c", "panel/d"],
      min_panel_success: 3,
    };
    const result = await runFusionCompletion(strictRecipe, context, {
      runId: "run-6",
      completer: {
        async complete(request) {
          if (request.model === "panel/d") throw new Error("quota exhausted");
          if (request.model === "panel/c") throw new Error("quota exhausted");
          return `panel ${request.model} answer`;
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("minimum required 3");
    expect(result.responses).toHaveLength(2);
    expect(result.failed_models).toHaveLength(2);
  });

  it("classifies rate limit vs usage limit with actionable cause", async () => {
    const strictRecipe = {
      ...recipe,
      id: "rate-limit-fusion",
      analysis_models: ["panel/a", "panel/b", "panel/c"],
      min_panel_success: 2,
    };

    const result = await runFusionCompletion(strictRecipe, context, {
      runId: "run-7",
      completer: {
        async complete(request) {
          if (request.model === "panel/a") throw new Error("rate limit exceeded");
          if (request.model === "panel/b") {
            const payload = JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                code: "rate_limit_exceeded",
                status: 429,
                message: "Model throttled",
              },
            });
            throw new Error(payload);
          }
          return "panel c answer";
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("dominant failures");
    expect(result.error).toContain("rate_limit(");
    expect(result.failed_models.map((item) => item.details?.category)).toContain("rate_limit");
  });

  it("preserves nested status/retry timing in diagnostics", async () => {
    const strictRecipe = {
      ...recipe,
      id: "retry-window-fusion",
      analysis_models: ["panel/a", "panel/b", "panel/c"],
      min_panel_success: 2,
    };

    const result = await runFusionCompletion(strictRecipe, context, {
      runId: "run-9",
      completer: {
        async complete(request) {
          if (request.model === "panel/a") {
            const payload = JSON.stringify({
              type: "error",
              error: {
                type: "error",
                code: "usage_limit_reached",
                status: 429,
                message: "usage limit reached",
                headers: {
                  "Retry-After": "25",
                  "X-Codex-Primary-Reset-After-Seconds": "120",
                  "X-Codex-Plan-Type": "pro",
                },
              },
            });
            throw new Error(payload);
          }
          if (request.model === "panel/b") throw new Error("quota exhausted");
          return "panel c answer";
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("minimum required 2");
    expect(result.error).toContain("status=429");
    expect(result.error).toContain("retry_after=25");
    expect(result.error).toContain("reset_in=120s");
    expect(result.error).toContain("plan=pro");
    expect(result.failed_models).toHaveLength(2);
    expect(result.failed_models.map((item) => item.details?.status_code)).toContain(429);
    expect(result.failed_models[0]?.details?.category).toMatch(/usage_limit_reached|provider_error/);
  });

  it("classifies auth and network failures for per-model diagnostics", async () => {
    const strictRecipe = {
      ...recipe,
      id: "auth-network-fusion",
      analysis_models: ["panel/a", "panel/b", "panel/c"],
      min_panel_success: 2,
    };

    const result = await runFusionCompletion(strictRecipe, context, {
      runId: "run-8",
      completer: {
        async complete(request) {
          if (request.model === "panel/a") throw new Error("401 unauthorized: invalid api key");
          if (request.model === "panel/b") throw new Error("ENOTFOUND api.example.com");
          return "panel c answer";
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("minimum required 2");
    expect(result.failed_models).toHaveLength(2);
    const categories = new Set(result.failed_models.map((item) => item.details?.category));
    expect(categories).toContain("auth_error");
    expect(categories).toContain("network_error");
    expect(result.error).toContain("panel/a");
    expect(result.error).toContain("panel/b");
  });

  it("parses judge JSON with fenced repair", () => {
    const analysis = parseJudgeAnalysis("```json\n{\"consensus\":[\"x\"],\"contradictions\":[],\"partial_coverage\":[],\"unique_insights\":[],\"blind_spots\":[],\"confidence\":\"high\"}\n```");
    expect(analysis?.confidence).toBe("high");
    expect(analysis?.consensus).toEqual(["x"]);
  });
});
