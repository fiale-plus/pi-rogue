import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { featureFile, readText, truncate, writeText, appendText } from "@fiale-plus/pi-core";

// ── Config: 3 optional fields ────────────────────────────────────────────

export interface AdvisorConfig {
  /** "auto" (preflight+post+cache), "manual" (just /advisor), "off" */
  mode: "auto" | "manual" | "off";
  /** "light" (file changes/errors only) | "strict" (every 3 turns) | "off" */
  review: "light" | "strict" | "off";
  /** Optional model override. Auto-detects SOTA (gpt-5.5, claude-opus-4-6…) if unset */
  model?: string;
}

const DEFAULT_CONFIG: AdvisorConfig = {
  mode: "auto",
  review: "light",
};

const CONFIG_PATH = featureFile("advisor", "config.json");
const STATE_PATH = featureFile("advisor", "state.json");
const CACHE_PATH = featureFile("advisor", "cache.json");
const CURRENT_PATH = featureFile("advisor", "current.md");
const HISTORY_PATH = featureFile("advisor", "history.jsonl");

const MAX_CACHE = 64;
const MAX_NOTES = 12;
const MAX_FILES = 8;
const MAX_ERRORS = 5;

// ── SOTA models (ordered by preference) ───────────────────────────────────
const SOTA_CHAIN: Array<{ provider: string; model: string; label: string }> = [
  { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "openai-codex", model: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

// ── Internal state ────────────────────────────────────────────────────────
interface SessionState {
  turns: number;
  lastTask: string;
  notes: string[];
  files: string[];
  errors: string[];
  advisorCalls: number;
  cacheHits: number;
  followUp: string;
}

function defaultState(): SessionState {
  return { turns: 0, lastTask: "", notes: [], files: [], errors: [], advisorCalls: 0, cacheHits: 0, followUp: "" };
}

// ── File I/O ──────────────────────────────────────────────────────────────
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readText(path) || "null") ?? fallback;
  } catch { return fallback; }
}

function writeJson(path: string, v: unknown) { writeText(path, JSON.stringify(v, null, 2) + "\n"); }

function loadConfig(): AdvisorConfig {
  const raw = readJson<Partial<AdvisorConfig>>(CONFIG_PATH, {});
  return {
    mode: (raw.mode === "manual" || raw.mode === "off") ? raw.mode : "auto",
    review: (raw.review === "strict" || raw.review === "off") ? raw.review : "light",
    model: raw.model || undefined,
  };
}

function saveConfig(c: AdvisorConfig) { writeJson(CONFIG_PATH, c); }

function loadState(): SessionState {
  const raw = readJson<Partial<SessionState>>(STATE_PATH, {});
  return {
    turns: raw.turns ?? 0,
    lastTask: raw.lastTask ?? "",
    notes: (raw.notes ?? []).slice(-MAX_NOTES),
    files: (raw.files ?? []).slice(-MAX_FILES),
    errors: (raw.errors ?? []).slice(-MAX_ERRORS),
    advisorCalls: raw.advisorCalls ?? 0,
    cacheHits: raw.cacheHits ?? 0,
    followUp: raw.followUp ?? "",
  };
}

function saveState(s: SessionState) { writeJson(STATE_PATH, s); }

function loadCache(): Record<string, string> {
  return readJson<Record<string, string>>(CACHE_PATH, {});
}

function saveCache(c: Record<string, string>) {
  const entries = Object.entries(c);
  if (entries.length > MAX_CACHE) {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k] of entries.slice(0, entries.length - MAX_CACHE)) delete c[k];
  }
  writeJson(CACHE_PATH, c);
}

// ── Prompts ───────────────────────────────────────────────────────────────

const ADVISOR_SYSTEM = `You are a senior engineering advisor. Use the session brief only. Return terse, specific advice with concrete recommendations. 200 words max.`;

const REVIEW_SYSTEM = `You are a senior reviewer. An AI agent just completed work. Assess it. Return ONLY valid JSON:
{
  "verdict": "on_track"|"course_correct"|"not_done",
  "summary": "1-2 sentence assessment",
  "actions": ["action1"],
  "checklist": ["item"],
  "notify": true
}`;

