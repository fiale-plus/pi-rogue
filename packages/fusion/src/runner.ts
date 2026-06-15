import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  FusionFailedModel,
  FusionJudgeAnalysis,
  FusionPanelResponse,
  FusionRecipe,
  FusionRunResult,
} from "./types.js";

export interface FusionCompletionRequest {
  model: string;
  context: Context;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FusionCompleter {
  complete(request: FusionCompletionRequest): Promise<string>;
}

export interface FusionTraceStore {
  write(result: FusionRunResult): string | undefined;
}

export interface FusionBrokerPublisher {
  publish(result: FusionRunResult, summary: string): void;
}

export interface RunFusionOptions {
  completer: FusionCompleter;
  traceStore?: FusionTraceStore;
  broker?: FusionBrokerPublisher;
  now?: () => number;
  runId?: string;
  signal?: AbortSignal;
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (item && typeof item === "object" && "text" in item && typeof (item as any).text === "string") return (item as any).text;
      if (item && typeof item === "object" && "type" in item && (item as any).type === "image") return "[image]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

export function renderConversation(context: Context, maxChars = 16_000): string {
  const system = context.systemPrompt ? `system: ${context.systemPrompt}` : "";
  const messages = context.messages.map((message) => {
    if (message.role === "assistant") {
      const text = message.content.map((block) => block.type === "text" ? block.text : block.type === "toolCall" ? `[tool_call:${block.name}]` : "[thinking]").join("\n");
      return `assistant: ${text}`;
    }
    if (message.role === "toolResult") {
      return `tool_result(${message.toolName}): ${message.content.map((block) => textFromMessageContent([block])).join("\n")}`;
    }
    return `user: ${textFromMessageContent(message.content)}`;
  }).join("\n\n");
  const rendered = [system, messages].filter(Boolean).join("\n\n");
  if (rendered.length <= maxChars) return rendered;
  const head = rendered.slice(0, Math.floor(maxChars * 0.55));
  const tail = rendered.slice(rendered.length - Math.floor(maxChars * 0.35));
  return `${head}\n\n[...middle omitted for Fusion judge prompt...]\n\n${tail}`;
}

function responseText(value: unknown): string {
  return String(value ?? "").trim();
}

function parseJsonObject(text: string): unknown | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function parseJudgeAnalysis(text: string): FusionJudgeAnalysis | null {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const confidence = obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high" ? obj.confidence : "medium";
  return {
    consensus: stringArray(obj.consensus),
    contradictions: stringArray(obj.contradictions),
    partial_coverage: stringArray(obj.partial_coverage),
    unique_insights: stringArray(obj.unique_insights),
    blind_spots: stringArray(obj.blind_spots),
    ...(Array.isArray(obj.unsupported_claims) ? { unsupported_claims: stringArray(obj.unsupported_claims) } : {}),
    confidence,
  };
}

function panelPrompt(context: Context): Context {
  return context;
}

function buildJudgeContext(original: Context, responses: FusionPanelResponse[], failed: FusionFailedModel[]): Context {
  const panelText = responses.map((response, index) => [
    `## Panel response ${index + 1}: ${response.model}`,
    response.content,
  ].join("\n")).join("\n\n");
  const failedText = failed.length > 0
    ? failed.map((item) => `- ${item.model}: ${item.error}`).join("\n")
    : "none";
  return {
    systemPrompt: [
      "You are the judge in an OpenRouter-style Fusion pipeline.",
      "Compare independent panel responses. Do not synthesize the final answer here.",
      "Return ONLY valid JSON with keys: consensus, contradictions, partial_coverage, unique_insights, blind_spots, unsupported_claims, confidence.",
      "Each list value must be a short, evidence-oriented string. confidence must be low, medium, or high.",
    ].join("\n"),
    messages: [{
      role: "user",
      timestamp: Date.now(),
      content: [
        "Original conversation/task:",
        renderConversation(original),
        "",
        "Panel responses:",
        panelText,
        "",
        "Failed panel models:",
        failedText,
      ].join("\n"),
    }],
  };
}

function buildSynthesisContext(original: Context, responses: FusionPanelResponse[], failed: FusionFailedModel[], analysis?: FusionJudgeAnalysis): Context {
  const analysisText = analysis ? JSON.stringify(analysis, null, 2) : "(judge analysis unavailable; synthesize from panel responses only)";
  return {
    systemPrompt: [
      "You are the synthesis model in an OpenRouter-style Fusion pipeline.",
      "Write the final user-facing answer from the judge analysis and panel responses.",
      "Prefer consensus, surface important contradictions/uncertainty when relevant, preserve unique high-value insights, and avoid unsupported claims.",
    ].join("\n"),
    messages: [{
      role: "user",
      timestamp: Date.now(),
      content: [
        "Original conversation/task:",
        renderConversation(original),
        "",
        "Judge analysis:",
        analysisText,
        "",
        "Panel responses:",
        responses.map((response, index) => `## ${index + 1}. ${response.model}\n${response.content}`).join("\n\n"),
        "",
        failed.length > 0 ? `Panel failures:\n${failed.map((item) => `- ${item.model}: ${item.error}`).join("\n")}` : "Panel failures: none",
      ].join("\n"),
    }],
  };
}

function compactSummary(result: FusionRunResult): string {
  const analysis = result.analysis;
  const parts = [
    `Fusion ${result.recipe_id} ${result.status}${result.degraded ? ` (${result.degraded})` : ""}`,
    `panel ok=${result.responses.length} failed=${result.failed_models.length}`,
    analysis?.consensus.length ? `consensus: ${analysis.consensus.slice(0, 3).join("; ")}` : "",
    analysis?.contradictions.length ? `contradictions: ${analysis.contradictions.slice(0, 3).join("; ")}` : "",
    analysis?.blind_spots.length ? `blind spots: ${analysis.blind_spots.slice(0, 3).join("; ")}` : "",
    result.trace_path ? `trace: ${result.trace_path}` : "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 1_000);
}

function mergedSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return parent;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  return controller.signal;
}

export async function runFusionCompletion(recipe: FusionRecipe, context: Context, options: RunFusionOptions): Promise<FusionRunResult> {
  const run_id = options.runId ?? `fusion-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const requested_params = {
    model: recipe.model,
    analysis_models: recipe.analysis_models,
    max_tool_calls: recipe.max_tool_calls,
    max_completion_tokens: recipe.max_completion_tokens,
    temperature: recipe.temperature,
    reasoning: recipe.reasoning,
    timeout_ms: recipe.timeout_ms,
    per_model_timeout_ms: recipe.per_model_timeout_ms,
  };

  const panelResults = await Promise.all(recipe.analysis_models.map(async (model): Promise<FusionPanelResponse | FusionFailedModel> => {
    const started = performance.now();
    try {
      const content = responseText(await options.completer.complete({
        model,
        context: panelPrompt(context),
        maxTokens: recipe.max_completion_tokens,
        temperature: recipe.temperature,
        reasoning: recipe.reasoning?.effort,
        timeoutMs: recipe.per_model_timeout_ms ?? recipe.timeout_ms,
        signal: mergedSignal(options.signal, recipe.per_model_timeout_ms ?? recipe.timeout_ms),
      }));
      if (!content) throw new Error("empty panel response");
      return { model, content, wall_ms: Math.round(performance.now() - started) };
    } catch (error) {
      return { model, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  const responses = panelResults.filter((item): item is FusionPanelResponse => "content" in item);
  const failed_models = panelResults.filter((item): item is FusionFailedModel => "error" in item);
  const allowPartial = recipe.allow_partial_panel !== false;

  if (responses.length === 0 || (!allowPartial && failed_models.length > 0)) {
    const result: FusionRunResult = {
      status: "error",
      recipe_id: recipe.id,
      run_id,
      responses,
      failed_models,
      requested_params,
      error: responses.length === 0 ? "all panel models failed" : "partial panel failure is disabled",
    };
    result.trace_path = options.traceStore?.write(result);
    return result;
  }

  let analysis: FusionJudgeAnalysis | undefined;
  let judge_raw: string | undefined;
  let judge_error: string | undefined;
  let degraded: FusionRunResult["degraded"] = failed_models.length > 0 ? "panel_partial" : undefined;
  try {
    const judgeText = await options.completer.complete({
      model: recipe.model,
      context: buildJudgeContext(context, responses, failed_models),
      maxTokens: Math.min(recipe.max_completion_tokens ?? 1500, 4000),
      reasoning: recipe.reasoning?.effort,
      timeoutMs: recipe.timeout_ms,
      signal: mergedSignal(options.signal, recipe.timeout_ms),
    });
    judge_raw = judgeText;
    analysis = parseJudgeAnalysis(judgeText) ?? undefined;
    if (!analysis) {
      degraded = "judge_failed";
      judge_error = "judge response was not parseable JSON";
    }
  } catch (error) {
    degraded = "judge_failed";
    judge_error = error instanceof Error ? error.message : String(error);
  }

  let final_text: string | undefined;
  try {
    final_text = responseText(await options.completer.complete({
      model: recipe.model,
      context: buildSynthesisContext(context, responses, failed_models, analysis),
      maxTokens: recipe.max_completion_tokens,
      temperature: recipe.temperature,
      reasoning: recipe.reasoning?.effort,
      timeoutMs: recipe.timeout_ms,
      signal: mergedSignal(options.signal, recipe.timeout_ms),
    }));
  } catch (error) {
    degraded = "synthesis_failed";
    final_text = [
      "Fusion synthesis failed; returning panel-only result.",
      error instanceof Error ? error.message : String(error),
      "",
      responses.map((response, index) => `## ${index + 1}. ${response.model}\n${response.content}`).join("\n\n"),
    ].join("\n");
  }

  const result: FusionRunResult = {
    status: "ok",
    recipe_id: recipe.id,
    run_id,
    final_text,
    ...(analysis ? { analysis } : {}),
    responses,
    failed_models,
    ...(judge_error ? { judge_error } : {}),
    ...(judge_raw && !analysis ? { judge_raw: judge_raw.slice(0, 8_000) } : {}),
    ...(degraded ? { degraded } : {}),
    requested_params,
    effective_params: requested_params,
  };
  result.trace_path = options.traceStore?.write(result);
  options.broker?.publish(result, compactSummary(result));
  return result;
}

export function createFileFusionTraceStore(dir: string): FusionTraceStore {
  return {
    write(result: FusionRunResult): string | undefined {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${result.run_id}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      return path;
    },
  };
}
