import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { featureFile, readText, truncate, writeText } from "./internal.js";
import { advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";
import {
  appendRouteLog,
  binaryGatePredict,
  formatAdvisorDisplay,
  heuristicRoute,
  mergeReviewPolicy,
  routeNote,
  summarizeRoute,
  type AdvisorRouteDecision,
  type AdvisorRouteInput,
  type ReviewPolicy,
} from "./router.js";
import { classifyIntent, classifyMode } from "./preflight-signals.js";

// ── Config: 3 optional fields ────────────────────────────────────────────

export interface AdvisorConfig {
  /** "auto" (preflight+post+cache), "manual" (just /advisor), "off" */
  mode: "auto" | "manual" | "off";
  /** "light" (file changes/errors only) | "strict" (every 3 turns) | "off" */
  review: "light" | "strict" | "off";
  /** Opportunistic advisor check-ins during long sessions. */
  checkins: "mid-hour" | "off";
  /** Minutes between check-ins; bounded and cheap-gated by recent activity. */
  checkinIntervalMinutes: number;
  /** Optional start time (ms since epoch) for the active check-in stream. */
  checkinStartedAt?: number;
  /** Optional model override. Auto-detects SOTA (gpt-5.5, claude-opus-4-6…) if unset */
  model?: string;
}

const DEFAULT_CONFIG: AdvisorConfig = {
  mode: "auto",
  review: "light",
  checkins: "off",
  checkinIntervalMinutes: 30,
};

const CONFIG_PATH = featureFile("advisor", "config.json");
const STATE_PATH = featureFile("advisor", "state.json");
const CACHE_PATH = featureFile("advisor", "cache.json");
const CURRENT_PATH = featureFile("advisor", "current.md");
const HISTORY_PATH = featureFile("advisor", "history.jsonl");
const ORCHESTRATION_DIR = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration");

const MAX_CACHE = 64;
const MAX_NOTES = 12;
const MAX_FILES = 8;
const MAX_ERRORS = 5;
const MIN_CHECKIN_INTERVAL_MINUTES = 10;
const MAX_CHECKIN_INTERVAL_MINUTES = 240;
const checkinLocks = new Set<string>();

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
  router: {
    preflight?: AdvisorRouteDecision;
    review?: AdvisorRouteDecision;
  };
  checkin: {
    lastAt?: string;
    lastTurn?: number;
    lastReason?: string;
    queued?: boolean;
    queuedReason?: string;
  };
  reviewControl: ReviewControlState;
  advisorPauseUntilTurn?: number;
}
function defaultReviewControl(): ReviewControlState {
  return {
    status: "idle",
    pending: false,
    consumed: true,
    running: false,
  };
}

function defaultState(): SessionState {
  return {
    turns: 0,
    lastTask: "",
    notes: [],
    files: [],
    errors: [],
    advisorCalls: 0,
    cacheHits: 0,
    followUp: "",
    router: {},
    checkin: { queued: false },
    reviewControl: defaultReviewControl(),
  };
}

// ── File I/O ──────────────────────────────────────────────────────────────
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readText(path) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, v: unknown) {
  writeText(path, JSON.stringify(v, null, 2) + "\n");
}

export function normalizeAdvisorConfig(raw: Partial<AdvisorConfig> = {}): AdvisorConfig {
  const interval = Number(raw.checkinIntervalMinutes ?? DEFAULT_CONFIG.checkinIntervalMinutes);
  const startedAt = Number(raw.checkinStartedAt);
  return {
    mode: (raw.mode === "manual" || raw.mode === "off") ? raw.mode : "auto",
    review: (raw.review === "strict" || raw.review === "off") ? raw.review : "light",
    checkins: raw.checkins === "mid-hour" ? "mid-hour" : DEFAULT_CONFIG.checkins,
    checkinIntervalMinutes: Math.min(
      MAX_CHECKIN_INTERVAL_MINUTES,
      Math.max(
        MIN_CHECKIN_INTERVAL_MINUTES,
        Number.isFinite(interval) ? Math.round(interval) : DEFAULT_CONFIG.checkinIntervalMinutes,
      ),
    ),
    checkinStartedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    model: raw.model || undefined,
  };
}

function loadConfig(): AdvisorConfig {
  return normalizeAdvisorConfig(readJson<Partial<AdvisorConfig>>(CONFIG_PATH, {}));
}

function saveConfig(c: AdvisorConfig) {
  writeJson(CONFIG_PATH, c);
}

function loadState(): SessionState {
  const raw = readJson<Partial<SessionState>>(STATE_PATH, {});
  const control = raw.reviewControl;
  const pauseUntil = Number(raw.advisorPauseUntilTurn);
  return {
    turns: raw.turns ?? 0,
    lastTask: raw.lastTask ?? "",
    notes: (raw.notes ?? []).map(noteText).filter(Boolean).slice(-MAX_NOTES),
    files: (raw.files ?? []).slice(-MAX_FILES),
    errors: (raw.errors ?? []).slice(-MAX_ERRORS),
    advisorCalls: raw.advisorCalls ?? 0,
    cacheHits: raw.cacheHits ?? 0,
    followUp: raw.followUp ?? "",
    router: {
      preflight: raw.router?.preflight,
      review: raw.router?.review,
    },
    checkin: {
      lastAt: raw.checkin?.lastAt,
      lastTurn: raw.checkin?.lastTurn,
      lastReason: raw.checkin?.lastReason,
      queued: Boolean(raw.checkin?.queued),
      queuedReason: raw.checkin?.queuedReason,
    },
    reviewControl: {
      status: (control?.status === "needed" || control?.status === "running" || control?.status === "consumed" || control?.status === "idle") ? control.status : "idle",
      pending: Boolean(control?.pending),
      consumed: control?.consumed !== false,
      running: Boolean(control?.running),
      lastDecision: control?.lastDecision,
      lastMaterialSignature: control?.lastMaterialSignature,
      lastReason: control?.lastReason,
      lastTrigger: control?.lastTrigger,
      lastAppliedAt: control?.lastAppliedAt,
    },
    advisorPauseUntilTurn: Number.isFinite(pauseUntil) ? pauseUntil : undefined,
  };
}