const PREFLIGHT = `You have an ADVISOR tool. Call it before: new frameworks, refactoring, API design, concurrency, security, tradeoffs. Skip: reads, small edits, one-liners. Ask 1 concise question.`;

// ── Helpers ───────────────────────────────────────────────────────────────

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

function brief(s: SessionState): string {
  const lines: string[] = [];
  if (s.lastTask) lines.push(`Task: ${truncate(s.lastTask, 200)}`);
  if (s.turns) lines.push(`Turns: ${s.turns}`);
  if (s.notes.length) { lines.push("Notes:"); s.notes.slice(-4).forEach(n => lines.push(`- ${truncate(n, 200)}`)); }
  if (s.files.length) lines.push(`Files: ${s.files.slice(-4).join(", ")}`);
  if (s.errors.length) lines.push(`Errors: ${s.errors.slice(-2).join(" | ")}`);
  return lines.join("\n").slice(0, 1200);
}

function squish(t: unknown, max = 200): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

// ── Model resolution (auto-fallback through SOTA chain) ────────────────────
async function resolveModel(ctx: any, config: AdvisorConfig): Promise<{ model: any; auth: any; label: string } | null> {
  // Try user's configured model first
  if (config.model && config.model.includes("/")) {
    const [p, ...m] = config.model.split("/");
    const found = ctx.modelRegistry?.find(p, m.join("/"));
    if (found) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
      if (auth?.ok && auth.apiKey) return { model: found, auth, label: p + "/" + m.join("/") };
    }
  }
  // Fall through SOTA chain
  for (const sota of SOTA_CHAIN) {
    const found = ctx.modelRegistry?.find(sota.provider, sota.model);
    if (!found) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
    if (auth?.ok && auth.apiKey) return { model: found, auth, label: sota.label };
  }
  // Any text model
  const avail = (ctx.modelRegistry?.getAvailable() ?? []).filter((m: any) => m.input?.includes?.("text"));
  if (avail.length) {
    const m = avail[0];
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth?.ok && auth.apiKey) return { model: m, auth, label: m.id || "unknown" };
  }
  return null;
}

async function askAdvisor(pi: ExtensionAPI, ctx: any, question: string, scope: string, includeWork: boolean) {
  const config = loadConfig();
  const state = loadState();
  if (!question.trim()) return { text: "Ask a question.", error: "empty" };

  const ck = hash("adv", config.model ?? "auto", squish(question, 300), includeWork ? brief(state) : "");
  const cache = loadCache();
  if (cache[ck]) { state.cacheHits++; saveState(state); return { text: cache[ck], cached: true }; }

  const resolved = await resolveModel(ctx, config);
  if (!resolved) return { text: "No model available. Install one via pi config.", error: "no_model" };

  const msgs: Message[] = [
    { role: "system", content: ADVISOR_SYSTEM },
    { role: "user", content: [ `Question: ${question}`, scope ? `Scope: ${scope}` : "", includeWork && brief(state) ? `Session:\n${brief(state)}` : "" ].filter(Boolean).join("\n") },
  ];

  const resp = await completeSimple(resolved.model, { systemPrompt: ADVISOR_SYSTEM, messages: msgs }, {
    apiKey: resolved.auth.apiKey, headers: resolved.auth.headers,
    maxTokens: 600, reasoning: "medium" as ThinkingLevel,
  });
  const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim() || "(empty)";
  if (text && text !== "(empty)") { cache[ck] = text; saveCache(cache); }
  state.advisorCalls++;
  saveState(state);
  return { text, model: resolved.label };
}

