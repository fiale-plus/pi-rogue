import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  completeSimple,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { createFileFusionTraceStore, runFusionCompletion, type FusionBrokerPublisher, type FusionCompleter } from "./runner.js";
import { loadFusionRecipes, parseModelRef } from "./recipe.js";
import type { FusionRecipe, FusionRunResult } from "./types.js";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function envEnabled(name: string): boolean {
  return ENABLED_VALUES.has(String(process.env[name] ?? "").trim().toLowerCase());
}

function envDisabled(name: string): boolean {
  return DISABLED_VALUES.has(String(process.env[name] ?? "").trim().toLowerCase());
}

function fusionEnabled(): boolean {
  return envEnabled("PI_ROGUE_FUSION_ENABLED") && !envDisabled("PI_ROGUE_FUSION_ENABLED");
}

function usageZero(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    cost: {
      input: a.cost.input + (b.cost?.input ?? 0),
      output: a.cost.output + (b.cost?.output ?? 0),
      cacheRead: a.cost.cacheRead + (b.cost?.cacheRead ?? 0),
      cacheWrite: a.cost.cacheWrite + (b.cost?.cacheWrite ?? 0),
      total: a.cost.total + (b.cost?.total ?? 0),
    },
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content.map((block) => block.type === "text" ? block.text : "").join("\n").trim();
}

function makeOutput(model: Model<Api>, text: string, usage: Usage, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function textStream(model: Model<Api>, promise: Promise<{ text: string; result?: FusionRunResult; usage?: Usage }>, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let output = makeOutput(model, "", usageZero());
    try {
      stream.push({ type: "start", partial: output });
      const completed = await promise;
      const text = completed.text;
      output = makeOutput(model, "", completed.usage ?? usageZero());
      output.diagnostics = completed.result ? [{
        type: "info",
        message: `fusion ${completed.result.recipe_id} run ${completed.result.run_id}${completed.result.degraded ? ` (${completed.result.degraded})` : ""}`,
      } as any] : undefined;
      output.content.push({ type: "text", text: "" });
      const contentIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (output.content[contentIndex]?.type === "text") output.content[contentIndex].text = text;
      stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex, content: text, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output = makeOutput(model, "", usageZero(), signal?.aborted ? "aborted" : "error", message);
      stream.push({ type: "error", reason: output.stopReason as "error" | "aborted", error: output });
      stream.end();
    }
  })();
  return stream;
}

function createCompleter(getCtx: () => any, usageSink: { usage: Usage }): FusionCompleter {
  return {
    async complete(request) {
      const ctx = getCtx();
      const ref = parseModelRef(request.model);
      if (ref.provider === "fusion") throw new Error(`recursive fusion model is disabled: ${request.model}`);
      const found = ctx.modelRegistry?.find?.(ref.provider, ref.model);
      if (!found) throw new Error(`model not found: ${request.model}`);
      const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(found);
      if (!auth?.ok) throw new Error(`model auth unavailable for ${request.model}: ${auth?.error ?? "unknown error"}`);
      const response = await completeSimple(found, request.context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        reasoning: request.reasoning,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      usageSink.usage = addUsage(usageSink.usage, response.usage);
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
      }
      return assistantText(response) || "(empty)";
    },
  };
}

function createBrokerPublisher(pi: ExtensionAPI): FusionBrokerPublisher | undefined {
  const broker = (pi as any).__piRogueContextBroker;
  if (typeof broker?.publish !== "function") return undefined;
  return {
    publish(result, summary) {
      const compactPayload = {
        status: result.status,
        recipe_id: result.recipe_id,
        run_id: result.run_id,
        degraded: result.degraded,
        analysis: result.analysis,
        panel: { ok: result.responses.length, failed: result.failed_models.length },
        failed_models: result.failed_models,
        judge_error: result.judge_error,
        trace_path: result.trace_path,
      };
      broker.publish({
        kind: "fusion_result",
        payload: JSON.stringify(compactPayload, null, 2),
        summary,
        tags: ["fusion", result.status, ...(result.degraded ? [result.degraded] : [])],
        paths: result.trace_path ? [result.trace_path] : [],
        tier: result.status === "error" || result.degraded ? "hot" : "warm",
      });
    },
  };
}

function traceDir(ctx: any): string {
  const configured = process.env.PI_ROGUE_FUSION_TRACE_DIR;
  return configured ? resolve(configured) : join(String(ctx.cwd ?? process.cwd()), ".pi", "fusion", "runs");
}