function saveState(s: SessionState) {
  writeJson(STATE_PATH, s);
}

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
  "notify": false
}`;

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

function noteText(note: unknown): string {
  const text = contentText(note);
  if (/^\[object Object\](,\[object Object\])*$/.test(text)) return "";
  if (text) return squish(text, 500);
  if (note && typeof note === "object") return squish(JSON.stringify(note), 500);
  return text;
}

function normalizeReviewSignals(materialSignals: string[] = []): string[] {
  return [...new Set(materialSignals.filter(Boolean).map((signal) => squish(signal)))].sort();
}

function reviewMaterialSignature(state: SessionState, delta: string, meta: ReviewMaterialMeta): string {
  const signals = normalizeReviewSignals(meta.materialSignals);
  return hash(
    "rev",
    state.lastTask || "",
    String(meta.isAgentEnd),
    String(meta.fileChanged),
    String(meta.failed),
    delta || "(none)",
    ...signals,
  );
}

function shouldSkipReview(state: SessionState, signature: string): boolean {
  return Boolean(signature && state.reviewControl.lastMaterialSignature === signature && !state.reviewControl.running);
}

function consumeReviewFollowUp(state: SessionState): void {
  state.followUp = "";
  state.reviewControl = {
    ...state.reviewControl,
    status: "consumed",
    pending: false,
    consumed: true,
    running: false,
    lastAppliedAt: new Date().toISOString(),
  };
}

function markReviewSkipped(state: SessionState, signature: string, trigger: string): void {
  state.reviewControl = {
    ...state.reviewControl,
    status: "consumed",
    running: false,
    consumed: true,
    pending: false,
    lastMaterialSignature: signature,
    lastDecision: "defer",
    lastTrigger: trigger,
    lastReason: "repeated material snapshot",
    lastAppliedAt: new Date().toISOString(),
  };
}

function markReviewRunning(state: SessionState, signature: string, trigger: string): void {
  state.reviewControl = {
    ...state.reviewControl,
    status: "running",
    running: true,
    pending: true,
    consumed: false,
    lastMaterialSignature: signature,
    lastTrigger: trigger,
  };
}

function markReviewApplied(state: SessionState, signature: string, trigger: string, decision: "continue" | "review" | "defer", reason: string, consumed: boolean): void {
  state.reviewControl = {
    ...state.reviewControl,
    status: consumed ? "consumed" : "needed",
    running: false,
    pending: !consumed,
    consumed,
    lastMaterialSignature: signature,
    lastDecision: decision,
    lastTrigger: trigger,
    lastReason: reason,
    lastAppliedAt: new Date().toISOString(),
  };
}

function persistReviewState(state: SessionState, includeReviewRoute: boolean): void {
  const persisted = loadState();
  persisted.reviewControl = state.reviewControl;
  persisted.followUp = state.followUp;
  persisted.advisorPauseUntilTurn = state.advisorPauseUntilTurn;
  if (includeReviewRoute && state.router.review) {
    persisted.router.review = state.router.review;
  }
  saveState(persisted);
}

function recoverReviewControl(state: SessionState): void {
  if (!state.reviewControl.running) return;

  const pending = Boolean(state.reviewControl.pending);
  state.reviewControl = {
    ...state.reviewControl,
    running: false,
    status: pending ? "needed" : state.reviewControl.status === "needed" ? "needed" : "idle",
    consumed: !pending,
    lastAppliedAt: new Date().toISOString(),
  };
}

type AdvisorHintDetails = {
  decision?: "continue" | "review" | "defer";
  reason?: string;
  summary?: string;
  actions?: string[];
};

type ReviewControlState = {
  status: "idle" | "needed" | "running" | "consumed";
  pending: boolean;
  consumed: boolean;
  running: boolean;
  lastDecision?: "continue" | "review" | "defer";
  lastMaterialSignature?: string;
  lastReason?: string;
  lastTrigger?: string;
  lastAppliedAt?: string;
};

type ReviewMaterialMeta = {
  fileChanged: boolean;
  failed: boolean;
  isAgentEnd: boolean;
  materialSignals?: string[];
};
function sendAdvisorHint(pi: ExtensionAPI, decision: "continue" | "review" | "defer", reason: string, summary: string, actions: string[] = []) {
  pi.sendMessage(
    {
      customType: "advisor:llm",
      content: reason,
      display: true,
      details: { decision, reason, summary, actions: actions.slice(0, 2) },
    },
    { deliverAs: "followUp" },
  );
}

function renderAdvisorHint(message: any, options: { expanded?: boolean }, theme: any) {
  const details = (message?.details ?? {}) as AdvisorHintDetails;
  const customType = String(message?.customType ?? "advisor:rules");
  const decision = details.decision ?? "defer";
  const sourceColor = customType === "advisor:llm" ? "success" : customType === "advisor:model" ? "accent" : "muted";
  const decisionColor = decision === "review" ? "accent" : decision === "continue" ? "muted" : "dim";
  const source = theme.bold(theme.fg(sourceColor, `[${customType}]`));
  const verdict = theme.bold(theme.fg(decisionColor, decision));
  const glyph = decision === "review" ? "↗" : decision === "defer" ? "…" : "·";
  const reason = squish(details.reason || contentText(message?.content) || "no extra detail", 180);

  const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
  box.addChild(new Text(`${theme.bold(theme.fg(decisionColor, glyph))} ${source} ${verdict} · ${theme.fg("dim", "reason: ")}${reason}`, 0, 0));

  if (options.expanded && details.summary) {
    box.addChild(new Text(theme.fg("dim", `summary: ${squish(details.summary, 220)}`), 0, 0));
  }
  if (options.expanded && details.actions?.length) {
    box.addChild(new Text(theme.fg("dim", `actions: ${details.actions.map((a) => squish(a, 80)).join(" • ")}`), 0, 0));
  }

  return box;
}

/** Extract readable text from message content (handles strings, blocks, and nested message payloads). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text.trim();
    if (obj.content !== undefined) return contentText(obj.content);
    if (obj.message !== undefined) return contentText(obj.message);
    return "";
  }
  if (!Array.isArray(content)) return String(content ?? "").trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") { parts.push(item); continue; }
    const obj = item as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    else if (typeof obj.text === "string") parts.push(obj.text);
    else if (obj.content !== undefined) {
      const nested = contentText(obj.content);
      if (nested) parts.push(nested);
    }
    else if (obj.message !== undefined) {
      const nested = contentText(obj.message);
      if (nested) parts.push(nested);
    }
  }
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

/** Check if a tool result or message indicates an actual execution failure */
function isActualFailure(tool: any): boolean {
  if (tool?.isError === true) return true;
  if (tool?.status === "error" || tool?.status === "failure") return true;
  if (tool?.error && String(tool.error).length > 0) return true;
  return false;
}

function responseText(resp: { content?: Array<{ type?: string; text?: string }> } | null | undefined): string {
  return (resp?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
}

function mergeRouteReview(configReview: AdvisorConfig["review"], route?: ReviewPolicy): ReviewPolicy {
  if (configReview === "off") return "off";
  if (!route) return configReview;
  return mergeReviewPolicy(configReview, route);
}

function sessionKey(ctx: any): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!sessionFile) return "session";
  return basename(String(sessionFile)).replace(/\.[^.]+$/, "");
}

type OrchestrationSnapshot = {
  goal: string;
  loop: { enabled?: boolean; interval?: string; instruction?: string };
  research: { instruction?: string; interval?: string; cycles?: number; lastResult?: string };
};

function readOrchestrationSnapshot(ctx: any): OrchestrationSnapshot {
  const dir = join(ORCHESTRATION_DIR, sessionKey(ctx));
  return {
    goal: readText(join(dir, "goal.md")).trim(),
    loop: readJson(join(dir, "loop.json"), {}),
    research: readJson(join(dir, "autoresearch.json"), {}),
  };
}

function orchestrationSnapshotText(ctx: any): string {
  const snapshot = readOrchestrationSnapshot(ctx);
  const goalActive = Boolean(snapshot.goal);
  const loopActive = Boolean(snapshot.loop.enabled && snapshot.loop.instruction);
  const researchActive = Boolean(snapshot.research.instruction);
  const status = goalActive && !loopActive && !researchActive
    ? "setup gap — goal exists but no active autoresearch/loop progression"
    : goalActive
      ? "progression configured"
      : "no active goal";
  return [
    "Orchestration:",
    `- Goal: ${goalActive ? `active — ${truncate(snapshot.goal, 360)}` : "off"}`,
    `- Autoresearch: ${researchActive ? `active — ${truncate(snapshot.research.instruction || "", 240)}; cycles=${snapshot.research.cycles ?? 0}${snapshot.research.lastResult ? `, last=${snapshot.research.lastResult}` : ""}` : "off"}`,
    `- Loop: ${loopActive ? `active every ${snapshot.loop.interval || "?"} — ${truncate(snapshot.loop.instruction || "", 260)}` : "off"}`,
    `- Status: ${status}`,
  ].join("\n");
}

export function buildAdvisorCheckinPrompt(source: string, orchestration: string, sessionBrief: string): string {
  return [
    `Mid-session check-in (${source})`,
    "Role: alignment reviewer for the active work. Do not create a new task, research direction, benchmark, script, artifact, or model switch unless the active goal explicitly asks for it.",
    "Stay anchored to the active goal/autoresearch/loop. If autoresearch is active, preserve its research question and judge whether the latest work is gathering evidence toward that question.",
    "Bad nudge examples: research the existence of weaknesses instead of solving the named weakness; create a script/report about weaknesses when the goal is to fix advisor behavior; swap to a shallower research mode.",
    "Return exactly two short lines:",
    "Status: on_track|stuck|off_track - <why, tied to the active goal>",
    "Nudge: <one concrete next action that continues the active goal>",
    orchestration,
    sessionBrief ? `Session brief:\n${sessionBrief}` : "",
  ].filter(Boolean).join("\n\n");
}

function advisorPauseRemaining(state: SessionState, nowTurns = state.turns): number {
  const until = state.advisorPauseUntilTurn;
  if (until === undefined || Number.isNaN(until)) return 0;
  return Math.max(0, until - nowTurns);
}

function isAdvisorPaused(state: SessionState, nowTurns = state.turns): boolean {
  return advisorPauseRemaining(state, nowTurns) > 0;
}

function isAdvisorAutoRunSuppressed(state: SessionState, nowTurns = state.turns): boolean {
  return isAdvisorPaused(state, nowTurns);
}

function isAdvisorAutoRunSuppressedForTurnContext(state: SessionState, nowTurns = state.turns): boolean {
  return isAdvisorAutoRunSuppressed(state, nowTurns) || isAdvisorAutoRunSuppressed(state, nowTurns - 1);
}

function checkinDescription(config: AdvisorConfig): string {
  if (config.checkins === "off") return "checkins off";
  return `checkins ${config.checkinIntervalMinutes}m`;
}

function setPiRogueStatus(ctx: any, config = loadConfig(), state = loadState()): void {
  const normalized = normalizeAdvisorConfig(config);
  const checkin = checkinDescription(normalized);
  const pause = advisorPauseRemaining(state, state.turns);
  const pauseText = pause > 0 ? ` · pause ${pause} turn${pause === 1 ? "" : "s"}` : "";
  const last = state.checkin.lastAt ? ` · last ${new Date(state.checkin.lastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  ctx.ui.setStatus("pi-rogue", `☠︎ advisor ${normalized.mode}/${normalized.review} · ${checkin}${pauseText}${last}`);
}

export function shouldRunCheckin(config: AdvisorConfig, state: SessionState, now = Date.now(), startedAt = now, options: { ignoreInterval?: boolean } = {}): string | null {
  if (isAdvisorAutoRunSuppressed(state, state.turns)) return null;
  const normalized = normalizeAdvisorConfig(config);
  if (normalized.mode === "off" || normalized.mode === "manual") return null;
  if (normalized.checkins === "off") return null;
  if (state.checkin.queued) {
    return state.checkin.queuedReason || "Queued mid-session check-in.";
  }
  if (!state.lastTask && state.notes.length === 0) return null;

  const lastTurn = state.checkin.lastTurn ?? 0;
  if (state.turns <= lastTurn) return null;
  if (options.ignoreInterval) return `loop check-in after ${state.turns - lastTurn} new turn(s)`;

  const lastAt = state.checkin.lastAt ? Date.parse(state.checkin.lastAt) : 0;
  const intervalMs = normalized.checkinIntervalMinutes * 60_000;
  const streamStartedAt = Number.isFinite(normalized.checkinStartedAt ?? NaN)
    ? (normalized.checkinStartedAt as number)
    : startedAt;
  const since = Math.max(lastAt, streamStartedAt);
  if (since && now - since < intervalMs) return null;
  return `mid-hour check-in after ${state.turns - lastTurn} new turn(s)`;
}


function isAdvisorIdle(ctx: any): boolean {
  try {
    return typeof ctx?.isIdle === "function" ? ctx.isIdle() : true;
  } catch {
    return true;
  }
}

export async function requestAdvisorLoopCheckin(pi: ExtensionAPI, ctx: any, source = "loop_tick"): Promise<boolean> {
  return maybeAdvisorCheckin(pi, ctx, source);
}

async function maybeAdvisorCheckin(pi: ExtensionAPI, ctx: any, source: string): Promise<boolean> {
  const key = sessionKey(ctx);
  if (checkinLocks.has(key)) return false;

  const config = loadConfig();
  const state = loadState();
  const reason = shouldRunCheckin(config, state, Date.now(), Date.now(), { ignoreInterval: source === "loop_tick" });
  if (!reason) {
    if (state.checkin.queued) {
      state.checkin.queued = false;
      saveState(state);
      setPiRogueStatus(ctx, config, state);
    }
    return false;
  }

  if (!isAdvisorIdle(ctx)) {
    if (!state.checkin.queued) {
      state.checkin.queued = true;
      state.checkin.queuedReason = reason;
      saveState(state);
      setPiRogueStatus(ctx, config, state);
    }
    return false;
  }

  checkinLocks.add(key);
  try {
    const prompt = buildAdvisorCheckinPrompt(source, orchestrationSnapshotText(ctx), brief(state));
    const completed = await completeWithHigherAdvisorModel(
      ctx,
      config,
      prompt,
      [
        {
          role: "user",
          content: prompt,
          timestamp: new Date().toISOString(),
        },
      ],
      { maxTokens: 260, reasoning: "low" as ThinkingLevel },
    );
    if (!completed) return false;

    const next = loadState();
    next.checkin = {
      lastAt: new Date().toISOString(),
      lastTurn: next.turns,
      lastReason: reason,
      queued: false,
    };
    saveState(next);
    setPiRogueStatus(ctx, config, next);
    sendAdvisorHint(pi, "review", "mid-hour check-in", completed.text, [completed.text]);
    return true;
  } finally {
    checkinLocks.delete(key);
  }
}

function piRogueCockpitText(config: AdvisorConfig, state: SessionState, currentNote: string, orchestration = ""): string {
  const normalized = normalizeAdvisorConfig(config);
  const pause = advisorPauseRemaining(state, state.turns);
  return [
    "☠︎ Pi-Rogue cockpit",
    currentNote ? `Advisor: ${truncate(currentNote, 220)}` : "Advisor: no current note",
    `Mode: ${normalized.mode} | Review: ${normalized.review} | Check-ins: ${checkinDescription(normalized)}`,
    pause > 0 ? `Advisor pause: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "Advisor pause: off",
    `Turns: ${state.turns} | Advisor calls: ${state.advisorCalls} | Cache hits: ${state.cacheHits}`,
    state.checkin.lastAt ? `Last check-in: ${new Date(state.checkin.lastAt).toLocaleString()} (${state.checkin.lastReason || "mid-hour"})` : "Last check-in: never",
    state.checkin.queued ? `Queued check-in: ${state.checkin.queuedReason || "due"}` : "",
    orchestration,
    "",
    "Commands: /advisor status · /goal · /loop status · /autoresearch status",
  ].filter(Boolean).join("\n");
}

// ── Model resolution (higher/advanced first, then optional regular fallback) ──
type ResolvedAdvisorModel = { model: any; auth: any; label: string; fallback?: boolean };
type ModelResolutionOptions = { allowRegularFallback?: boolean };

export async function resolveModelCandidates(ctx: any, config: AdvisorConfig, options: ModelResolutionOptions = {}): Promise<ResolvedAdvisorModel[]> {
  const { allowRegularFallback = true } = options;
  const candidates: ResolvedAdvisorModel[] = [];
  const seen = new Set<string>();
  const add = async (found: any, label: string, fallback = false) => {
    if (!found) return;
    const key = String(found.id || label);
    if (seen.has(key)) return;
    const auth = await ctx.modelRegistry?.getApiKeyAndHeaders(found);
    if (auth?.ok && auth.apiKey) {
      seen.add(key);
      candidates.push({ model: found, auth, label, fallback });
    }
  };

  // Try configured higher/advanced advisor model first.
  if (config.model && config.model.includes("/")) {
    const [p, ...m] = config.model.split("/");
    await add(ctx.modelRegistry?.find(p, m.join("/")), p + "/" + m.join("/"));
  }

  // Fall through SOTA chain.
  for (const sota of SOTA_CHAIN) {
    await add(ctx.modelRegistry?.find(sota.provider, sota.model), sota.label);
  }

  if (allowRegularFallback) {
    // Final fallback: any configured text model, i.e. the regular session-capable model.
    for (const m of (ctx.modelRegistry?.getAvailable() ?? []).filter((model: any) => model.input?.includes?.("text"))) {
      await add(m, m.id || "regular model", true);
    }
  }

  return candidates;
}

async function resolveModel(ctx: any, config: AdvisorConfig): Promise<ResolvedAdvisorModel | null> {
  return (await resolveModelCandidates(ctx, config))[0] ?? null;
}

export async function completeWithModelFallback(ctx: any, config: AdvisorConfig, systemPrompt: string, messages: any[], options: { maxTokens: number; reasoning: ThinkingLevel }): Promise<{ text: string; model: string; fallback?: boolean } | null> {
  let lastError = "";
  for (const resolved of await resolveModelCandidates(ctx, config)) {
    try {
      const resp = await completeSimple(resolved.model, { systemPrompt, messages }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: options.maxTokens,
        reasoning: options.reasoning,
      });
      return { text: responseText(resp) || "(empty)", model: resolved.label, fallback: resolved.fallback };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return lastError ? { text: `No advisor/check-in model completed successfully (${lastError}).`, model: "none" } : null;
}

export async function completeWithHigherAdvisorModel(
  ctx: any,
  config: AdvisorConfig,
  systemPrompt: string,
  messages: any[],
  options: { maxTokens: number; reasoning: ThinkingLevel; allowRegularFallback?: boolean },
): Promise<{ text: string; model: string } | null> {
  const { allowRegularFallback = true } = options;
  for (const resolved of await resolveModelCandidates(ctx, config, { allowRegularFallback })) {
    try {
      const resp = await completeSimple(resolved.model, { systemPrompt, messages }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: options.maxTokens,
        reasoning: options.reasoning,
      });
      return { text: responseText(resp) || "(empty)", model: resolved.label };
    } catch {
      // keep trying remaining candidates
    }
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

  const msgs = [
    { role: "user", content: [ `Question: ${question}`, scope ? `Scope: ${scope}` : "", includeWork && brief(state) ? `Session:\n${brief(state)}` : "" ].filter(Boolean).join("\n"), timestamp: new Date().toISOString() },
  ] as any[];

  const completed = await completeWithModelFallback(ctx, config, ADVISOR_SYSTEM, msgs, { maxTokens: 600, reasoning: "medium" as ThinkingLevel });
  if (!completed) return { text: "No model available. Install one via pi config.", error: "no_model" };
  const text = completed.text;
  if (text && text !== "(empty)") { cache[ck] = text; saveCache(cache); }
  state.advisorCalls++;
  saveState(state);
  return { text, model: completed.model, fallback: completed.fallback };
}

async function doReview(pi: ExtensionAPI, ctx: any, trigger: string, delta: string, meta: ReviewMaterialMeta) {
  const config = loadConfig();
  if (config.review === "off") return;
  const state = loadState();

  const signature = reviewMaterialSignature(state, delta, meta);
  if (state.reviewControl.running) {
    return;
  }
  if (shouldSkipReview(state, signature)) {
    markReviewSkipped(state, signature, trigger);
    persistReviewState(state, false);
    return;
  }

  markReviewRunning(state, signature, trigger);
  persistReviewState(state, false);

  let finalized = false;
  let finalDecision: "continue" | "review" | "defer" = "defer";
  let finalReason = "pending review";

  try {
    const phase: AdvisorRouteInput["phase"] = meta.isAgentEnd ? "closeout" : "review";
    const reviewInput: AdvisorRouteInput = {
      phase,
      text: delta || "(none)",
      brief: brief(state),
      fileChanged: meta.fileChanged,
      failed: meta.failed,
    };
    const reviewHeuristic = heuristicRoute(reviewInput);
    const gatePrediction = binaryGatePredict(reviewInput.text);
    let reviewRoute = reviewHeuristic;
    if (gatePrediction && gatePrediction.confidence >= 0.55 && !reviewHeuristic.safety) {
      const gateContinues = gatePrediction.decision === "continue";
      reviewRoute = {
        ...reviewHeuristic,
        label: gateContinues ? "abstain" : reviewHeuristic.label,
        confidence: gatePrediction.confidence,
        source: "model",
        reason: gateContinues
          ? "local gate predicts continue"
          : "local gate predicts review",
        review: gateContinues ? "off" as const : reviewHeuristic.review,
        escalate: gateContinues ? false : reviewHeuristic.escalate,
      };
    }
    appendRouteLog(reviewRoute);
    state.router.review = reviewRoute;
    persistReviewState(state, true);

    if (gatePrediction && gatePrediction.confidence >= 0.55 && gatePrediction.decision === "continue" && !reviewHeuristic.safety) {
      finalDecision = "continue";
      finalReason = "local gate continue";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const effectiveReview = mergeRouteReview(config.review, state.router.preflight?.review);
    const finalReview = mergeReviewPolicy(effectiveReview, reviewRoute.review);
    if (finalReview === "off") {
      finalDecision = "continue";
      finalReason = "review disabled";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const shouldRun =
      finalReview === "strict"
        ? meta.isAgentEnd || meta.fileChanged || meta.failed || reviewRoute.label !== "abstain" || state.turns % 3 === 0
        : meta.fileChanged || meta.failed;
    if (!shouldRun) {
      finalDecision = "defer";
      finalReason = "no material signal";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const b = brief(state);
    if (!b) {
      finalDecision = "defer";
      finalReason = "missing brief context";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const rk = hash("rev", trigger, b, delta, String(meta.fileChanged), String(meta.failed), String(meta.isAgentEnd), String(reviewRoute.label), signature);
    const cache = loadCache();
    if (cache[rk]) {
      finalDecision = "defer";
      finalReason = "cached verdict";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const msgs = [
      { role: "user", content: [
        `Trigger: ${trigger}`,
        `Task: ${state.lastTask || "(unknown)"}`,
        `Delta: ${delta || "(none)"}`,
        `Files: ${meta.fileChanged} Errors: ${meta.failed}`,
        `Route: ${summarizeRoute(reviewRoute)}`,
        `Brief:\n${b}`,
      ].join("\n"), timestamp: new Date().toISOString() },
    ] as any[];
    const completed = await completeWithModelFallback(ctx, config, REVIEW_SYSTEM, msgs, { maxTokens: 400, reasoning: "low" as ThinkingLevel });
    const raw = completed?.text;
    if (!raw) {
      finalDecision = "defer";
      finalReason = "empty verdict";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    cache[rk] = raw;
    saveCache(cache);

    let json: any = null;
    try { json = JSON.parse(raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "")); } catch { /* ignore */ }
    if (!json) {
      finalDecision = "defer";
      finalReason = "unparseable verdict";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    if (json.verdict === "skip") {
      finalDecision = "defer";
      finalReason = "explicit skip";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    if (json.verdict === "on_track") {
      finalDecision = "continue";
      finalReason = (json.reason || json.summary || "review result").slice(0, 120);
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const decision = json.verdict === "course_correct" ? "review"
      : json.verdict === "not_done" ? "review"
        : "defer";
    finalDecision = decision;
    finalReason = (json.reason || json.summary || "review result").slice(0, 120);

    const display = formatAdvisorDisplay("advisor:llm", decision, finalReason);
    writeText(CURRENT_PATH, `${display}\n`);
    sendAdvisorHint(pi, decision, finalReason, json.summary || "", json.actions || []);

    if (json.verdict !== "on_track") {
      state.followUp = [json.summary, ...(json.actions?.slice(0, 2) || [])].filter(Boolean).join(" — ");
    }

    markReviewApplied(state, signature, trigger, finalDecision, finalReason, false);
    persistReviewState(state, true);
    finalized = true;
  } finally {
    if (!finalized) {
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, false);
      persistReviewState(state, true);
    }
  }
}

// ── Extension entry point ──────────────────────────────────────────────────

export function registerAdvisor(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueAdvisorRegistered) return;
  p.__piRogueAdvisorRegistered = true;

  for (const customType of ["advisor:model", "advisor:rules", "advisor:llm"] as const) {
    pi.registerMessageRenderer(customType, renderAdvisorHint);
  }

  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    checkinLocks.delete(key);
    const state = loadState();
    recoverReviewControl(state);
    saveState(state);
    setPiRogueStatus(ctx, loadConfig(), state);
    // No timer is owned by advisor itself anymore; check-ins are triggered
    // from active goal/loop/autoresearch flow progression.
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    checkinLocks.delete(key);
    ctx.ui.setStatus("pi-rogue", undefined);
  });

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
      onUpdate?.({ content: [{ type: "text", text: r.cached ? "(cached)" : r.model ? `Consulting ${r.model}…` : "" }], details: {} });
      return { content: [{ type: "text", text: r.text }], details: { cached: r.cached, error: r.error } };
    },
  });

  // ── Preflight (heuristics only — no LLM call, <1ms) ──────────────────
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    const state = loadState();
    const hasFollowUp = Boolean(state.followUp);
    if ((isAdvisorAutoRunSuppressed(state, state.turns) && !hasFollowUp) || cfg.mode === "off" || cfg.mode === "manual") {
      return { systemPrompt: event.systemPrompt };
    }
    setPiRogueStatus(ctx, cfg, state);
    const prompt = typeof event.prompt === "string" && event.prompt.trim() ? squish(event.prompt, 1000) : "";
    if (prompt) state.lastTask = prompt;
    const briefText = brief(state);
    const intent = prompt ? classifyIntent(prompt) : "";
    const mode = prompt ? classifyMode(prompt) : "";
    const intentTag = intent ? `Intent: ${intent}` : "";
    const modeTag = mode ? `Mode: ${mode}` : "";
    // Enrich preflight text with session context so the binary gate has more signal
    const enrichedText = [prompt, event.systemPrompt || "", briefText ? `Brief: ${briefText}` : "", intentTag, modeTag].filter(Boolean).join(" ");
    const routeInput: AdvisorRouteInput = { phase: "preflight", text: enrichedText || prompt || event.systemPrompt || briefText || intentTag || modeTag || "", brief: briefText };

    // Binary gate model — fast local classifier for continue/escalate decisions
    const gatePrediction = binaryGatePredict(routeInput.text);
    const heuristic = heuristicRoute(routeInput);
    let route: AdvisorRouteDecision;
    if (gatePrediction && gatePrediction.confidence >= 0.55) {
      const binLabel = gatePrediction.decision === "continue" ? "continue" as const : "escalate_to_advisor" as const;
      if (heuristic.safety) {
        route = heuristic;
      } else {
        route = {
          ...heuristic,
          label: binLabel,
          confidence: gatePrediction.confidence,
          reason: gatePrediction.decision === "continue"
            ? "local gate predicts continue"
            : "local gate predicts review",
          source: "model",
          preflight: binLabel === "continue" ? "off" as const : "full" as const,
          escalate: binLabel === "escalate_to_advisor",
        };
      }
    } else {
      route = heuristic;
    }
    appendRouteLog(route);
    state.router.preflight = route;
    const follow = state.followUp;
    if (follow) {
      consumeReviewFollowUp(state);
    }
    saveState(state);

    const note = routeNote(route);
    const control = state.reviewControl;
    const controlTag = control.status === "needed" || control.status === "running" ? `Review-control: ${control.status}${control.lastDecision ? ` (${control.lastDecision})` : ""}` : "";
    writeText(CURRENT_PATH, `${note}\n`);
    return {
      systemPrompt: [
        event.systemPrompt,
        follow ? `Advisor follow-up:\n${follow}` : "",
        note,
        controlTag,
        briefText ? `Brief (cache-aware):\n${briefText}` : "",
      ].filter(Boolean).join("\n\n"),
    };
  });

  // ── Post-review (turn_end) ─────────────────────────────────────────────
  pi.on("turn_end", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const state = loadState();
    const suppressedThisTurn = isAdvisorAutoRunSuppressedForTurnContext(state, state.turns);
    const tools = (event.toolResults || []).map((t: any) => String(t?.toolName || t?.name || "tool"));
    const fileChanged = tools.some((t: string) => /^(edit|write)$/i.test(t));
    const failed = (event.toolResults || []).some((t: any) => isActualFailure(t));
    const text = squish(contentText(event.message?.content));
    if (text && text !== state.notes[state.notes.length - 1]) state.notes.push(text);
    state.turns++;
    if (state.advisorPauseUntilTurn && isAdvisorPaused(state, state.turns) === false) {
      state.advisorPauseUntilTurn = undefined;
    }
    saveState(state);
    setPiRogueStatus(ctx, cfg, state);
    if (cfg.review !== "off" && !suppressedThisTurn) {
      await doReview(pi, ctx, `turn-${state.turns}`, text, {
        fileChanged,
        failed,
        isAgentEnd: false,
        materialSignals: tools,
      });
    }

    const post = loadState();
    if (!isAdvisorAutoRunSuppressed(post, post.turns)) {
      void maybeAdvisorCheckin(pi, ctx, "turn_end");
    }
  });

  // ── Post-review (agent_end) ────────────────────────────────────────────
  pi.on("agent_end", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const state = loadState();
    const suppressed = isAdvisorAutoRunSuppressedForTurnContext(state, state.turns);
    if (cfg.review === "off" || suppressed) {
      if (!suppressed) {
        void maybeAdvisorCheckin(pi, ctx, "agent_end");
      }
      return;
    }

    const msgs = (event.messages || []).filter((m: any) => m.role === "assistant" || m.role === "toolResult");
    const last = msgs[msgs.length - 1];
    const delta = contentText(last?.content) || "(none)";
    const fileChanged = msgs.some((m: any) => /(?:write|edit)/i.test(JSON.stringify(m)));
    const failed = msgs.some((m: any) => isActualFailure(m));
    const signals = msgs.map((m: any) => {
      const sig = contentText(m?.content);
      return `${m?.role || "msg"}: ${sig ? squish(sig, 120) : "(empty)"}`;
    });
    await doReview(pi, ctx, "agent-end", delta, {
      fileChanged,
      failed,
      isAgentEnd: true,
      materialSignals: signals,
    });

    const post = loadState();
    if (!isAdvisorAutoRunSuppressed(post, post.turns)) {
      void maybeAdvisorCheckin(pi, ctx, "agent_end");
    }
  });

  // ── /pi-rogue cockpit ──────────────────────────────────────────────────
  pi.registerCommand("pi-rogue", {
    description: "Show Pi-Rogue cockpit: advisor and orchestration command pointers",
    getArgumentCompletions: (prefix: string) => piRogueArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const state = loadState();
      const arg = String(args ?? "").trim().toLowerCase();
      setPiRogueStatus(ctx, cfg, state);

      if (!arg || arg === "status" || arg === "help") {
        ctx.ui.notify(piRogueCockpitText(cfg, state, readText(CURRENT_PATH).trim(), orchestrationSnapshotText(ctx)), "info");
        return;
      }

      if (arg.startsWith("advisor")) {
        ctx.ui.notify([
          "Advisor surface:",
          "  /advisor status",
          "  /advisor config",
          "  /advisor <question>",
          "",
          "Check-ins are orchestration-managed: start /loop to activate them.",
        ].join("\n"), "info");
        return;
      }

      if (arg.startsWith("orchestration")) {
        ctx.ui.notify([
          "Orchestration surface:",
          "  /goal show|clear|list|set <text>",
          "  /loop status|off|clear|stop|<interval> <instruction>",
          "  /autoresearch status|clear|<instruction>",
          "  /autoresearch-lab status|clear|<instruction>",
        ].join("\n"), "info");
        return;
      }

      if (arg.startsWith("checkins")) {
        ctx.ui.notify([
          `Check-ins: ${checkinDescription(cfg)}`,
          "Managed by orchestration: /loop activates them; stopping the loop disables them.",
          orchestrationSnapshotText(ctx),
        ].join("\n"), "info");
        return;
      }

      ctx.ui.notify(piRogueCockpitText(cfg, state, readText(CURRENT_PATH).trim(), orchestrationSnapshotText(ctx)), "info");
    },
  });

  // ── /advisor command ───────────────────────────────────────────────────
  pi.registerCommand("advisor", {
    description: "Senior engineering advisor. Usage: /advisor [on|off|status|config|pause|unpause|question]",
    getArgumentCompletions: (prefix: string) => advisorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const a = String(args ?? "").trim().toLowerCase();
      const [cmd, ...rest] = a.split(/\s+/);
      const cfg = loadConfig();
      const state = loadState();

      if (!a || cmd === "status") {
        const note = readText(CURRENT_PATH).trim();
        const resolved = await resolveModel(ctx, cfg);
        const route = state.router.review ?? state.router.preflight;
        const pause = advisorPauseRemaining(state, state.turns);
        ctx.ui.notify([
          note ? `🧭 ${truncate(note, 200)}` : "",
          route ? `Router: ${summarizeRoute(route)}${route.safety ? " · safety" : ""}` : "",
          "",
          `Mode: ${cfg.mode} | Review: ${cfg.review} | Check-ins: ${checkinDescription(cfg)} (orchestration-managed) | Model: ${resolved?.label || cfg.model || "auto"}`,
          pause > 0 ? `Advisor pause: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "Advisor pause: off",
          `Turns: ${state.turns} | Calls: ${state.advisorCalls} | Cache hits: ${state.cacheHits}`,
          state.checkin.lastAt ? `Last check-in: ${new Date(state.checkin.lastAt).toLocaleString()} (${state.checkin.lastReason || "mid-hour"})` : "Last check-in: never",
          state.checkin.queued ? `Queued check-in: ${state.checkin.queuedReason || "due"}` : "",
          orchestrationSnapshotText(ctx),
          "",
          "Commands: /advisor on|off | /advisor status | /advisor config | /advisor pause <n turns> | <question>",
          "Tip: SOTA models auto-detected. No config needed.",
        ].filter(Boolean).join("\n"), "info");
        return;
      }

      if (cmd === "on" && cfg.mode === "off") {
        const next = { ...cfg, mode: "auto" as const };
        saveConfig(next);
        setPiRogueStatus(ctx, next, state);
        ctx.ui.notify("Advisor enabled (auto mode).", "info");
        return;
      }
      if (cmd === "off") {
        const next = { ...cfg, mode: "off" as const };
        saveConfig(next);
        setPiRogueStatus(ctx, next, state);
        ctx.ui.notify("Advisor disabled.", "info");
        return;
      }
      if (cmd === "mode") {
        const v = rest[0];
        if (v === "auto" || v === "manual") {
          const next: AdvisorConfig = { ...cfg, mode: v };
          saveConfig(next);
          setPiRogueStatus(ctx, next, state);
          ctx.ui.notify(`Mode set to ${v}.`, "info");
          return;
        }
        if (v === "off") {
          const next = { ...cfg, mode: "off" as const };
          saveConfig(next);
          setPiRogueStatus(ctx, next, state);
          ctx.ui.notify("Advisor disabled.", "info");
          return;
        }
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
        const pause = advisorPauseRemaining(state, state.turns);
        ctx.ui.notify([
          "Advisor config (check-ins are orchestration-managed):",
          `  mode: "${cfg.mode}" — auto (preflight+post+cache) | manual | off`,
          `  review: "${cfg.review}" — light (changes/errors) | strict (every 3) | off`,
          `  checkins: "${cfg.checkins}" — set by active /loop lifecycle`,
          `  checkinIntervalMinutes: ${cfg.checkinIntervalMinutes}`,
          pause > 0 ? `  advisorPauseUntilTurn: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "  advisorPauseUntilTurn: off",
          `  model: "${cfg.model || "auto"}" — optional override for higher/advanced advisor model`,
          "",
          "Router logs: evals/advisor-router.jsonl",
          "Run /advisor <question> for immediate advice.",
        ].join("\n"), "info");
        return;
      }
      if (cmd === "review") {
        const v = rest[0];
        if (v === "light" || v === "strict" || v === "off") { const next: AdvisorConfig = { ...cfg, review: v }; saveConfig(next); setPiRogueStatus(ctx, next, state); ctx.ui.notify(`Review set to ${v}.`, "info"); return; }
        ctx.ui.notify("Usage: /advisor review light|strict|off", "error");
        return;
      }
      if (cmd === "checkins" || cmd === "checkin") {
        ctx.ui.notify([
          "Advisor check-ins are orchestration-managed now.",
          `Current: ${checkinDescription(cfg)}`,
          "Create or resume /loop to activate scheduled higher-model check-ins; stop the loop to disable them.",
          orchestrationSnapshotText(ctx),
        ].join("\n"), "info");
        return;
      }

      if (cmd === "pause") {
        const value = rest[0];
        const turns = Number.parseInt(String(value || ""), 10);
        if (!Number.isFinite(turns) || turns <= 0) {
          if (value === "off" || value === "cancel" || value === "clear") {
            state.advisorPauseUntilTurn = undefined;
            saveState(state);
            ctx.ui.notify("Advisor pause cleared.", "info");
            return;
          }
          ctx.ui.notify("Usage: /advisor pause <turns>  (or /advisor pause off)", "error");
          return;
        }
        state.advisorPauseUntilTurn = state.turns + turns;
        saveState(state);
        ctx.ui.notify(`Advisor pause enabled for next ${turns} turn${turns === 1 ? "" : "s"}.`, "info");
        return;
      }

      if (cmd === "unpause") {
        state.advisorPauseUntilTurn = undefined;
        saveState(state);
        ctx.ui.notify("Advisor pause cleared.", "info");
        return;
      }

      // Anything else: treat as a question to the advisor
      const r = await askAdvisor(pi, ctx, a, "slash", true);
      ctx.ui.notify(r.text, r.error ? "warning" : "info");
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI) { registerAdvisor(pi); }