async function doReview(pi: ExtensionAPI, ctx: any, trigger: string, delta: string, meta: { fileChanged: boolean; failed: boolean }) {
  const config = loadConfig();
  if (config.review === "off") return;
  const state = loadState();
  if (!delta && !meta.fileChanged && !meta.failed) return;
  const b = brief(state);
  if (!b) return;

  const rk = hash("rev", trigger, b, delta, String(meta.fileChanged), String(meta.failed));
  const cache = loadCache();
  if (cache[rk]) return; // already reviewed this

  const resolved = await resolveModel(ctx, config);
  if (!resolved) return;
  const msgs = [
    { role: "system", content: REVIEW_SYSTEM },
    { role: "user", content: [ `Trigger: ${trigger}`, `Task: ${state.lastTask || "(unknown)"}`, `Delta: ${delta || "(none)"}`, `Files: ${meta.fileChanged} Errors: ${meta.failed}`, `Brief:\n${b}` ].join("\n") },
  ];
  const resp = await completeSimple(resolved.model, { systemPrompt: REVIEW_SYSTEM, messages: msgs }, {
    apiKey: resolved.auth.apiKey, headers: resolved.auth.headers,
    maxTokens: 400, reasoning: "low" as ThinkingLevel,
  });
  const raw = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!raw) return;

  cache[rk] = raw;
  saveCache(cache);

  // Try to parse JSON verdict
  let json: any = null;
  try { json = JSON.parse(raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "")); } catch { /* ignore */ }
  if (!json) return;

  if (json.verdict === "on_track" && json.notify !== true) return;
  if (json.verdict === "skip") return;
  const emoji = json.verdict === "on_track" ? "✅" : json.verdict === "course_correct" ? "🔄" : "⏳";
  const lines = [`Advisor review ${emoji} ${json.verdict?.replace("_", " ") || "?"}`];
  if (json.summary) lines.push("", json.summary.slice(0, 300));
  if (json.actions?.length) lines.push("", ...json.actions.slice(0, 3));
  if (json.checklist?.length) lines.push("", "Check:", ...json.checklist.slice(0, 3));
  ctx.ui?.notify?.(lines.join("\n"), json.verdict === "course_correct" ? "warning" : "info");

  if (json.verdict !== "on_track") {
    state.followUp = [json.summary, ...(json.actions?.slice(0, 2) || [])].filter(Boolean).join(" — ");
    saveState(state);
  }
}

// ── Extension entry point ──────────────────────────────────────────────────

