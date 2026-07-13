import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} from "@earendil-works/pi-ai/compat";
import { createFileFusionTraceStore, runFusionCompletion, type FusionBrokerPublisher, type FusionCompleter } from "./runner.js";
import { defaultFusionRecipeWritePath, loadFusionRecipes, parseModelRef, validateFusionRecipes } from "./recipe.js";
import type { FusionRecipe, FusionRunResult } from "./types.js";


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
      const failedText = signal?.aborted
        ? `Fusion aborted: ${message}`
        : `Fusion failed: ${message}`;
      output = makeOutput(model, failedText, usageZero(), signal?.aborted ? "aborted" : "error", message);
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

function cwdOf(ctx: any): string {
  return String(ctx?.cwd ?? process.cwd());
}

function traceDir(_ctx: any): string {
  const configured = process.env.PI_ROGUE_FUSION_TRACE_DIR;
  return configured ? resolve(configured) : join(homedir(), ".pi", "agent", "pi-rogue", "fusion", "runs");
}

function fusionFailureMessage(result: FusionRunResult): string {
  const failed = result.failed_models
    .slice(0, 3)
    .map((item) => `${item.model}: ${item.error}`)
    .join("; ");
  return [
    result.error ?? "fusion failed",
    failed ? `failed models: ${failed}` : "",
    result.trace_path ? `trace: ${result.trace_path}` : "",
  ].filter(Boolean).join("\n");
}

function recipePathFor(ctx: any): string {
  return defaultFusionRecipeWritePath(cwdOf(ctx));
}

function configuredModels(ctx: any): string[] {
  const models = ctx?.modelRegistry?.getAvailable?.() ?? ctx?.modelRegistry?.getAll?.() ?? [];
  const refs = new Set<string>();
  for (const model of models) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    const supportsText = !Array.isArray(model?.input) || model.input.includes("text");
    if (!provider || !id || provider === "fusion" || !supportsText) continue;
    refs.add(`${provider}/${id}`);
  }
  return [...refs].sort();
}

function formatConfiguredModels(ctx: any, limit = 12): string {
  const models = configuredModels(ctx);
  if (models.length === 0) return "No scoped text models were visible in this Pi session yet.";
  const shown = models.slice(0, limit).map((model) => `- ${model}`);
  if (models.length > limit) shown.push(`…and ${models.length - limit} more. Use /pi-rogue-router models for the full active router profile.`);
  return shown.join("\n");
}

