import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:os";
import { homedir } from "node:os";
import { basename } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Message, type ThinkingLevel, type TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  appendText,
  featureFile,
  readText,
  safeName,
  truncate,
  writeText,
} from "@fiale-plus/pi-core";

// ── Constants ────────────────────────────────────────────────────────────

const FEATURE = "advisor";
const CONFIG_FILE = featureFile(FEATURE, "config.json");
const STATE_FILE = featureFile(FEATURE, "state.json");
const CURRENT_FILE = featureFile(FEATURE, "current.md");
const HISTORY_FILE = featureFile(FEATURE, "history.jsonl");
const CACHE_FILE = featureFile(FEATURE, "cache.json");

const MAX_SUMMARY_NOTES = 12;
const MAX_RECENT_FILES = 8;
const MAX_RECENT_ERRORS = 5;
const MAX_CACHE_ENTRIES = 64;

// ── Types ─────────────────────────────────────────────────────────────────

export type AdvisorMode = "tool" | "prompt" | "disabled";

export interface AdvisorConfig {
  enabled: boolean;
  mode: AdvisorMode;
  provider: string;
  model: string;
  fallbackModel: string;
  reasoning: ThinkingLevel;
  maxTokens: number;
  cacheEnabled: boolean;
  logMetrics: boolean;
}

export interface SessionState {
  turnCount: number;
  lastUserPrompt: string;
  summaryNotes: string[];
  recentFiles: string[];
  recentErrors: string[];
  advisorCalls: number;
  advisorCacheHits: number;
  pendingFollowUp: string;
}

export interface CacheEntry {
  createdAt: number;
  text: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AdvisorConfig = {
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

// ── Config helpers ────────────────────────────────────────────────────────

function loadConfig(): AdvisorConfig {
  try {
    const raw = JSON.parse(readText(CONFIG_FILE) || "{}");
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: AdvisorConfig): void {
  writeJson(CONFIG_FILE, config);
}

function loadState(): SessionState {
  try {
    const raw = JSON.parse(readText(STATE_FILE) || "{}");
    return {
      turnCount: raw.turnCount ?? 0,
      lastUserPrompt: raw.lastUserPrompt ?? "",
      summaryNotes: Array.isArray(raw.summaryNotes) ? raw.summaryNotes.slice(-MAX_SUMMARY_NOTES) : [],
      recentFiles: Array.isArray(raw.recentFiles) ? raw.recentFiles.slice(-MAX_RECENT_FILES) : [],
      recentErrors: Array.isArray(raw.recentErrors) ? raw.recentErrors.slice(-MAX_RECENT_ERRORS) : [],
      advisorCalls: raw.advisorCalls ?? 0,
      advisorCacheHits: raw.advisorCacheHits ?? 0,
      pendingFollowUp: raw.pendingFollowUp ?? "",
    };
  } catch {
    return {
      turnCount: 0,
      lastUserPrompt: "",
      summaryNotes: [],
      recentFiles: [],
      recentErrors: [],
      advisorCalls: 0,
      advisorCacheHits: 0,
      pendingFollowUp: "",
    };
  }
}

function saveState(state: SessionState): void {
  writeJson(STATE_FILE, state);
}

function loadCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readText(CACHE_FILE) || "{}");
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, CacheEntry>): void {
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) {
      delete cache[key];
    }
  }
  writeJson(CACHE_FILE, cache);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

function currentAdvisorNote(): string {
  return readText(CURRENT_FILE).trim();
}

function recordAdvisorNote(note: string): void {
  const value = note.trim();
  writeText(CURRENT_FILE, value + "\n");
  appendText(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), note: value }) + "\n");
}

function clearAdvisorNote(): void {
  writeText(CURRENT_FILE, "");
}

function historyEntries(): Array<{ at: string; note: string }> {
  const raw = readText(HISTORY_FILE).trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-10)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { at: new Date().toISOString(), note: line };
      }
    });
}

function hashText(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\n---\n"), "utf-8")
    .digest("hex")
    .slice(0, 16);
}

function buildSessionBrief(state: SessionState): string {
  const lines: string[] = [];
  if (state.lastUserPrompt) lines.push(`Task: ${truncate(state.lastUserPrompt, 220)}`);
  if (state.turnCount) lines.push(`Turns: ${state.turnCount}`);
  if (state.summaryNotes.length) {
    lines.push("Recent notes:");
    for (const note of state.summaryNotes.slice(-6)) {
      lines.push(`- ${truncate(note, 260)}`);
    }
  }
  if (state.recentFiles.length) {
    lines.push(`Files: ${state.recentFiles.slice(-6).join(", ")}`);
  }
  if (state.recentErrors.length) {
    lines.push(`Errors: ${state.recentErrors.slice(-3).join(" | ")}`);
  }
  return lines.slice(0, 1600).join("\n");
}