export function registerAdvisor(pi: ExtensionAPI): void {
  const config = loadConfig();

  // ── Tool ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description: "Strategic advisor. Call before architecture/refactor/tradeoff decisions. Uses best available model (default gpt-5.5).",
    parameters: Type.Object({
      question: Type.String({ description: "1 concise question" }),
      scope: Type.Optional(Type.String({ description: "architecture|implementation|debug|review|planning" })),
      includeRecentWork: Type.Optional(Type.Boolean({ description: "default: true" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const r = await askAdvisor(pi, ctx, String(params.question || ""), String(params.scope || ""), params.includeRecentWork !== false);
      onUpdate?.({ content: [{ type: "text", text: r.cached ? "(cached)" : r.model ? `Consulting ${r.model}…` : "" }] });
      return { content: [{ type: "text", text: r.text }], details: { cached: r.cached, error: r.error } };
    },
  });

  // ── Preflight ──────────────────────────────────────────────────────────
  pi.on("before_agent_start", (event: any, ctx: any) => {
    if (config.mode === "off" || config.mode === "manual") return { systemPrompt: event.systemPrompt };
    const state = loadState();
    if (typeof event.prompt === "string" && event.prompt.trim()) state.lastTask = squish(event.prompt, 1000);
    const follow = state.followUp;
    if (follow) { state.followUp = ""; saveState(state); }
    const b = brief(state);
    return {
      systemPrompt: [
        event.systemPrompt,
        follow ? `Advisor follow-up:\n${follow}` : "",
        PREFLIGHT,
        b ? `Brief (cache-aware):\n${b}` : "",
      ].filter(Boolean).join("\n\n"),
    };
  });

  // ── Post-review (turn_end) ─────────────────────────────────────────────
  pi.on("turn_end", async (event: any, ctx: any) => {
    if (config.mode === "off") return;
    const state = loadState();
    state.turns++;
    const tools = (event.toolResults || []).map((t: any) => String(t?.toolName || t?.name || "tool"));
    const fileChanged = tools.some((t: string) => /^(edit|write)$/i.test(t));
    const failed = tools.some((t: string) => /error|fail/i.test(t));
    const text = squish(event.message?.content || "");
    if (text && text !== state.notes[state.notes.length - 1]) state.notes.push(text);
    saveState(state);

    if (config.review !== "off") {
      await doReview(pi, ctx, `turn-${state.turns}`, text, { fileChanged, failed });
    }
  });

  // ── Post-review (agent_end) ────────────────────────────────────────────
  pi.on("agent_end", async (event: any, ctx: any) => {
    if (config.mode === "off" || config.review === "off") return;
    const state = loadState();
    const msgs = (event.messages || []).filter((m: any) => m.role === "assistant" || m.role === "toolResult");
    const last = msgs[msgs.length - 1];
    const delta = squish(last?.content || "(none)");
    const fileChanged = msgs.some((m: any) => /(?:write|edit)/i.test(JSON.stringify(m)));
    const failed = msgs.some((m: any) => /error|fail/i.test(JSON.stringify(m)));
    await doReview(pi, ctx, "agent-end", delta, { fileChanged, failed });
  });

  // ── /advisor command ───────────────────────────────────────────────────
  pi.registerCommand("advisor", {
    description: "Senior engineering advisor. Usage: /advisor [on|off|status|config|question]",
    handler: async (args, ctx) => {
      const a = String(args ?? "").trim().toLowerCase();
      const [cmd, ...rest] = a.split(/\s+/);
      const cfg = loadConfig();
      const state = loadState();

      if (!a || cmd === "status") {
        const note = readText(CURRENT_PATH).trim();
        const resolved = await resolveModel(ctx, cfg);
        ctx.ui.notify([
          note ? `🧭 ${truncate(note, 200)}` : "",
          "",
          `Mode: ${cfg.mode} | Review: ${cfg.review} | Model: ${resolved?.label || cfg.model || "auto"}`,
          `Turns: ${state.turns} | Calls: ${state.advisorCalls} | Cache hits: ${state.cacheHits}`,
          "",
          "Commands: /advisor on|off | /advisor status | /advisor config | <question>",
          "Tip: SOTA models auto-detected. No config needed.",
        ].filter(Boolean).join("\n"), "info");
        return;
      }

      if (cmd === "on" && cfg.mode === "off") { saveConfig({ ...cfg, mode: "auto" }); ctx.ui.notify("Advisor enabled (auto mode).", "success"); return; }
      if (cmd === "off") { saveConfig({ ...cfg, mode: "off" }); ctx.ui.notify("Advisor disabled.", "info"); return; }
      if (cmd === "mode") {
        const v = rest[0];
        if (v === "auto" || v === "manual") { saveConfig({ ...cfg, mode: v }); ctx.ui.notify(`Mode set to ${v}.`, "info"); return; }
        if (v === "off") { saveConfig({ ...cfg, mode: "off" }); ctx.ui.notify("Advisor disabled.", "info"); return; }
        ctx.ui.notify("Usage: /advisor mode auto|manual|off", "error");
        return;
      }
      if (cmd === "model") {
        const v = rest.join("/").trim();
        if (!v || !v.includes("/")) {
          const resolved = await resolveModel(ctx, cfg);
          ctx.ui.notify([
            `Current: ${resolved?.label || "auto"}`,
            "",
            "Usage: /advisor model <provider>/<model>",
            '(e.g. "openai-codex/gpt-5.5" or "anthropic/claude-opus-4-6")',
            "Run /advisor status for SOTA options.",
          ].join("\n"), "info");
          return;
        }
        saveConfig({ ...cfg, model: v });
        ctx.ui.notify(`Model set to ${v}. Remove field to auto-detect.`, "info");
        return;
      }
      if (cmd === "config") {
        ctx.ui.notify([
          "Advisor config (3 fields, all optional):",
          `  mode: "${cfg.mode}" — auto (preflight+post+cache) | manual | off`,
          `  review: "${cfg.review}" — light (changes/errors) | strict (every 3) | off`,
          `  model: "${cfg.model || "auto"}" — optional override`,
          "",
          "Run /advisor <question> for immediate advice.",
        ].join("\n"), "info");
        return;
      }
      if (cmd === "review") {
        const v = rest[0];
        if (v === "light" || v === "strict" || v === "off") { saveConfig({ ...cfg, review: v }); ctx.ui.notify(`Review set to ${v}.`, "info"); return; }
        ctx.ui.notify("Usage: /advisor review light|strict|off", "error");
        return;
      }

      // Anything else: treat as a question to the advisor
      const r = await askAdvisor(pi, ctx, a, "slash", true);
      ctx.ui.notify(r.text, r.error ? "warning" : "info");
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI) { registerAdvisor(pi); }