function readRecipesForEdit(path: string): { recipes: FusionRecipe[]; errors: string[] } {
  if (!existsSync(path)) return { recipes: [], errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const result = validateFusionRecipes(parsed);
    return result.ok ? { recipes: result.recipes, errors: [] } : { recipes: [], errors: result.errors };
  } catch (error) {
    return { recipes: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function writeRecipes(path: string, recipes: FusionRecipe[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ recipes }, null, 2)}\n`, "utf8");
}

function parseConfigureFlags(parts: string[]): { values: string[]; maxTokens?: number; timeoutMs?: number; perModelTimeoutMs?: number; temperature?: number; errors: string[] } {
  const values: string[] = [];
  const errors: string[] = [];
  let maxTokens: number | undefined;
  let timeoutMs: number | undefined;
  let perModelTimeoutMs: number | undefined;
  let temperature: number | undefined;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const readValue = () => {
      const eq = part.indexOf("=");
      if (eq >= 0) return part.slice(eq + 1);
      i += 1;
      return parts[i];
    };
    if (part === "--tokens" || part.startsWith("--tokens=")) {
      const n = Number(readValue());
      if (!Number.isInteger(n) || n <= 0) errors.push("--tokens must be a positive integer");
      else maxTokens = n;
      continue;
    }
    if (part === "--timeout-ms" || part.startsWith("--timeout-ms=")) {
      const n = Number(readValue());
      if (!Number.isInteger(n) || n <= 0) errors.push("--timeout-ms must be a positive integer");
      else timeoutMs = n;
      continue;
    }
    if (part === "--per-model-timeout-ms" || part.startsWith("--per-model-timeout-ms=")) {
      const n = Number(readValue());
      if (!Number.isInteger(n) || n <= 0) errors.push("--per-model-timeout-ms must be a positive integer");
      else perModelTimeoutMs = n;
      continue;
    }
    if (part === "--temperature" || part.startsWith("--temperature=")) {
      const n = Number(readValue());
      if (!Number.isFinite(n) || n < 0 || n > 2) errors.push("--temperature must be a number from 0 to 2");
      else temperature = n;
      continue;
    }
    if (part.startsWith("--")) {
      errors.push(`unknown flag: ${part}`);
      continue;
    }
    values.push(part);
  }
  return { values, maxTokens, timeoutMs, perModelTimeoutMs, temperature, errors };
}

function configureHelp(ctx: any): string {
  const path = recipePathFor(ctx);
  return [
    "Fusion configuration writes OpenRouter-style comparable-panel recipes.",
    "",
    `recipe file: ${path}`,
    "",
    "Commands:",
    "- /pi-rogue-fusion configure add <id> <synthesis-model> <analysis-model...> [--tokens N] [--temperature 0..2] [--timeout-ms N] [--per-model-timeout-ms N]",
    "- /pi-rogue-fusion configure edit <id> <synthesis-model> <analysis-model...> [--tokens N] [--temperature 0..2] [--timeout-ms N] [--per-model-timeout-ms N]",
    "- /pi-rogue-fusion configure remove <id>",
    "",
    "Example:",
    "  /pi-rogue-fusion configure add hard-judge openai-codex/gpt-5.5 openai-codex/gpt-5.5 openai-codex/gpt-5.3-codex-spark --tokens 1200",
    "",
    "Scoped text models visible to this session:",
    formatConfiguredModels(ctx),
    "",
    "After changing recipes, run /pi-rogue-fusion reload or restart Pi so fusion/<id> models are registered. Then try those model refs in /pi-rogue-router models or a router profile.",
    "",
    "Natural-language configure intent will be added later; for now use add/edit/remove explicitly.",
  ].join("\n");
}

function configureFusion(args: string[], ctx: any): string {
  const [intentRaw, ...rest] = args;
  const intent = (intentRaw ?? "").toLowerCase();
  if (!intent || intent === "help" || intent === "show") return configureHelp(ctx);

  const path = recipePathFor(ctx);
  const current = readRecipesForEdit(path);
  if (current.errors.length > 0) {
    return [`Cannot edit fusion recipes until the current file is valid: ${path}`, ...current.errors.map((error) => `- ${error}`)].join("\n");
  }

  if (intent === "remove" || intent === "delete") {
    const id = rest[0];
    if (!id) return "Usage: /pi-rogue-fusion configure remove <id>";
    const before = current.recipes.length;
    const recipes = current.recipes.filter((recipe) => recipe.id !== id);
    if (recipes.length === before) return `No fusion recipe found with id ${id}.`;
    writeRecipes(path, recipes);
    return [`Removed fusion/${id}.`, `recipe file: ${path}`, "Run /pi-rogue-fusion reload or restart Pi to refresh registered Fusion models."].join("\n");
  }

  if (intent !== "add" && intent !== "edit") {
    return [
      `I understood configure intent "${intentRaw}", but this first pass supports explicit add/edit/remove only.`,
      "",
      configureHelp(ctx),
    ].join("\n");
  }

  const id = rest[0];
  const synthesisModel = rest[1];
  const parsed = parseConfigureFlags(rest.slice(2));
  const analysisModels = parsed.values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (!id || !synthesisModel || analysisModels.length === 0) {
    return `Usage: /pi-rogue-fusion configure ${intent} <id> <synthesis-model> <analysis-model...> [--tokens N] [--temperature 0..2] [--timeout-ms N]`;
  }
  if (parsed.errors.length > 0) return parsed.errors.join("\n");

  const recipe = {
    schema: "pi-rogue.fusion.recipe.v1",
    kind: "fusion",
    id,
    model: synthesisModel,
    analysis_models: analysisModels,
    ...(parsed.maxTokens !== undefined ? { max_completion_tokens: parsed.maxTokens } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeout_ms: parsed.timeoutMs } : {}),
    ...(parsed.perModelTimeoutMs !== undefined ? { per_model_timeout_ms: parsed.perModelTimeoutMs } : {}),
  };
  const nextRecipes = intent === "edit"
    ? current.recipes.filter((item) => item.id !== id)
    : current.recipes;
  if (intent === "add" && nextRecipes.some((item) => item.id === id)) {
    return `fusion/${id} already exists. Use /pi-rogue-fusion configure edit ${id} ... to replace it.`;
  }
  const result = validateFusionRecipes({ recipes: [...nextRecipes, recipe] });
  if (!result.ok) return result.errors.join("\n");
  writeRecipes(path, result.recipes);
  return [
    `${intent === "edit" ? "Updated" : "Added"} fusion/${id}.`,
    `recipe file: ${path}`,
    "Run /pi-rogue-fusion reload or restart Pi to register/refresh the model.",
    "Then try fusion model refs in /pi-rogue-router models or your router profile if you want routing suggestions to include them.",
  ].join("\n");
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
        if (result.status === "error") throw new Error(fusionFailureMessage(result));
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
  const loaded = loadFusionRecipes(cwdOf(ctx));
  const recipeLines = loaded.recipes.map((recipe) => `- fusion/${recipe.id}: model=${recipe.model} panel=${recipe.analysis_models.join(",")}`);
  return [
    "fusion: active (recipes loaded; scoped aliases available)",
    `recipes: ${loaded.path ?? "not found"}`,
    `configure path: ${recipePathFor(ctx)}`,
    `trace dir: ${traceDir(ctx)}`,
    loaded.errors.length ? `errors:\n${loaded.errors.map((error) => `- ${error}`).join("\n")}` : "",
    recipeLines.length ? recipeLines.join("\n") : "no recipes loaded; run /pi-rogue-fusion configure to add one",
  ].filter(Boolean).join("\n");
}

export function registerFusion(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueFusionRegistered) return;
  p.__piRogueFusionRegistered = true;

  pi.registerCommand("pi-rogue-fusion", {
    description: "Fusion composite model provider. Usage: /pi-rogue-fusion status|reload|configure|on|off. Models register when recipes exist.",
    getArgumentCompletions: (prefix: string, ctx?: any) => {
      const input = prefix.trimStart();
      const parts = input.split(/\s+/).filter(Boolean);
      const q = input.endsWith(" ") ? "" : (parts.at(-1) ?? "").toLowerCase();
      if (parts[0] === "configure") {
        if (parts.length <= 2) {
          return ["add", "edit", "remove", "help"].filter((value) => value.startsWith(q)).map((value) => ({ value, label: value }));
        }
        const models = ctx ? configuredModels(ctx) : [];
        return models.filter((value) => value.toLowerCase().startsWith(q)).slice(0, 20).map((value) => ({ value, label: value }));
      }
      return ["status", "reload", "configure", "on", "off"].filter((value) => value.startsWith(q)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0] || "status";
      if (cmd === "reload") {
        const loaded = registerFusionProviderForContext(pi, ctx);
        ctx.ui.notify([
          loaded.errors.length ? "fusion recipes failed" : `fusion provider loaded ${loaded.recipes.length} recipe(s)`,
          statusText(ctx),
        ].join("\n"), loaded.errors.length ? "error" : "info");
        return;
      }
      if (cmd === "configure") {
        ctx.ui.notify(configureFusion(parts.slice(1), ctx), "info");
        return;
      }
      if (cmd === "status" || cmd === "show") {
        ctx.ui.notify(statusText(ctx), "info");
        return;
      }
      if (cmd === "off") {
        try { pi.unregisterProvider("fusion"); } catch {}
        ctx.ui.notify("fusion provider disabled", "info");
        return;
      }
      if (cmd === "on") {
        const loaded = registerFusionProviderForContext(pi, ctx, getRuntimeContext);
        ctx.ui.notify(
          loaded.errors.length ? `fusion load failed:\n${loaded.errors.join("\n")}` : `fusion provider re-enabled (loaded ${loaded.recipes.length} recipe(s))`,
          loaded.errors.length ? "error" : "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /pi-rogue-fusion status|reload|configure|on|off", "error");
    },
  });

  const getRuntimeContext = () => p.__piRogueFusionContext ?? { cwd: process.cwd() };
  registerFusionProviderForContext(pi, { cwd: process.cwd() }, getRuntimeContext);

  pi.on("session_start", (_event, ctx) => {
    p.__piRogueFusionContext = ctx;
    const loaded = registerFusionProviderForContext(pi, ctx, getRuntimeContext);
    if (loaded.errors.length > 0) ctx.ui?.notify?.(`fusion recipe load failed:\n${loaded.errors.join("\n")}`, "warning");
  });
}

export default function fusionExtension(pi: ExtensionAPI): void {
  registerFusion(pi);
}