const ADVISOR_SYSTEM_PROMPT = `You are a senior engineering advisor. Use the compact session brief and the question only. Be terse, specific, and cache-aware. Return a short answer with concrete recommendations.`;

const PREFLIGHT_INSTRUCTION = `You have an ADVISOR tool available. Call it BEFORE making non-trivial architectural, library, design, or approach decisions. The advisor provides current best practices and strategic recommendations.

When to call: new frameworks, refactoring approach, API design, concurrency models, security decisions, tradeoff evaluation.
When to skip: file reads, small edits, config tweaks, one-liners.
Format: ask 1 concise question. Incorporate the answer.`;

function squish(text: string, max = 240): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

// ── SOTA model list (for suggestion display) ──────────────────────────────

export const SOTA_MODELS = [
  { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "openai-codex", model: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { provider: "openrouter", model: "openrouter/auto", label: "OpenRouter Auto" },
];

function formatSotaSuggestion(config: AdvisorConfig): string {
  const configured = `${config.provider}/${config.model}`;
  const others = SOTA_MODELS
    .filter((m) => `${m.provider}/${m.model}` !== configured)
    .map((m) => `- \`${m.provider}/${m.model}\` — ${m.label}`)
    .join("\n");
  return [
    `Currently configured: \`${configured}\``,
    ``,
    `Recommended SOTA models (switch via /advisor model <provider/model>):`,
    others,
  ].join("\n");
}

// ── Model resolution with SOTA fallback ───────────────────────────────────

async function resolveAdvisorModel(
  pi: ExtensionAPI,
  ctx: any,
  config: AdvisorConfig,
): Promise<{
  model: any;
  auth: { ok: boolean; apiKey?: string; headers?: Record<string, string> };
  provider: string;
  modelId: string;
  modelLabel: string;
  fallbackNote?: string;
} | null> {
  // Try configured model first
  const primary = ctx.modelRegistry.find(config.provider, config.model);
  if (primary) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(primary);
    if (auth.ok && auth.apiKey) {
      return {
        model: primary,
        auth,
        provider: config.provider,
        modelId: config.model,
        modelLabel: `${config.provider}/${config.model}`,
      };
    }
  }

  // Try SOTA models from the list
  for (const sota of SOTA_MODELS) {
    if (`${sota.provider}/${sota.model}` === `${config.provider}/${config.model}`) continue;
    const m = ctx.modelRegistry.find(sota.provider, sota.model);
    if (!m) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth.ok && auth.apiKey) {
      return {
        model: m,
        auth,
        provider: sota.provider,
        modelId: sota.model,
        modelLabel: sota.label,
        fallbackNote: `Configured model ${config.provider}/${config.model} unavailable. Using ${sota.provider}/${sota.model} (${sota.label}) instead.`,
      };
    }
  }

  // Try any text model from configured provider
  const available = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => Array.isArray(m.input) && m.input.includes("text"));
  if (available.length > 0) {
    const m = available[0];
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth.ok && auth.apiKey) {
      return {
        model: m,
        auth,
        provider: m.provider || "unknown",
        modelId: m.id || "unknown",
        modelLabel: `${m.provider || "unknown"}/${m.id || "unknown"}`,
        fallbackNote: `SOTA models unavailable. Using best available: ${m.provider || "?"}/${m.id || "?"}. Configure via /advisor model.`,
      };
    }
  }

  return null;
}

function buildAdvisorMessages(
  state: SessionState,
  question: string,
  scope: string,
  includeRecentWork: boolean,
): Message[] {
  const brief = buildSessionBrief(state);
  const lines = [`Question: ${question}`];
  if (scope) lines.push(`Scope: ${scope}`);
  if (includeRecentWork && brief) {
    lines.push("");
    lines.push("Session brief:");
    lines.push(brief);
  }
  return [{ role: "user", content: lines.join("\n") }];
}

