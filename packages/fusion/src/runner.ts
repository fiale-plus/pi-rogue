import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  FusionFailedModel,
  FusionFailureMeta,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  return undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function parseJsonLoose(value: string): unknown | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function extractErrorPayload(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof Error) {
    const parsed = parseJsonLoose(error.message);
    if (parsed && typeof parsed === "object") return asRecord(parsed);
    return asRecord(error.cause) ?? asRecord(error);
  }
  if (typeof error === "string") return asRecord(parseJsonLoose(error));
  return asRecord(error);
}

function locateErrorObject(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  let current = payload;
  for (let i = 0; i < 4; i += 1) {
    if (!current) return undefined;
    const type = firstString(current.type);
    const code = firstString(current.code);
    const message = firstString(current.message);
    const hasTerminalError = code !== undefined || message !== undefined && (type !== "error");
    if (hasTerminalError || (type !== undefined && type !== "error")) {
      return current;
    }
    const next = [current.error, current.data, current.details, current.body];
    const nextRecord = next.map((entry) => asRecord(entry)).find(Boolean);
    if (!nextRecord) return current;
    current = nextRecord;
  }
  return current;
}

function readHeaderNumber(headers: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!headers) return undefined;
  for (const key of keys) {
    const value = firstNumber(headers[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function classifyFailureCategory(errorText: string, errorNode: Record<string, unknown> | undefined): FusionFailureMeta["category"] {
  const lowered = errorText.toLowerCase();
  const type = firstString(errorNode?.type)?.toLowerCase();
  const code = firstString(errorNode?.code)?.toLowerCase();
  const status = firstNumber(errorNode?.status_code) ?? firstNumber(errorNode?.statusCode) ?? firstNumber(errorNode?.status);

  if (/timeout after\s+\d+ms/i.test(lowered)) return "timeout";
  if (lowered.includes("aborted") || type === "aborted" || code === "aborted") return "aborted";
  if (type === "usage_limit_reached" || code === "usage_limit_reached" || /usage[_-]?limit|quota.*(exhausted|exceeded|reached)/i.test(lowered)) return "usage_limit_reached";
  if ((type?.includes("rate") && type.includes("limit")) || code === "rate_limit" || code === "rate_limit_exceeded" || /rate\s+limit|rate_limit/i.test(lowered) || status === 429) return "rate_limit";
  if (type === "auth_error" || code === "auth_error" || status === 401 || status === 403 || /401|403|unauthorized|forbidden|authentication|api key|permission denied/i.test(lowered)) return "auth_error";
  if (type === "network_error" || code === "network_error" || /network error|econn|enotfound|etimedout|timed out|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(lowered)) return "network_error";
  if (type === "context_length_exceeded" || code === "context_length_exceeded" || /context_length_exceeded|context window|input exceeds/i.test(lowered)) return "context_length_exceeded";
  return "provider_error";
}

function summarizePanelFailure(error: unknown): { summary: string; details: FusionFailureMeta } {
  const rawText = responseText(error);
  const parsed = extractErrorPayload(error);
  const detailNode = locateErrorObject(parsed) ?? asRecord(error) ?? asRecord((error as any)?.cause);

  const parsedError = asRecord((parsed as any)?.error);
  const nestedParsedError = asRecord((parsedError as any)?.error);
  const message = firstString(detailNode?.message)
    ?? firstString(parsedError?.message)
    ?? firstString(nestedParsedError?.message)
    ?? rawText
    ?? "provider request failed";

  const type = firstString(detailNode?.type);
  const code = firstString(detailNode?.code);
  const statusCode = firstNumber(detailNode?.status_code) ?? firstNumber(detailNode?.statusCode) ?? firstNumber(detailNode?.status) ?? firstNumber((parsed as any)?.status_code) ?? firstNumber((parsed as any)?.statusCode) ?? firstNumber((parsed as any)?.status);
  const parsedHeaders = asRecord((parsed as any)?.headers) ?? asRecord(parsedError?.headers);
  const headers = asRecord(detailNode?.headers) ?? parsedHeaders;

  const category = classifyFailureCategory(`${rawText} ${type ?? ""} ${code ?? ""}`, detailNode);
  const resetInSeconds = readHeaderNumber(headers, [
    "X-Codex-Primary-Reset-After-Seconds",
    "X-Codex-Bengalfox-Primary-Reset-After-Seconds",
    "X-Codex-Secondary-Reset-After-Seconds",
    "X-Codex-Bengalfox-Secondary-Reset-After-Seconds",
  ]);
  const resetAt = readHeaderNumber(headers, [
    "X-Codex-Primary-Reset-At",
    "X-Codex-Bengalfox-Primary-Reset-At",
    "X-Codex-Secondary-Reset-At",
    "X-Codex-Bengalfox-Secondary-Reset-At",
    "X-RateLimit-Reset",
  ]);
  const retryAfter = readHeaderNumber(headers, [
    "Retry-After",
    "X-Codex-Retry-After",
    "X-RateLimit-Reset-After",
    "X-RateLimit-Remaining-Reset",
  ]);
  const planType = firstString(headers?.["X-Codex-Plan-Type"]) ?? firstString(headers?.["X-Codex-Bengalfox-Plan-Type"]);

  const details: FusionFailureMeta = {
    category,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
    ...(resetInSeconds !== undefined ? { reset_in_seconds: resetInSeconds } : {}),
    ...(resetAt !== undefined ? { reset_at: resetAt } : {}),
    ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}),
    ...(planType ? { plan_type: planType } : {}),
  };

  const summaryBits: string[] = [];
  if (type) summaryBits.push(`type=${type}`);
  if (code) summaryBits.push(`code=${code}`);
  if (statusCode !== undefined) summaryBits.push(`status=${statusCode}`);
  if (resetInSeconds !== undefined) summaryBits.push(`reset_in=${resetInSeconds}s`);
  if (resetAt !== undefined) summaryBits.push(`reset_at=${resetAt}`);
  if (retryAfter !== undefined) summaryBits.push(`retry_after=${retryAfter}`);
  if (planType) summaryBits.push(`plan=${planType}`);


  return {
    summary: `${truncate(message, 220)}${summaryBits.length ? ` (${summaryBits.join(", ")})` : ""}`,
    details,
  };
}

function isContextLengthExceeded(error: unknown): boolean {
  const rawText = responseText(error);
  const parsed = extractErrorPayload(error);
  const detailNode = locateErrorObject(parsed) ?? asRecord(error) ?? asRecord((error as any)?.cause);
  return classifyFailureCategory(rawText, detailNode) === "context_length_exceeded";
}

function formatFailedPanelSummary(failed: FusionFailedModel[]): string {
  const grouped = new Map<string, { models: string[]; sample: string }>();
  for (const item of failed) {
    const reason = item.details?.category ?? "unknown";
    const key = `${reason}::${item.error}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.models.includes(item.model)) existing.models.push(item.model);
    } else {
      grouped.set(key, { models: [item.model], sample: item.error });
    }
  }
  return [...grouped.values()]
    .map((entry) => `${entry.models.join(", ")} (${entry.models.length}): ${entry.sample}`)
    .join("; ");
}

function summarizePanelFailureCategories(failed: FusionFailedModel[]): string {
  const grouped = new Map<string, number>();
  for (const item of failed) {
    const category = item.details?.category ?? "unknown";
    grouped.set(category, (grouped.get(category) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `${category}(${count})`)
    .join("; ");
}

const DEFAULT_PANEL_SUCCESS_RATIO = 2 / 3;

function minimumPanelSuccessCount(totalModels: number): number {
  return Math.max(1, Math.ceil(totalModels * DEFAULT_PANEL_SUCCESS_RATIO));
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

function isLikelyIntentOnlyPanelText(content: string): boolean {
  const lower = responseText(content).toLowerCase();
  if (!lower) return true;
  const firstSentence = lower.split(/[.!?\n]/)[0] ?? "";
  const intentOnlyPattern = /^(?:i\s*(?:'ll|\u2019ll)?\s*(?:read|open|inspect|check|review|analyze|analyse|look|start|take|try)|i\s*(?:will|would)\s+(?:read|open|inspect|check|review|analyze|analyse|look|start|take|try)|i\s+(?:can\s+only|cannot|can't|won't|do not|can not)\b)/;
  if (intentOnlyPattern.test(firstSentence)) return true;
  return false;
}

function buildPanelOnlyText(context: Context, responses: FusionPanelResponse[], reason: string, failed: FusionFailedModel[]): string {
  const failedText = failed.length > 0
    ? failed.map((item) => `${item.model}: ${item.error}`).join("\n")
    : "none";

  return [
    `Fusion bypassed judge/synthesis because panel output was not substantive: ${reason}`,
    "",
    `Original task:\n${renderConversation(context)}`,
    "",
    ...responses.map((response) => `## ${response.model}\n${response.content}`),
    failed.length > 0 ? `\nPanel failures:\n${failedText}` : "\nPanel failures: none",
  ].join("\n");
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

function panelPrompt(context: Context, maxChars = 8_000): Context {
  return {
    systemPrompt: [
      context.systemPrompt,
      "Fusion panel mode: provide an independent analysis-only answer.",
      "Do not call tools, edit files, write state, run commands, or take side-effecting actions. If the task asks for changes, describe the recommended changes and risks rather than attempting to apply them.",
      "The judge and synthesis stages will compare this advice with other panel answers before a final response is produced.",
    ].filter(Boolean).join("\n"),
    messages: [{
      role: "user",
      timestamp: Date.now(),
      content: renderConversation(context, maxChars),
    }],
  };
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
      "Panel responses are non-mutating advice only: they were instructed not to call tools, edit files, write state, run commands, or take side-effecting actions.",
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
      "Treat panel responses as analysis-only advice. If changes are needed, recommend concrete next steps unless the surrounding Pi session explicitly asks a write-capable agent/tool to apply them.",
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
    min_panel_success: recipe.min_panel_success,
    max_tool_calls: recipe.max_tool_calls,
    max_completion_tokens: recipe.max_completion_tokens,
    temperature: recipe.temperature,
    reasoning: recipe.reasoning,
    timeout_ms: recipe.timeout_ms,
    per_model_timeout_ms: recipe.per_model_timeout_ms,
  };

  const panelResults = await Promise.all(recipe.analysis_models.map(async (model): Promise<FusionPanelResponse | FusionFailedModel> => {
    const started = performance.now();
    const panelBudgets = [8_000, 4_000];
    let lastFailure: { summary: string; details: FusionFailureMeta } | undefined;

    for (const budget of panelBudgets) {
      try {
        const content = responseText(await options.completer.complete({
          model,
          context: panelPrompt(context, budget),
          maxTokens: recipe.max_completion_tokens,
          temperature: recipe.temperature,
          reasoning: recipe.reasoning?.effort,
          timeoutMs: recipe.per_model_timeout_ms ?? recipe.timeout_ms,
          signal: mergedSignal(options.signal, recipe.per_model_timeout_ms ?? recipe.timeout_ms),
        }));
        if (!content) throw new Error("empty panel response");
        return { model, content, wall_ms: Math.round(performance.now() - started) };
      } catch (error) {
        lastFailure = summarizePanelFailure(error);
        if (!isContextLengthExceeded(error) || budget === panelBudgets.at(-1)) break;
      }
    }

    if (!lastFailure) return { model, error: "provider request failed", details: { category: "provider_error" } };
    return {
      model,
      error: lastFailure.summary,
      details: lastFailure.details,
    };
  }));

  const responses = panelResults.filter((item): item is FusionPanelResponse => "content" in item);
  const failed_models = panelResults.filter((item): item is FusionFailedModel => "error" in item);
  const allowPartial = recipe.allow_partial_panel !== false;

  const minimumPanelSuccess = recipe.min_panel_success ?? minimumPanelSuccessCount(recipe.analysis_models.length);
  const effective_params = { ...requested_params, min_panel_success: minimumPanelSuccess };
  const panelQuorumMet = responses.length >= minimumPanelSuccess;

  if (!panelQuorumMet || (!allowPartial && failed_models.length > 0)) {
    const disabled = !allowPartial && failed_models.length > 0 ? "partial panel failure is disabled" : "panel quorum not met";
    const categorySummary = summarizePanelFailureCategories(failed_models);
    const result: FusionRunResult = {
      status: "error",
      recipe_id: recipe.id,
      run_id,
      responses,
      failed_models,
      requested_params,
      effective_params,
      error: `${disabled}: panel models total=${recipe.analysis_models.length}, successful=${responses.length}, failed=${failed_models.length}, minimum required ${minimumPanelSuccess}${categorySummary ? `; dominant failures: ${categorySummary}` : ""}. ${formatFailedPanelSummary(failed_models)}`,
    };
    result.trace_path = options.traceStore?.write(result);
    return result;
  }

  const substantiveResponses = responses.filter((response) => !isLikelyIntentOnlyPanelText(response.content));
  const nonSubstantivePanel = responses.length - substantiveResponses.length;
  if (nonSubstantivePanel > 0 && substantiveResponses.length === 0) {
    const final_text = buildPanelOnlyText(context, responses, "all panel responses were non-substantive", failed_models);
    const result: FusionRunResult = {
      status: "ok",
      recipe_id: recipe.id,
      run_id,
      final_text,
      responses,
      failed_models,
      degraded: failed_models.length > 0 ? "panel_partial" : "panel_only",
      requested_params,
      effective_params,
    };
    result.trace_path = options.traceStore?.write(result);
    options.broker?.publish(result, compactSummary(result));
    return result;
  }

  let analysis: FusionJudgeAnalysis | undefined;
  let judge_raw: string | undefined;
  let judge_error: string | undefined;
  let degraded: FusionRunResult["degraded"] = failed_models.length > 0 ? "panel_partial" : undefined;
  let judgeUsageLimit = false;
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
    const judgeFailure = summarizePanelFailure(error);
    judge_error = judgeFailure.summary;
    if (judgeFailure.details.category === "usage_limit_reached") {
      judgeUsageLimit = true;
    }
  }

  let final_text: string | undefined;
  if (judgeUsageLimit) {
    final_text = buildPanelOnlyText(context, responses, "judge usage limit reached", failed_models);
    degraded = "judge_failed";
  } else {
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
    effective_params,
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