function registerFusionProviderForContext(pi: ExtensionAPI, ctx: any, getCtx: () => any = () => ctx): { recipes: FusionRecipe[]; errors: string[]; path?: string } {
  const loaded = loadFusionRecipes(String(ctx.cwd ?? process.cwd()));
  if (loaded.recipes.length === 0) {
    try { pi.unregisterProvider("fusion"); } catch {}
    return loaded;
  }

  const recipesById = new Map(loaded.recipes.map((recipe) => [recipe.id, recipe]));
  pi.registerProvider("fusion", {
    name: "Pi-Rogue Fusion",
    baseUrl: "fusion://pi-rogue",
    apiKey: "fusion",
    api: "pi-rogue-fusion",
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const recipe = recipesById.get(model.id);
      if (!recipe) return textStream(model, Promise.reject(new Error(`fusion recipe not found: ${model.id}`)), options?.signal);
      const usageSink = { usage: usageZero() };
      const promise = runFusionCompletion(recipe, context, {
        completer: createCompleter(getCtx, usageSink),
        traceStore: createFileFusionTraceStore(traceDir(getCtx())),
        broker: createBrokerPublisher(pi),
        signal: options?.signal,
      }).then((result) => {
        if (result.status === "error") throw new Error(result.error ?? "fusion failed");
        return { text: result.final_text || "(empty fusion response)", result, usage: usageSink.usage };
      });
      return textStream(model, promise, options?.signal);
    },
    models: loaded.recipes.map((recipe) => ({
      id: recipe.id,
      name: `Fusion: ${recipe.id}`,
      api: "pi-rogue-fusion",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: recipe.max_completion_tokens ?? 4096,
    })),
  });
  return loaded;
}

function statusText(ctx: any): string {
  const loaded = loadFusionRecipes(String(ctx.cwd ?? process.cwd()));
  const recipeLines = loaded.recipes.map((recipe) => `- fusion/${recipe.id}: model=${recipe.model} panel=${recipe.analysis_models.join(",")}`);
  return [
    `fusion: ${fusionEnabled() ? "enabled" : "disabled"}`,
    `recipes: ${loaded.path ?? "not found"}`,
    `trace dir: ${traceDir(ctx)}`,
    loaded.errors.length ? `errors:\n${loaded.errors.map((error) => `- ${error}`).join("\n")}` : "",
    recipeLines.length ? recipeLines.join("\n") : "no recipes loaded",
  ].filter(Boolean).join("\n");
}

export function registerFusion(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueFusionRegistered) return;
  p.__piRogueFusionRegistered = true;

  pi.registerCommand("fusion", {
    description: "Opt-in Fusion composite model provider. Usage: /fusion status|reload. Enable auto-registration with PI_ROGUE_FUSION_ENABLED=1.",
    getArgumentCompletions: (prefix: string) => {
      const q = prefix.trimStart().toLowerCase();
      return ["status", "reload"].filter((value) => value.startsWith(q)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().split(/\s+/)[0] || "status";
      if (cmd === "reload") {
        const loaded = registerFusionProviderForContext(pi, ctx);
        ctx.ui.notify([
          loaded.errors.length ? "fusion recipes failed" : `fusion provider loaded ${loaded.recipes.length} recipe(s)`,
          statusText(ctx),
        ].join("\n"), loaded.errors.length ? "error" : "info");
        return;
      }
      if (cmd === "status" || cmd === "show") {
        ctx.ui.notify(statusText(ctx), "info");
        return;
      }
      ctx.ui.notify("Usage: /fusion status|reload", "error");
    },
  });

  const getRuntimeContext = () => p.__piRogueFusionContext ?? { cwd: process.cwd() };
  if (fusionEnabled()) registerFusionProviderForContext(pi, { cwd: process.cwd() }, getRuntimeContext);

  pi.on("session_start", (_event, ctx) => {
    p.__piRogueFusionContext = ctx;
    if (!fusionEnabled()) return;
    const loaded = registerFusionProviderForContext(pi, ctx, getRuntimeContext);
    if (loaded.errors.length > 0) ctx.ui?.notify?.(`fusion recipe load failed:\n${loaded.errors.join("\n")}`, "warning");
  });
}

export default function fusionExtension(pi: ExtensionAPI): void {
  registerFusion(pi);
}