async function requestAdvisor(
  pi: ExtensionAPI,
  ctx: any,
  question: string,
  scope: string,
  includeRecentWork: boolean,
): Promise<{
  text: string;
  cacheHit: boolean;
  cacheKey: string;
  error?: string;
  provider?: string;
  modelId?: string;
  fallbackNote?: string;
}> {
  const config = loadConfig();
  const state = loadState();
  const cleanedQuestion = squish(question, 800);
  if (!cleanedQuestion) {
    return { text: "No question provided.", cacheHit: false, cacheKey: "", error: "missing_question" };
  }

  const cacheContext = includeRecentWork ? buildSessionBrief(state) : "";
  const cacheKey = hashText(
    "advisor",
    config.provider,
    config.model,
    scope || "",
    cleanedQuestion.toLowerCase(),
    cacheContext,
    state.lastUserPrompt || "",
  );

  if (config.cacheEnabled) {
    const cache = loadCache();
    const cached = cache[cacheKey];
    if (cached) {
      state.advisorCacheHits++;
      saveState(state);
      return {
        text: cached.text,
        cacheHit: true,
        cacheKey,
        provider: config.provider,
        modelId: config.model,
      };
    }
  }

  const selection = await resolveAdvisorModel(pi, ctx, config);
  if (!selection) {
    const errorText =
      `No available model for advisor. Configure one via /advisor model <provider/model>.\n\n` +
      `SOTA options:\n${SOTA_MODELS.map((m) => `- \`${m.provider}/${m.model}\` — ${m.label}`).join("\n")}`;
    return { text: errorText, cacheHit: false, cacheKey: "", error: "model_unavailable" };
  }

  const { model, auth, provider, modelId, fallbackNote } = selection;

  const response = await completeSimple(
    model,
    {
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      messages: buildAdvisorMessages(state, cleanedQuestion, scope, includeRecentWork),
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: Math.min(config.maxTokens, 900),
      reasoning: config.reasoning,
    },
  );

  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    return { text: "Advisor returned no text.", cacheHit: false, cacheKey, provider, modelId, fallbackNote };
  }

  if (config.cacheEnabled) {
    const cache = loadCache();
    cache[cacheKey] = { createdAt: Date.now(), text };
    saveCache(cache);
  }

  state.advisorCalls++;
  saveState(state);

  return { text, cacheHit: false, cacheKey, provider, modelId, fallbackNote };
}

// ── Extension registration ────────────────────────────────────────────────

export function registerAdvisor(pi: ExtensionAPI): void {
  const config = loadConfig();

  // ── Tool: advisor ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Cache-aware strategic advisor for architecture, tradeoffs, planning, and review. " +
      "Uses a SOTA model (configured via /advisor model, default gpt-5.5).",
    promptSnippet:
      "Call advisor for architectural decisions, refactors, tradeoffs, and uncertain next steps.",
    promptGuidelines: [
      "Use advisor before large refactors, new abstractions, API changes, or performance tradeoffs.",
      "Use advisor when the path is ambiguous or the cost of a bad path is high.",
      "Avoid advisor for trivial file reads, one-line edits, or purely mechanical changes.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "What should the advisor help decide? Keep it to 1 concise question.",
      }),
      scope: Type.Optional(
        Type.String({
          description:
            "Optional scope label: architecture, implementation, debug, review, or planning",
        }),
      ),
      includeRecentWork: Type.Optional(
        Type.Boolean({
          description:
            "Include the rolling session brief in the advisory request (default: true)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const response = await requestAdvisor(
        pi,
        ctx,
        String(params.question || ""),
        String(params.scope || ""),
        params.includeRecentWork !== false,
      );
      if (response.error) {
        return {
          content: [{ type: "text", text: response.text }],
          details: {
            cacheHit: false,
            error: response.error,
            provider: response.provider,
            modelId: response.modelId,
          },
        };
      }
      onUpdate?.({
        content: [
          {
            type: "text",
            text: response.cacheHit
              ? "Advisor: cache hit — returning cached advice."
              : response.fallbackNote
                ? `Advisor: ${response.fallbackNote}`
                : "Advisor: consulting SOTA model…",
          },
        ],
      });
      return {
        content: [{ type: "text", text: response.text }],
        details: {
          cacheHit: response.cacheHit,
          provider: response.provider,
          modelId: response.modelId,
          fallbackNote: response.fallbackNote,
        },
      };
    },
  });

  // ── Hook: before_agent_start (preflight + follow-up) ────────────────────
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!config.enabled) return { systemPrompt: event.systemPrompt };
    const state = loadState();

    if (typeof event.prompt === "string" && event.prompt.trim()) {
      state.lastUserPrompt = squish(event.prompt, 1200);
      saveState(state);
    }

    const brief = buildSessionBrief(state);
    const followUp = state.pendingFollowUp;
    if (followUp) {
      state.pendingFollowUp = "";
      saveState(state);
    }

    let instructions = PREFLIGHT_INSTRUCTION;
    if (followUp) {
      instructions = `Advisor follow-up (required):\n${followUp}\n\n${instructions}`;
    }

    const updated = [event.systemPrompt, instructions, brief ? `Session brief (cache-aware; do not reread the full history):\n${brief}` : ""]
      .filter(Boolean)
      .join("\n\n");

    return { systemPrompt: updated };
  });

  // ── Command: /advisor ───────────────────────────────────────────────────
  pi.registerCommand("advisor", {
    description:
      "Advisor: ask a strategic question or manage configuration. Uses SOTA model (default gpt-5.5).",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const [cmd, ...rest] = input.split(/\s+/);
      const known = new Set(["set", "show", "clear", "list", "model", "mode", "status", "digest"]);
      const resolved = !input ? "show" : known.has(cmd) ? cmd : "set";
      const text = resolved === "set" && known.has(cmd) ? rest.join(" ").trim() : input;

      if (resolved === "show") {
        const note = currentAdvisorNote();
        const c = loadConfig();
        const state = loadState();
        ctx.ui.notify(
          [
            note ? `🧭 ${truncate(note, 200)}` : "No advisor note set.",
            "",
            `Turns: ${state.turnCount} | Calls: ${state.advisorCalls} | Cache hits: ${state.advisorCacheHits}`,
            `Model: ${c.provider}/${c.model} | Mode: ${c.mode}`,
            "",
            "Tip: Call the advisor tool for strategic questions. Configure via:",
            "  /advisor model <provider/model>  — set advisor model (e.g. openai-codex/gpt-5.5)",
            "  /advisor mode tool|prompt|disabled — set advisor mode",
            "  /advisor status — full details with SOTA suggestions",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (resolved === "clear") {
        const note = currentAdvisorNote();
        clearAdvisorNote();
        ctx.ui.notify(note ? "Advisor note cleared." : "No advisor note to clear.", "info");
        return;
      }

      if (resolved === "list") {
        const entries = historyEntries();
        if (entries.length === 0) {
          ctx.ui.notify("No advisor history yet.", "info");
          return;
        }
        ctx.ui.notify(
          entries
            .map(
              (e, i) =>
                `${i + 1}. ${truncate(e.note, 120)} (${new Date(e.at).toLocaleDateString()})`,
            )
            .join("\n"),
          "info",
        );
        return;
      }

      if (resolved === "model") {
        const value = rest.join("/").trim();
        if (!value || !value.includes("/")) {
          const c = loadConfig();
          ctx.ui.notify(
            formatSotaSuggestion(c),
            "info",
          );
          return;
        }
        const [provider, ...modelParts] = value.split("/");
        const modelId = modelParts.join("/");
        if (!provider || !modelId) {
          ctx.ui.notify("Usage: /advisor model <provider>/<model> (e.g. openai-codex/gpt-5.5)", "error");
          return;
        }
        const next = loadConfig();
        next.provider = provider.trim();
        next.model = modelId.trim();
        saveConfig(next);
        ctx.ui.notify(`Advisor model set to ${next.provider}/${next.model}.`, "info");
        return;
      }

      if (resolved === "mode") {
        const value = rest[0];
        if (!value || !["tool", "prompt", "disabled"].includes(value)) {
          ctx.ui.notify("Usage: /advisor mode tool|prompt|disabled", "error");
          return;
        }
        const next = loadConfig();
        next.mode = value as AdvisorMode;
        next.enabled = value !== "disabled";
        saveConfig(next);
        ctx.ui.notify(`Advisor mode set to ${value}.`, "info");
        return;
      }

      if (resolved === "status") {
        const c = loadConfig();
        const state = loadState();
        ctx.ui.notify(
          [
            "--- Advisor Status ---",
            `Enabled: ${c.enabled}`,
            `Mode: ${c.mode}`,
            `Model: ${c.provider}/${c.model}`,
            `Reasoning: ${c.reasoning}`,
            `Max tokens: ${c.maxTokens}`,
            `Cache: ${c.cacheEnabled ? "on" : "off"}`,
            `Log metrics: ${c.logMetrics ? "on" : "off"}`,
            "",
            `Session turns: ${state.turnCount}`,
            `Advisor calls: ${state.advisorCalls}`,
            `Cache hits: ${state.advisorCacheHits}`,
            `Recent files: ${state.recentFiles.length}`,
            `Recent errors: ${state.recentErrors.length}`,
            "",
            "SOTA model suggestions:",
            ...SOTA_MODELS.map(
              (m) =>
                `  ${m.provider}/${m.model} — ${m.label}${c.provider === m.provider && c.model === m.model ? " (active)" : ""}`,
            ),
          ].join("\n"),
          "info",
        );
        return;
      }

      if (resolved === "digest") {
        const state = loadState();
        const brief = buildSessionBrief(state);
        ctx.ui.notify(brief || "(empty session brief)", "info");
        return;
      }

      if (resolved === "set" && text) {
        recordAdvisorNote(text);
        ctx.ui.notify(`🧭 Advisor note set: ${truncate(text, 160)}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /advisor [set|show|clear|list|model|mode|status|digest]",
        "info",
      );
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI): void {
  registerAdvisor(pi);
}
