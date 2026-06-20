import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { featureDir, featureFile, readText, truncate, writeText, atomicWriteText } from "./internal.js";
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
import { type TrajectoryFeatures } from "./binary-gate-eval.js";
import { classifyIntent, classifyMode } from "./preflight-signals.js";

// ── Config: 3 optional fields ────────────────────────────────────────────

export interface AdvisorConfig {
  /** "auto" (preflight+post+cache), "manual" (just /pi-rogue-advisor), "off" */
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
const LEGACY_STATE_PATH = featureFile("advisor", "state.json");
const CACHE_PATH = featureFile("advisor", "cache.json");
const HISTORY_PATH = featureFile("advisor", "history.jsonl");
const SESSION_STATE_PROP = "__piRogueAdvisorStatePath";
const ORCHESTRATION_DIR = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration");

const MAX_CACHE = 64;
const MAX_NOTES = 12;
const MAX_FILES = 8;
const MAX_ERRORS = 5;
const MIN_CHECKIN_INTERVAL_MINUTES = 10;
const MAX_CHECKIN_INTERVAL_MINUTES = 240;
const STATE_VERSION = 1;
const checkinLocks = new Set<string>();

const REVIEW_TASK_ACTIONS_LIMIT = 2;
const ADVISORY_SIGNALS_LIMIT = 4;

// ── SOTA models (ordered by preference) ───────────────────────────────────
const SOTA_CHAIN: Array<{ provider: string; model: string; label: string }> = [
  { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "openai-codex", model: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

// ── Internal state ────────────────────────────────────────────────────────
interface SessionState {
  /** State schema version for migration support */
  _v?: number;
  turns: number;
  lastTask: string;
  notes: string[];
  files: string[];
  errors: string[];
  advisorCalls: number;
  cacheHits: number;
  followUp: string;
  followUpTask?: string;
  reviewSignals: string[];
  reviewSignalsTask?: string;
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
    followUpTask: undefined,
    reviewSignals: [],
    reviewSignalsTask: undefined,
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

function advisorSessionDir(ctxOrKey?: any): string {
  const key = typeof ctxOrKey === "string" ? ctxOrKey : sessionKey(ctxOrKey);
  return join(featureDir("advisor"), "sessions", safeSessionKey(key));
}

export function advisorSessionStatePath(ctxOrKey?: any): string {
  return join(advisorSessionDir(ctxOrKey), "state.json");
}

function advisorCurrentPath(ctxOrKey?: any): string {
  return join(advisorSessionDir(ctxOrKey), "current.md");
}

function safeSessionKey(key: string): string {
  const safe = String(key || "session").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "session";
}

function statePathFor(state: SessionState): string {
  return String((state as any)[SESSION_STATE_PROP] || LEGACY_STATE_PATH);
}

function attachStatePath<T extends SessionState>(state: T, path: string): T {
  Object.defineProperty(state, SESSION_STATE_PROP, {
    value: path,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return state;
}

function loadState(ctxOrKey?: any): SessionState {
  // Do not fall back to LEGACY_STATE_PATH here: that file was unscoped and is
  // the source of issue #103 context bleed. New/resumed sessions must only load
  // their own namespaced mutable advisor state.
  return loadStateFromPath(advisorSessionStatePath(ctxOrKey));
}

function loadStateFromPath(path: string): SessionState {
  const raw = readJson<Partial<SessionState>>(path, {});
  // Handle state versioning: migrate old versions to current
  const version = raw._v ?? 0;
  if (version < STATE_VERSION) {
    // Migrate: ensure reviewControl has all fields
    if (raw.reviewControl && !raw.reviewControl.lastAppliedAt) {
      (raw.reviewControl as any).lastAppliedAt = new Date().toISOString();
    }
  }
  const control = raw.reviewControl;
  const pauseUntil = Number(raw.advisorPauseUntilTurn);
  return attachStatePath({
    _v: STATE_VERSION,
    turns: raw.turns ?? 0,
    lastTask: raw.lastTask ?? "",
    notes: (raw.notes ?? []).map(noteText).filter(Boolean).slice(-MAX_NOTES),
    files: (raw.files ?? []).slice(-MAX_FILES),
    errors: (raw.errors ?? []).slice(-MAX_ERRORS),
    advisorCalls: raw.advisorCalls ?? 0,
    cacheHits: raw.cacheHits ?? 0,
    followUp: raw.followUp ?? "",
    followUpTask: raw.followUpTask,
    reviewSignals: Array.isArray(raw.reviewSignals) ? raw.reviewSignals.map((line: unknown) => sanitizeAdvisorText(line).trim()).filter(Boolean).slice(-MAX_NOTES) : [],
    reviewSignalsTask: raw.reviewSignalsTask,
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
  }, path);
}

function saveState(s: SessionState) {
  atomicWriteText(statePathFor(s), JSON.stringify(s, null, 2) + "\n");
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
  atomicWriteText(CACHE_PATH, JSON.stringify(c, null, 2) + "\n");
}

// ── Prompts ───────────────────────────────────────────────────────────────

const ADVISOR_SYSTEM = `You are a senior engineering advisor. Use the session brief only. Return terse, specific advice with concrete recommendations. 200 words max.

## Guidance
- Focus on actionable insights, not summaries of what was done.
- If no issues found, say so briefly — do not invent problems.
- Flag security concerns, architecture risks, and test gaps.
- Reference specific files or lines when possible.`;

const REVIEW_SYSTEM = `You are a senior reviewer. An AI agent just completed work. Return ONLY valid JSON.

## Required shape
{
  "task": "exact active task",
  "verdict": "on_track|course_correct|not_done|skip",
  "task_actions": ["task-critical action"],
  "advisory_signals": ["non-blocking signal"],
  "pivot": {
    "recommended": false,
    "blocking": false,
    "rationale": "why this is a pivot"
  },
  "summary": "short review summary",
  "reason": "same as summary if different",
  "notify": false
}

## Rules
- Preserve and prioritize the active task before output decisions.
- Only list truly required "task_actions" that move the original task forward.
- Put useful but non-commanding findings in "advisory_signals".
- Put pivots in "pivot"; only set blocking=true when there is an explicit security/data-loss risk, impossible prerequisite, or clear goal divergence.
- Non-blocking pivot is not a command to switch tasks. If blocking pivots are recommended, include explicit rationale and require user confirmation before switching.
`;

// ── Helpers ───────────────────────────────────────────────────────────────

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("||")).digest("hex").slice(0, 16);
}

function brief(s: SessionState): string {
  const lines: string[] = [];
  if (s.lastTask) lines.push(`Task: ${truncate(sanitizeAdvisorText(s.lastTask), 200)}`);
  if (s.turns) lines.push(`Turns: ${s.turns}`);
  if (s.notes.length) { lines.push("Notes:"); s.notes.slice(-4).forEach(n => lines.push(`- ${truncate(n, 200)}`)); }
  if (s.files.length) lines.push(`Files: ${sanitizeAdvisorText(s.files.slice(-4).join(", "))}`);
  if (s.errors.length) lines.push(`Errors: ${sanitizeAdvisorText(s.errors.slice(-2).join(" | "))}`);
  return lines.join("\n").slice(0, 1200);
}

function contextBrokerBrief(pi: ExtensionAPI): string {
  try {
    const text = (pi as any).__piRogueContextBroker?.renderBrief?.();
    return typeof text === "string" && text.includes("ctx://") ? sanitizeAdvisorText(text).slice(0, 2400) : "";
  } catch {
    return "";
  }
}

function safeNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function advisorRouterSessionKey(sessionPath: string): string {
  const resolved = resolve(sessionPath);
  const base = basename(resolved).replace(/\.jsonl$/i, "");
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "session";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

function advisorRouterEventsPath(ctx: any): string | undefined {
  const sessionPath = String(ctx?.sessionManager?.getSessionFile?.() || "");
  if (!sessionPath) return undefined;
  const key = advisorRouterSessionKey(sessionPath);
  return join(homedir(), ".pi", "agent", "pi-rogue", "router", "sessions", key, "events.jsonl");
}

function readLatestRouterRouteTrajectory(ctx: any): TrajectoryFeatures | undefined {
  const eventsPath = advisorRouterEventsPath(ctx);
  if (!eventsPath) return undefined;

  const raw = readText(eventsPath);
  if (!raw.trim()) return undefined;

  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.schema !== "pi-router.route-event.v1") continue;

    const metrics = parsed.metrics as Record<string, unknown> | undefined;
    const runtime = parsed.runtime as Record<string, unknown> | undefined;

    const trajectory: TrajectoryFeatures = {
      loopScore: safeNumber(metrics?.loopScore),
      progressScore: safeNumber(metrics?.progressScore),
      sameErrorRepeatedCount: safeNumber(metrics?.sameErrorRepeatedCount),
      diffLines: safeNumber(metrics?.diffLines),
      contextTokensApprox: safeNumber(runtime?.contextTokensApprox),
    };

    return trajectory.loopScore === undefined
      && trajectory.progressScore === undefined
      && trajectory.sameErrorRepeatedCount === undefined
      && trajectory.diffLines === undefined
      && trajectory.contextTokensApprox === undefined
      ? undefined
      : trajectory;
  }

  return undefined;
}

function buildTrajectoryContext(ctx: any, input: {
  phase: AdvisorRouteInput["phase"];
  turns?: number;
  fileChanged?: boolean;
  failed?: boolean;
}): TrajectoryFeatures {
  const latest = readLatestRouterRouteTrajectory(ctx) ?? {};
  return {
    ...latest,
    phase: input.phase,
    turns: typeof input.turns === "number" && Number.isFinite(input.turns) ? input.turns : undefined,
    fileChanged: input.fileChanged,
    failed: input.failed,
  };
}

const CLIPBOARD_IMAGE_PATH_RE = /(?:\/(?:private\/)?var\/folders\/[^\s"'`<>]+\/T|\/(?:tmp|var\/tmp))\/clipboard-\d{4}-\d{2}-\d{2}-[A-Za-z0-9-]+\.(?:png|jpe?g|gif|webp)\b/g;

export function sanitizeAdvisorText(text: unknown): string {
  return String(text ?? "").replace(CLIPBOARD_IMAGE_PATH_RE, "[clipboard image]");
}

function squish(t: unknown, max = 200): string {
  const s = sanitizeAdvisorText(t).replace(/\s+/g, " ").trim();
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

function normalizeReviewList(values: unknown, limit = 4): string[] {
  if (typeof values === "string") {
    const trimmed = sanitizeAdvisorText(values).trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(values)) return [];
  const out = values
    .map((value) => sanitizeAdvisorText(value).trim())
    .filter((value): value is string => value.length > 0)
    .slice(0, limit);
  return [...new Set(out.map((value) => squish(value, 220)))];
}

function normalizeReviewVerdict(raw: unknown): ReviewVerdict {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "on_track" || value === "course_correct" || value === "not_done" || value === "skip") {
    return value as ReviewVerdict;
  }
  return "course_correct";
}

function toBoolean(value: unknown): boolean {
  return value === true || value === "true" || String(value).trim().toLowerCase() === "true";
}

function isBlockingPivotCandidate(raw: { recommended?: unknown; blocking?: unknown; rationale?: unknown }): boolean {
  if (!toBoolean(raw.recommended) || !toBoolean(raw.blocking)) return false;
  const reason = sanitizeAdvisorText(raw.rationale).toLowerCase();
  if (!reason) return false;
  return /(security|data[-_ ]?loss|irreversible|prerequisite|impossible|cannot\s+complete|does not align|goal divergence|clear divergence|risk of data|critical)/.test(reason);
}

function parsedPivot(raw: unknown): ParsedReviewPivot {
  const pivot = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const rationale = sanitizeAdvisorText(pivot.rationale || pivot.reason || "").trim();
  const blocking = toBoolean(pivot.blocking);
  const candidate = {
    recommended: toBoolean(pivot.recommended) || blocking,
    blocking: false,
    rationale,
    confidence: Number(pivot.confidence),
    requiresConfirmation: true,
  };
  const isAllowedBlock = isBlockingPivotCandidate({
    recommended: pivot.recommended,
    blocking: candidate.recommended && blocking,
    rationale,
  });
  return {
    ...candidate,
    blocking: isAllowedBlock,
  };
}

export function parseReviewPayload(raw: string, activeTask: string): ParsedReviewPayload | null {
  try {
    const text = String(raw || "").trim();
    if (!text) return null;
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const task = sanitizeAdvisorText(parsed.task || parsed.currentTask || activeTask || "").trim() || sanitizeAdvisorText(activeTask).trim();
    const summary = sanitizeAdvisorText(parsed.summary).trim() || sanitizeAdvisorText(parsed.result).trim();
    const reason = sanitizeAdvisorText(parsed.reason).trim() || sanitizeAdvisorText(parsed.notes).trim() || summary;
    const verdict = normalizeReviewVerdict(parsed.verdict ?? "");
    const taskActions = normalizeReviewList(parsed.task_actions ?? parsed.actions, REVIEW_TASK_ACTIONS_LIMIT);
    const advisorySignals = normalizeReviewList(parsed.advisory_signals ?? [], ADVISORY_SIGNALS_LIMIT);
    const pivot = parsedPivot(parsed.pivot as Record<string, unknown> | undefined);

    return {
      activeTask: task,
      verdict,
      taskActions,
      advisorySignals,
      pivot,
      summary,
      reason,
    };
  } catch {
    return null;
  }
}

export function isTaskContinuation(previousTask: string, nextTask: string): boolean {
  const prev = normalizeTask(previousTask);
  const next = normalizeTask(nextTask);
  if (!prev || !next) return true;
  if (prev === next) return true;
  return prev.includes(next) || next.includes(prev);
}

function normalizeTask(task: string): string {
  return squish(task, 200).toLowerCase();
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
  const persisted = loadStateFromPath(statePathFor(state));
  persisted.reviewControl = state.reviewControl;
  persisted.followUp = state.followUp;
  persisted.followUpTask = state.followUpTask;
  persisted.reviewSignals = state.reviewSignals;
  persisted.reviewSignalsTask = state.reviewSignalsTask;
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
  kind?: "handoff" | "answer";
  decision?: "continue" | "review" | "defer";
  reason?: string;
  summary?: string;
  actions?: unknown;
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

export type ReviewVerdict = "on_track" | "course_correct" | "not_done" | "skip";

export type ParsedReviewPivot = {
  recommended: boolean;
  blocking: boolean;
  rationale: string;
  confidence?: number;
  requiresConfirmation: boolean;
};

export type ParsedReviewPayload = {
  activeTask: string;
  verdict: ReviewVerdict;
  taskActions: string[];
  advisorySignals: string[];
  pivot: ParsedReviewPivot;
  summary: string;
  reason: string;
};

function normalizeAdvisorActions(actions: unknown): string[] {
  const raw = Array.isArray(actions) ? actions : typeof actions === "string" ? [actions] : [];
  return raw.map((action) => squish(action, 200)).filter(Boolean).slice(0, 2);
}

function buildAdvisorySignalsBlock(task: string, advisorySignals: string[], pivot: ParsedReviewPivot): string {
  if (!advisorySignals.length && !pivot.recommended) return "";
  const parts = [
    task ? `Active task: ${sanitizeAdvisorText(task).slice(0, 220)}` : "",
    advisorySignals.length ? `Advisory signals (non-commanding): ${advisorySignals.join("; ")}` : "",
    pivot.recommended
      ? `Pivot (${pivot.blocking ? "blocking" : "non-blocking"}): ${pivot.rationale || "review before task switch"}${pivot.blocking ? " (requires user confirmation)" : ""}`
      : "",
  ].filter(Boolean);
  return parts.join("\n");
}

export function consumeTaskScopedReviewSignals(state: SessionState, task: string): string {
  if (!state.reviewSignals.length) return "";
  const signalTask = state.reviewSignalsTask ?? "";
  if (signalTask && !isTaskContinuation(signalTask, task)) {
    state.reviewSignals = [];
    state.reviewSignalsTask = undefined;
    return "";
  }
  const text = state.reviewSignals.join("\n");
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  return text;
}

export function consumeTaskScopedFollowUp(state: SessionState, task: string): string {
  if (!state.followUp) return "";
  if (!state.followUpTask) {
    const text = state.followUp;
    state.followUp = "";
    return text;
  }
  if (!isTaskContinuation(state.followUpTask, task)) {
    state.followUp = "";
    state.followUpTask = undefined;
    return "";
  }
  const text = state.followUp;
  state.followUp = "";
  state.followUpTask = undefined;
  return text;
}

function comparableAdvisorText(text: string): string {
  return sanitizeAdvisorText(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isRedundantAdvisorSummary(reason: string, summary: string): boolean {
  const r = comparableAdvisorText(reason);
  const s = comparableAdvisorText(summary);
  if (!s) return true;
  if (!r) return false;
  if (r === s) return true;
  if (Math.min(r.length, s.length) >= 60 && (r.includes(s) || s.includes(r))) return true;

  const rTokens = new Set(r.split(" ").filter((token) => token.length > 2));
  const sTokens = new Set(s.split(" ").filter((token) => token.length > 2));
  if (rTokens.size < 8 || sTokens.size < 8) return false;
  const overlap = [...sTokens].filter((token) => rTokens.has(token)).length;
  return overlap / Math.max(rTokens.size, sTokens.size) >= 0.86;
}

function distinctAdvisorSummary(reason: string, summary: string): string {
  const cleanSummary = sanitizeAdvisorText(summary).trim();
  return isRedundantAdvisorSummary(reason, cleanSummary) ? "" : cleanSummary;
}

function advisorHandoffText(decision: "continue" | "review" | "defer", reason: string, summary: string, actions: unknown = []): string {
  const limitedActions = normalizeAdvisorActions(actions);
  const cleanReason = sanitizeAdvisorText(reason);
  const cleanSummary = distinctAdvisorSummary(cleanReason, summary);
  return [
    `Advisor verdict: ${decision}.`,
    cleanReason ? `Reason: ${cleanReason}` : "",
    cleanSummary ? `Summary: ${cleanSummary}` : "",
    limitedActions.length ? `Actions: ${limitedActions.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function sendAdvisorHint(pi: ExtensionAPI, decision: "continue" | "review" | "defer", reason: string, summary: string, actions: unknown = []) {
  const cleanReason = sanitizeAdvisorText(reason);
  const cleanSummary = distinctAdvisorSummary(cleanReason, summary);
  const limitedActions = normalizeAdvisorActions(actions);
  pi.sendMessage(
    {
      customType: "advisor:llm",
      content: advisorHandoffText(decision, cleanReason, cleanSummary, limitedActions),
      display: true,
      details: { kind: "handoff", decision, reason: cleanReason, summary: cleanSummary, actions: limitedActions },
    },
    { deliverAs: "followUp" },
  );
}

function sendAdvisorAnswer(pi: ExtensionAPI, text: string) {
  const cleanText = sanitizeAdvisorText(text);
  pi.sendMessage({
    customType: "advisor:llm",
    content: cleanText,
    display: true,
    details: { kind: "answer", summary: cleanText },
  });
}

function renderAdvisorHint(message: any, options: { expanded?: boolean }, theme: any) {
  const details = (message?.details ?? {}) as AdvisorHintDetails;
  const customType = String(message?.customType ?? "advisor:rules");
  const sourceColor = customType === "advisor:llm" ? "success" : customType === "advisor:model" ? "accent" : "muted";
  const source = theme.bold(theme.fg(sourceColor, `[${customType}]`));

  if (details.kind === "answer") {
    const body = sanitizeAdvisorText(contentText(message?.content) || details.summary || "No advisor response.");
    const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
    box.addChild(new Text(`${theme.bold(theme.fg("success", "↗"))} ${source} ${theme.bold(theme.fg("success", "answer"))}`, 0, 0));
    box.addChild(new Text(theme.fg("dim", body), 0, 0));
    return box;
  }

  const decision = details.decision ?? "defer";
  const decisionColor = decision === "review" ? "accent" : decision === "continue" ? "muted" : "dim";
  const verdict = theme.bold(theme.fg(decisionColor, decision));
  const glyph = decision === "review" ? "↗" : decision === "defer" ? "…" : "·";
  const reason = squish(details.reason || contentText(message?.content) || "no extra detail", 180);
  const actions = normalizeAdvisorActions(details.actions);
  const fullHandoff = sanitizeAdvisorText(
    (details.reason || details.summary || actions.length)
      ? advisorHandoffText(decision, details.reason || "", details.summary || "", actions)
      : contentText(message?.content),
  );

  const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
  box.addChild(new Text(`${theme.bold(theme.fg(decisionColor, glyph))} ${source} ${verdict}`, 0, 0));

  if (options.expanded) {
    box.addChild(new Text(theme.fg("dim", "full handoff:"), 0, 0));
    box.addChild(new Text(theme.fg("dim", fullHandoff), 0, 0));
  } else {
    box.addChild(new Text(theme.fg("dim", `reason: ${reason}`), 0, 0));
    const summary = distinctAdvisorSummary(details.reason || "", details.summary || "");
    if (summary) {
      box.addChild(new Text(theme.fg("dim", `summary: ${squish(summary, 220)}`), 0, 0));
    }
    if (actions.length) {
      box.addChild(new Text(theme.fg("dim", `actions: ${actions.map((a) => squish(a, 80)).join(" • ")}`), 0, 0));
    }
    if (fullHandoff.split("\n").length > 3) {
      box.addChild(new Text(theme.fg("dim", "Ctrl+O full advisor handoff"), 0, 0));
    }
  }

  return box;
}

/** Extract readable text from message content (handles strings, blocks, and nested message payloads). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return sanitizeAdvisorText(content).trim();
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return sanitizeAdvisorText(obj.text).trim();
    if (obj.content !== undefined) return contentText(obj.content);
    if (obj.message !== undefined) return contentText(obj.message);
    return "";
  }
  if (!Array.isArray(content)) return sanitizeAdvisorText(content).trim();
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
  return sanitizeAdvisorText(parts.join("\n")).replace(/\s+/g, " ").trim();
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
  if (typeof sessionFile === "string" && sessionFile.length > 0) {
    return safeSessionKey(basename(String(sessionFile)).replace(/\.[^.]+$/, ""));
  }
  const sessionId = ctx?.session?.id || process.env.PI_ROGUE_SESSION_ID;
  if (typeof sessionId === "string" && sessionId.length > 0) return safeSessionKey(sessionId);
  return "session";
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

function setPiRogueStatus(ctx: any, config = loadConfig(), state?: SessionState): void {
  const currentState = state ?? loadState(ctx);
  const normalized = normalizeAdvisorConfig(config);
  const checkin = checkinDescription(normalized);
  const pause = advisorPauseRemaining(currentState, currentState.turns);
  const pauseText = pause > 0 ? ` · pause ${pause} turn${pause === 1 ? "" : "s"}` : "";
  const last = currentState.checkin.lastAt ? ` · last ${new Date(currentState.checkin.lastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  ctx.ui.setStatus("pi-rogue", `☠︎ advisor ${normalized.mode}/${normalized.review} · ${checkin}${pauseText}${last}`);
}

export function shouldRunCheckin(config: AdvisorConfig, state: SessionState, now = Date.now(), startedAt = now): string | null {
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
  const state = loadState(ctx);
  const reason = shouldRunCheckin(config, state, Date.now(), Date.now());
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

    const next = loadState(ctx);
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

function contextBrokerEnabledByDefault(): boolean {
  return !new Set(["0", "false", "no", "off"]).has(String(process.env.PI_CONTEXT_BROKER_ENABLED ?? "").trim().toLowerCase());
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

type SubsystemStatusRow = {
  subsystem: string;
  status: string;
  details: string;
};

function fileBytes(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kib = bytes / 1024;
  return `${Number.isInteger(kib) ? kib.toFixed(0) : kib.toFixed(1)} KiB`;
}

function formatSubsystemStatusRows(rows: SubsystemStatusRow[]): string {
  const subsystemWidth = Math.max(11, ...rows.map((row) => row.subsystem.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  return [
    `${"Subsystem".padEnd(subsystemWidth)} | ${"Status".padEnd(statusWidth)} | Details`,
    `${"-".repeat(subsystemWidth)}-+-${"-".repeat(statusWidth)}-+--------------------------------`,
    ...rows.map((row) => `${row.subsystem.padEnd(subsystemWidth)} | ${row.status.padEnd(statusWidth)} | ${row.details}`),
  ].join("\n");
}

function piRogueSubsystemRows(config: AdvisorConfig, state: SessionState, ctx: any): SubsystemStatusRow[] {
  const normalized = normalizeAdvisorConfig(config);
  const pause = advisorPauseRemaining(state, state.turns);
  const pauseText = pause > 0 ? `pause=${pause} turn${pause === 1 ? "" : "s"}` : "pause=off";

  const checkinsText = checkinDescription(normalized).replace(/^checkins\s+/, "");
  const advisorRow: SubsystemStatusRow = {
    subsystem: "advisor",
    status: normalized.mode === "off" ? "off" : "on",
    details: [
      `review=${normalized.review}`,
      `checkins=${checkinsText}`,
      `turns=${state.turns}`,
      `calls=${state.advisorCalls}`,
      state.cacheHits > 0 ? `cache=${state.cacheHits}` : "",
      state.checkin.lastAt ? `last=${new Date(state.checkin.lastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "last=never",
      pause > 0 ? pauseText : "",
    ].filter(Boolean).join(" · "),
  };

  const root = piRogueRootDir();

  const routerConfigPath = join(root, "router", "config.json");
  const rawRouter: any = readJsonLoose(routerConfigPath) ?? {};
  const routerProfiles = (rawRouter?.profiles ?? {}) as Record<string, { worker?: string; smart?: string; teacher?: string; reviewer?: string }>;
  const activeProfile = typeof rawRouter?.activeProfile === "string" && routerProfiles[rawRouter.activeProfile]
    ? rawRouter.activeProfile
    : "all-smart";
  const routerProfile = routerProfiles[activeProfile] ?? {};
  const routerStatus: SubsystemStatusRow = {
    subsystem: "router",
    status: rawRouter?.enabled === true ? "on" : "off",
    details: [
      `mode=${rawRouter?.mode === "auto_model" ? "auto_model" : "observe"}`,
      `profile=${activeProfile}`,
      `smart=${routerProfile.smart || "n/a"}`,
      `worker=${routerProfile.worker || "n/a"}`,
    ].join(" · "),
  };

  const fusionPaths = fusionRecipeCandidatePaths(ctx, root);
  const fusionPath = fusionPaths.find((path) => existsSync(path)) || fusionPaths[0];
  const parsedFusion = fusionPath ? readJsonLoose(fusionPath) : undefined;
  const fusionRecipes = Array.isArray(parsedFusion?.recipes) ? parsedFusion.recipes : [];
  const fusionIds = fusionRecipes.map((recipe: any) => String(recipe?.id ?? "").trim()).filter(Boolean);
  const fusionStatus: SubsystemStatusRow = {
    subsystem: "fusion",
    status: fusionIds.length > 0 ? "on" : "off",
    details: [
      `source=${fusionPaths[0] && fusionPaths[0] === String(process.env.PI_ROGUE_FUSION_RECIPES ?? "").trim() ? "env" : "user-root"}`,
      `recipes=${fusionIds.length}`,
      `ids=${fusionIds.length > 0 ? `${fusionIds.slice(0, 2).join(", ")}${fusionIds.length > 2 ? `, +${fusionIds.length - 2} more` : ""}` : "none"}`,
      `file=${existsSync(fusionPath || "") ? "user-root" : "not-created"}`,
    ].join(" · "),
  };

  const contextEnabled = contextBrokerEnabledByDefault();
  const contextConfigPath = join(root, "context-broker", "config.json");
  const contextDbPath = join(root, "context-broker", "artifacts.sqlite");
  const rawContextConfig = readJsonLoose(contextConfigPath) as { rewriteThresholdBytes?: unknown; rewrite_threshold_bytes?: unknown } | undefined;
  const configuredRewriteThreshold = parseNonNegativeInt(
    rawContextConfig?.rewriteThresholdBytes ?? rawContextConfig?.rewrite_threshold_bytes,
  );
  const envRewriteThreshold = parseNonNegativeInt(process.env.PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES);
  const contextRewriteThreshold = envRewriteThreshold ?? configuredRewriteThreshold ?? 8 * 1024;
  const contextSource = envRewriteThreshold !== undefined ? "env" : configuredRewriteThreshold !== undefined ? "config" : "default";
  const contextBytes = fileBytes(contextDbPath);
  const contextRow: SubsystemStatusRow = {
    subsystem: "context",
    status: contextEnabled ? "on" : "off",
    details: [
      `rewrite-threshold=${formatBytes(contextRewriteThreshold)} (${contextSource})`,
      `store=user-root`,
      contextBytes !== undefined ? `size=${formatBytes(contextBytes)}` : "size=not-created",
    ].join(" · "),
  };

  const orchestration = readOrchestrationSnapshot(ctx);
  const orchestrationActive = Boolean(orchestration.goal || (orchestration.loop?.enabled && orchestration.loop?.instruction) || orchestration.research?.instruction);

  return [
    advisorRow,
    routerStatus,
    fusionStatus,
    contextRow,
    {
      subsystem: "orchestration",
      status: orchestrationActive ? "on" : "off",
      details: orchestrationActive
        ? [
          orchestration.goal ? "goal" : "",
          orchestration.loop?.enabled && orchestration.loop?.instruction ? "loop" : "",
          orchestration.research?.instruction ? "autoresearch" : "",
        ].filter(Boolean).join(" · ")
        : "idle",
    },
  ];
}

function piRogueCockpitText(config: AdvisorConfig, state: SessionState, _currentNote: string, ctx: any): string {
  const rows = piRogueSubsystemRows(config, state, ctx);
  return [
    "Pi-Rogue status",
    formatSubsystemStatusRows(rows),
    "",
    "Commands: /pi-rogue status · /pi-rogue-advisor|router|fusion|orchestration|context status",
  ].filter(Boolean).join("\n");
}

function piRogueRootDir(): string {
  return join(homedir(), ".pi", "agent", "pi-rogue");
}

type PiRogueConfigureMode = "status" | "on";

export interface PiRogueConfigurePlan {
  mode: PiRogueConfigureMode;
  root: string;
  advisorModel: string;
  workerModel: string;
  smartModel: string;
  activeRouterProfile: "balanced" | "fusion-smart";
  fusionRecipeId?: string;
  files: {
    summary: string;
    advisor: string;
    router: string;
    routerCards: string;
    fusionRecipes: string;
    contextBroker: string;
  };
  warnings: string[];
}

function piRogueModelId(model: any): string | undefined {
  const provider = String(model?.provider ?? "").trim();
  const id = String(model?.id ?? model?.model ?? "").trim();
  if (!id) return undefined;
  if (!provider || id.startsWith(`${provider}/`)) return id;
  return `${provider}/${id}`;
}

function availableTextModels(ctx: any): string[] {
  const models = ctx?.modelRegistry?.getAvailable?.() ?? ctx?.modelRegistry?.getAll?.() ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    if (Array.isArray(model?.input) && !model.input.includes("text")) continue;
    const id = piRogueModelId(model);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function firstAvailable(available: string[], preferred: string[]): string | undefined {
  return preferred.find((id) => available.includes(id)) ?? available[0];
}

function readJsonLoose(path: string): any | undefined {
  try {
    return JSON.parse(readText(path));
  } catch {
    return undefined;
  }
}

function fusionRecipeCandidatePaths(_ctx: any, root = piRogueRootDir()): string[] {
  const configured = String(process.env.PI_ROGUE_FUSION_RECIPES ?? "").trim();
  return [
    configured,
    join(root, "fusion", "recipes.json"),
  ].filter(Boolean);
}

function configuredFusionRecipeIds(ctx: any, root = piRogueRootDir()): string[] {
  for (const path of fusionRecipeCandidatePaths(ctx, root)) {
    const parsed = readJsonLoose(path);
    const recipes = Array.isArray(parsed?.recipes) ? parsed.recipes : [];
    const ids = recipes.map((recipe: any) => String(recipe?.id ?? "").trim()).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return [];
}

export function buildPiRogueConfigurePlan(ctx: any, mode: PiRogueConfigureMode = "status"): PiRogueConfigurePlan {
  const root = piRogueRootDir();
  const available = availableTextModels(ctx);
  const advisorModel = firstAvailable(available, SOTA_CHAIN.map((item) => `${item.provider}/${item.model}`)) ?? "<no text model detected>";
  const workerModel = firstAvailable(available, [
    "openai-codex/gpt-5.3-codex-spark",
    "openai-codex/gpt-5.4-mini",
    advisorModel,
  ].filter((id) => id && !id.startsWith("<"))) ?? advisorModel;
  const fusionRecipeId = configuredFusionRecipeIds(ctx, root)[0];
  const smartModel = fusionRecipeId ? `fusion/${fusionRecipeId}` : advisorModel;
  return {
    mode,
    root,
    advisorModel,
    workerModel,
    smartModel,
    activeRouterProfile: fusionRecipeId ? "fusion-smart" : "balanced",
    fusionRecipeId,
    files: {
      summary: join(root, "config.json"),
      advisor: CONFIG_PATH,
      router: join(root, "router", "config.json"),
      routerCards: join(root, "router", "model-cards.jsonl"),
      fusionRecipes: join(root, "fusion", "recipes.json"),
      contextBroker: join(root, "context-broker", "artifacts.sqlite"),
    },
    warnings: [
      available.length === 0 ? "No text models were detected; configure a Pi model provider before applying." : "",
      fusionRecipeId ? "" : "No fusion recipe was detected; router will use the strongest single model for smart/review roles.",
    ].filter(Boolean),
  };
}

function modelCardFor(modelId: string, roleHints: string[], generatedAt: string): any {
  const [provider, ...rest] = modelId.split("/");
  return {
    schema: "pi-router.model-capability-card.v1",
    modelId: rest.length ? rest.join("/") : modelId,
    provider: rest.length ? provider : "unknown",
    generatedAt,
    seed: {
      source: "pi-rogue-configure",
      purpose: `Selected by subsystem setup for ${roleHints.join(", ")} roles.`,
      roleHints,
    },
    observed: {
      source: "manual",
      events: 0,
      sessions: 0,
      actions: {},
      averageLoopScore: 0,
      averageProgressScore: 0,
      averageContextTokensApprox: null,
      outcomes: { linked: 0, success: 0, partial: 0, failed: 0, abandoned: 0, unknown: 0, averageReworkTurns: null },
    },
    promotion: { manualOnly: true, promoted: false },
  };
}

function upsertModelCards(path: string, cards: any[]): void {
  const existing = readText(path)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
  const map = new Map<string, any>();
  for (const card of existing) map.set(`${card.provider}/${card.modelId}`, card);
  for (const card of cards) map.set(`${card.provider}/${card.modelId}`, card);
  writeText(path, [...map.values()].map((card) => JSON.stringify(card)).join("\n") + "\n");
}

export function applyPiRogueConfigurePlan(plan: PiRogueConfigurePlan): void {
  if (plan.advisorModel.startsWith("<")) throw new Error("cannot turn Pi-Rogue on without a detected text model");
  const now = new Date().toISOString();
  writeJson(plan.files.summary, {
    schema: "pi-rogue.config.v1",
    configuredAt: now,
    advisor: { model: plan.advisorModel },
    context: { enabled: true, durable: true, store: plan.files.contextBroker },
    router: { enabled: true, mode: "observe", activeProfile: plan.activeRouterProfile, config: plan.files.router },
    fusion: { enabled: true, recipeId: plan.fusionRecipeId, recipes: plan.files.fusionRecipes },
    storage: { root: plan.root },
  });
  const existingAdvisor = readJson<Partial<AdvisorConfig>>(plan.files.advisor, {});
  writeJson(plan.files.advisor, normalizeAdvisorConfig({
    ...existingAdvisor,
    mode: "auto",
    review: existingAdvisor.review === "strict" ? "strict" : "light",
    checkins: "mid-hour",
    model: plan.advisorModel,
  }));
  const quick = { worker: plan.workerModel, smart: plan.workerModel, teacher: plan.workerModel, reviewer: plan.workerModel };
  const balanced = { worker: plan.workerModel, smart: plan.advisorModel, teacher: plan.advisorModel, reviewer: plan.advisorModel };
  const profiles: Record<string, any> = { quick, balanced };
  if (plan.fusionRecipeId) profiles["fusion-smart"] = { worker: plan.workerModel, smart: plan.smartModel, teacher: plan.smartModel, reviewer: plan.smartModel };
  writeJson(plan.files.router, {
    enabled: true,
    mode: "observe",
    print: "mismatch_only",
    activeProfile: plan.activeRouterProfile,
    profileOrder: plan.fusionRecipeId ? ["fusion-smart", "balanced", "quick"] : ["balanced", "quick"],
    profiles,
  });
  upsertModelCards(plan.files.routerCards, [
    modelCardFor(plan.workerModel, ["worker", "quick"], now),
    modelCardFor(plan.advisorModel, ["advisor", "smart", "reviewer", "teacher"], now),
    ...(plan.fusionRecipeId ? [modelCardFor(plan.smartModel, ["smart", "reviewer", "teacher", "fusion"], now)] : []),
  ]);
}

function piRogueConfigText(): string {
  const root = piRogueRootDir();
  return [
    "Pi-Rogue config map:",
    `  root: ${root}`,
    `  advisor: ${CONFIG_PATH}`,
    `  router: ${join(root, "router", "config.json")}`,
    `  router cards: ${join(root, "router", "model-cards.jsonl")}`,
    `  fusion recipes: ${join(root, "fusion", "recipes.json")}`,
    `  context broker: ${join(root, "context-broker", "artifacts.sqlite")}`,
    `  fusion traces: ${join(root, "fusion", "runs")}`,
    `  orchestration: ${ORCHESTRATION_DIR}`,
    "",
    "Layering: built-in defaults → user-root Pi-Rogue config → session state.",
    "Use /pi-rogue-router status and /pi-rogue-fusion status to see the currently active subsystem paths.",
  ].join("\n");
}

function piRogueConfigureText(plan: PiRogueConfigurePlan): string {
  const intro = plan.mode === "on" ? "Pi-Rogue setup: user-root defaults." : "Pi-Rogue status plan: read-only; no files written.";
  return [
    intro,
    "",
    "Derived defaults:",
    `  advisor model: ${plan.advisorModel}`,
    `  router profile: ${plan.activeRouterProfile}`,
    `  worker: ${plan.workerModel}`,
    `  smart/teacher/reviewer: ${plan.smartModel}`,
    plan.fusionRecipeId ? `  fusion recipe: fusion/${plan.fusionRecipeId}` : "  fusion recipe: not detected",
    "",
    "Files:",
    `  summary: ${plan.files.summary}`,
    `  advisor: ${plan.files.advisor}`,
    `  router: ${plan.files.router}`,
    `  router cards: ${plan.files.routerCards}`,
    `  fusion recipes: ${plan.files.fusionRecipes}`,
    `  context broker: ${plan.files.contextBroker}`,
    plan.warnings.length ? "" : "",
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Safety: root status is read-only; use subsystem commands for explicit changes.",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function settingsPaths(ctx: any): string[] {
  return [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(String(ctx?.cwd ?? process.cwd()), ".pi", "settings.json"),
  ];
}

function configuredPackages(ctx: any): string[] {
  const packages: string[] = [];
  for (const path of settingsPaths(ctx)) {
    const parsed = readJsonLoose(path);
    for (const entry of Array.isArray(parsed?.packages) ? parsed.packages : []) packages.push(String(entry));
  }
  return packages;
}

function piRogueDoctorText(ctx: any): string {
  const root = piRogueRootDir();
  const packages = configuredPackages(ctx).filter((entry) => entry.includes("pi-rogue"));
  const hasNpm = packages.some((entry) => entry.includes("npm:@fiale-plus/pi-rogue") || entry === "@fiale-plus/pi-rogue");
  const localSources = packages.filter((entry) => !entry.includes("npm:@fiale-plus/pi-rogue") && entry.includes("pi-rogue"));
  const checks = [
    `${hasNpm ? "ok" : "warn"}: canonical npm package ${hasNpm ? "is registered" : "was not detected in settings"}`,
    `${localSources.length === 0 ? "ok" : "warn"}: local/deprecated Pi-Rogue package registrations${localSources.length ? `: ${localSources.join(", ")}` : " not detected"}`,
    `${existsSync(join(root, "config.json")) ? "ok" : "info"}: global summary config ${join(root, "config.json")}`,
    `${existsSync(join(root, "router", "config.json")) ? "ok" : "info"}: global router config ${join(root, "router", "config.json")}`,
    `${existsSync(join(String(ctx?.cwd ?? process.cwd()), ".pi", "router", "config.json")) ? "info" : "ok"}: repo router override ${join(String(ctx?.cwd ?? process.cwd()), ".pi", "router", "config.json")}`,
    `${existsSync(join(root, "fusion", "recipes.json")) || configuredFusionRecipeIds(ctx, root).length ? "ok" : "info"}: fusion recipes expose fusion/<recipe-id> models when present`,
  ];
  return [
    "Pi-Rogue doctor:",
    ...checks.map((check) => `  ${check}`),
    "",
    "Migration guidance:",
    "  built-in defaults → user-root Pi-Rogue config → session state",
    "  remove duplicate local package registrations unless intentionally developing locally",
    "  run /pi-rogue status for a read-only aggregate view or subsystem commands to write user-root defaults",
    "",
    "This command is informational only; it does not modify config.",
  ].join("\n");
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
  const state = loadState(ctx);
  if (!question.trim()) return { text: "Ask a question.", error: "empty" };

  const brokerBrief = includeWork ? contextBrokerBrief(pi) : "";
  const ck = hash("adv", config.model ?? "auto", squish(question, 300), includeWork ? brief(state) : "", brokerBrief);
  const cache = loadCache();
  if (cache[ck]) { state.cacheHits++; saveState(state); return { text: cache[ck], cached: true }; }

  const msgs = [
    { role: "user", content: [
      `Question: ${question}`,
      scope ? `Scope: ${scope}` : "",
      includeWork && brief(state) ? `Session:\n${brief(state)}` : "",
      brokerBrief ? `Context broker brief:\n${brokerBrief}` : "",
    ].filter(Boolean).join("\n"), timestamp: new Date().toISOString() },
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
  const state = loadState(ctx);

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
    const trajectory = buildTrajectoryContext(ctx, {
      phase,
      turns: state.turns,
      fileChanged: meta.fileChanged,
      failed: meta.failed,
    });
    const reviewInput: AdvisorRouteInput = {
      phase,
      text: delta || "(none)",
      brief: brief(state),
      fileChanged: meta.fileChanged,
      failed: meta.failed,
    };
    const reviewHeuristic = { ...heuristicRoute(reviewInput), trajectory };
    const gatePrediction = binaryGatePredict(reviewInput.text, phase, trajectory);
    let reviewRoute = reviewHeuristic;
    if (gatePrediction && gatePrediction.trusted && !reviewHeuristic.safety) {
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

    if (gatePrediction && gatePrediction.trusted && gatePrediction.decision === "continue" && !reviewHeuristic.safety) {
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
    const brokerBrief = contextBrokerBrief(pi);
    if (!b && !brokerBrief) {
      finalDecision = "defer";
      finalReason = "missing brief context";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const rk = hash("rev", trigger, b, brokerBrief, delta, String(meta.fileChanged), String(meta.failed), String(meta.isAgentEnd), String(reviewRoute.label), signature);
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
        b ? `Brief:\n${b}` : "",
        brokerBrief ? `Context broker brief:\n${brokerBrief}` : "",
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

    const parsed = parseReviewPayload(raw, state.lastTask);
    if (!parsed) {
      finalDecision = "defer";
      finalReason = "unparseable verdict";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    if (parsed.verdict === "skip") {
      finalDecision = "defer";
      finalReason = "explicit skip";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    if (parsed.verdict === "on_track") {
      finalDecision = "continue";
      finalReason = parsed.reason || parsed.summary || "review result";
      finalReason = finalReason.slice(0, 120);
      state.followUp = "";
      state.followUpTask = undefined;
      state.reviewSignals = [];
      state.reviewSignalsTask = undefined;
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const decision = parsed.verdict === "course_correct" || parsed.verdict === "not_done" ? "review" : "defer";
    finalDecision = decision;
    finalReason = (parsed.reason || parsed.summary || "review result").slice(0, 120);

    const display = formatAdvisorDisplay("advisor:llm", decision, finalReason);
    writeText(advisorCurrentPath(ctx), `${display}\n`);

    const reviewTask = parsed.activeTask || state.lastTask || "";
    const hasTaskActions = parsed.taskActions.length > 0;
    if (hasTaskActions) {
      state.followUp = [sanitizeAdvisorText(parsed.summary), ...parsed.taskActions].filter(Boolean).join(" — ");
      state.followUpTask = reviewTask;
      sendAdvisorHint(pi, decision, finalReason, parsed.summary || "", parsed.taskActions);
    } else {
      state.followUp = "";
      state.followUpTask = undefined;
    }

    const advisoryText = buildAdvisorySignalsBlock(reviewTask, parsed.advisorySignals, parsed.pivot);
    if (advisoryText) {
      state.reviewSignals = [advisoryText];
      state.reviewSignalsTask = reviewTask;
      sendAdvisorAnswer(pi, advisoryText);
    } else {
      state.reviewSignals = [];
      state.reviewSignalsTask = undefined;
    }

    markReviewApplied(state, signature, trigger, finalDecision, finalReason, !hasTaskActions);
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
    const state = loadState(ctx);
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
    const state = loadState(ctx);
    const hasFollowUp = Boolean(state.followUp);
    if ((isAdvisorAutoRunSuppressed(state, state.turns) && !hasFollowUp) || cfg.mode === "off" || cfg.mode === "manual") {
      return { systemPrompt: event.systemPrompt };
    }
    setPiRogueStatus(ctx, cfg, state);
    const prompt = typeof event.prompt === "string" && event.prompt.trim() ? squish(event.prompt, 1000) : "";
    if (prompt) state.lastTask = prompt;
    const currentTask = state.lastTask || "";
    const briefText = brief(state);
    const brokerBrief = contextBrokerBrief(pi);
    const intent = prompt ? classifyIntent(prompt) : "";
    const mode = prompt ? classifyMode(prompt) : "";
    const intentTag = intent ? `Intent: ${intent}` : "";
    const modeTag = mode ? `Mode: ${mode}` : "";
    // Enrich preflight text with session context so the binary gate has more signal
    const enrichedText = [prompt, event.systemPrompt || "", briefText ? `Brief: ${briefText}` : "", brokerBrief ? `Context broker: ${brokerBrief}` : "", intentTag, modeTag].filter(Boolean).join(" ");
    const routeInput: AdvisorRouteInput = { phase: "preflight", text: enrichedText || prompt || event.systemPrompt || briefText || brokerBrief || intentTag || modeTag || "", brief: [briefText, brokerBrief].filter(Boolean).join("\n\n") };

    const trajectory = buildTrajectoryContext(ctx, {
      phase: "preflight",
      turns: state.turns,
    });
    const gatePrediction = binaryGatePredict(routeInput.text, "preflight", trajectory);
    const heuristic = { ...heuristicRoute(routeInput), trajectory };
    let route: AdvisorRouteDecision;
    if (gatePrediction && gatePrediction.trusted) {
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

    const hadFollowUp = Boolean(state.followUp);
    const follow = consumeTaskScopedFollowUp(state, currentTask);
    const reviewSignals = consumeTaskScopedReviewSignals(state, currentTask);
    if (hadFollowUp) {
      consumeReviewFollowUp(state);
    }
    saveState(state);

    const note = routeNote(route);
    const control = state.reviewControl;
    const controlTag = control.status === "needed" || control.status === "running" ? `Review-control: ${control.status}${control.lastDecision ? ` (${control.lastDecision})` : ""}` : "";
    writeText(advisorCurrentPath(ctx), `${note}\n`);
    return {
      systemPrompt: [
        event.systemPrompt,
        follow ? `Advisor follow-up:\n${follow}` : "",
        note,
        reviewSignals ? `Advisor signals (non-commanding):\n${reviewSignals}` : "",
        controlTag,
        briefText ? `Brief (cache-aware):\n${briefText}` : "",
        brokerBrief ? `Context broker brief (lookup-first):\n${brokerBrief}` : "",
      ].filter(Boolean).join("\n\n"),
    };
  });

  // ── Post-review (turn_end) ─────────────────────────────────────────────
  pi.on("turn_end", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const state = loadState(ctx);
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

    const post = loadState(ctx);
    if (!isAdvisorAutoRunSuppressed(post, post.turns)) {
      void maybeAdvisorCheckin(pi, ctx, "turn_end");
    }
  });

  // ── Post-review (agent_end) ────────────────────────────────────────────
  pi.on("agent_end", async (event: any, ctx: any) => {
    const cfg = loadConfig();
    if (cfg.mode === "off") return;
    const state = loadState(ctx);
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

    const post = loadState(ctx);
    if (!isAdvisorAutoRunSuppressed(post, post.turns)) {
      void maybeAdvisorCheckin(pi, ctx, "agent_end");
    }
  });

  // ── /pi-rogue management root ──────────────────────────────────────────
  pi.registerCommand("pi-rogue", {
    description: "Pi-Rogue management root. Usage: /pi-rogue status|help|doctor",
    getArgumentCompletions: (prefix: string) => piRogueArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const state = loadState(ctx);
      const arg = String(args ?? "").trim().toLowerCase();
      setPiRogueStatus(ctx, cfg, state);

      if (!arg || arg === "status") {
        ctx.ui.notify(piRogueCockpitText(cfg, state, readText(advisorCurrentPath(ctx)).trim(), ctx), "info");
        return;
      }

      if (arg === "help") {
        ctx.ui.notify([
          "Pi-Rogue commands:",
          "  /pi-rogue status              read-only status dashboard + aggregate setup",
          "  /pi-rogue doctor              read-only setup checks",
          "",
          "Subsystems:",
          "  /pi-rogue-advisor status||mode|model|review|pause|unpause|checkins",
          "  /pi-rogue-router status||mode|profile|print|models|profiles|cycle|configure",
          "  /pi-rogue-fusion status|reload|configure",
          "  /pi-rogue-orchestration status|goal|loop|autoresearch|lab",
          "",
          "No nested /pi-rogue router/status/config aliases are registered; use the subsystem roots above.",
        ].join("\n"), "info");
        return;
      }

      if (arg === "configure" || arg.startsWith("configure ")) {
        ctx.ui.notify("/pi-rogue configure was replaced by /pi-rogue status (read-only).", "info");
        return;
      }

      if (arg.startsWith("doctor")) {
        ctx.ui.notify(piRogueDoctorText(ctx), "info");
        return;
      }

      ctx.ui.notify("Usage: /pi-rogue status|help|doctor", "error");
    },
  });

  // ── /pi-rogue-advisor command ──────────────────────────────────────────
  pi.registerCommand("pi-rogue-advisor", {
    description: "Senior engineering advisor. Usage: /pi-rogue-advisor [|status|mode|model|review|pause|unpause|checkins|question]",
    getArgumentCompletions: (prefix: string) => advisorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const a = String(args ?? "").trim().toLowerCase();
      const [cmd, ...rest] = a.split(/\s+/);
      const cfg = loadConfig();
      const state = loadState(ctx);

      if (!a || cmd === "status") {
        const note = readText(advisorCurrentPath(ctx)).trim();
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
        ctx.ui.notify("Usage: /pi-rogue-advisor mode auto|manual|off", "error");
        return;
      }
      if (cmd === "model") {
        const v = rest.join("/").trim();
        if (!v || !v.includes("/")) {
          const resolved = await resolveModel(ctx, cfg);
          ctx.ui.notify([
            `Current: ${resolved?.label || "auto"}`,
            "",
            "Usage: /pi-rogue-advisor model <provider>/<model>",
            '(e.g. "openai-codex/gpt-5.5" or "anthropic/claude-opus-4-6")',
            "Run /pi-rogue-advisor status for SOTA options.",
          ].join("\n"), "info");
          return;
        }
        saveConfig({ ...cfg, model: v });
        ctx.ui.notify(`Model set to ${v}. Remove field to auto-detect.`, "info");
        return;
      }
      if (cmd === "settings") {
        const pause = advisorPauseRemaining(state, state.turns);
        ctx.ui.notify([
          "Advisor config (check-ins are orchestration-managed):",
          `  mode: "${cfg.mode}" — auto (preflight+post+cache) | manual | off`,
          `  review: "${cfg.review}" — light (changes/errors) | strict (every 3) | off`,
          `  checkins: "${cfg.checkins}" — set by active /pi-rogue-orchestration goal or loop lifecycle`,
          `  checkinIntervalMinutes: ${cfg.checkinIntervalMinutes}`,
          pause > 0 ? `  advisorPauseUntilTurn: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "  advisorPauseUntilTurn: off",
          `  model: "${cfg.model || "auto"}" — optional override for higher/advanced advisor model`,
          "",
          "Router logs: evals/advisor-router.jsonl",
          "Run /pi-rogue-advisor <question> for immediate advice.",
        ].join("\n"), "info");
        return;
      }
      if (cmd === "review") {
        const v = rest[0];
        if (v === "light" || v === "strict" || v === "off") { const next: AdvisorConfig = { ...cfg, review: v }; saveConfig(next); setPiRogueStatus(ctx, next, state); ctx.ui.notify(`Review set to ${v}.`, "info"); return; }
        ctx.ui.notify("Usage: /pi-rogue-advisor review light|strict|off", "error");
        return;
      }
      if (cmd === "checkins" || cmd === "checkin") {
        ctx.ui.notify([
          "Advisor check-ins are orchestration-managed now.",
          `Current: ${checkinDescription(cfg)}`,
          "Create or resume /pi-rogue-orchestration goal or loop to activate scheduled higher-model check-ins; stop or clear either to disable them.",
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
      if (r.error) {
        ctx.ui.notify(r.text, "warning");
        return;
      }
      sendAdvisorAnswer(pi, r.text);
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI) { registerAdvisor(pi); }
