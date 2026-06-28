import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { appendText, featureDir, featureFile, readText, truncate, writeText, atomicWriteText } from "./internal.js";
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
import { findMissingArtifactReferences } from "./artifact-preflight.js";
import { findMissingReviewArtifacts } from "./review-preflight.js";
import { buildBoardLedger, decideBoardAction } from "./board.js";
import {
  callHeadOfBoardAdapter,
  defaultHeadOfBoardConfig,
  mergeHeadOfBoardRisks,
  normalizeHeadOfBoardConfig,
  type HeadOfBoardConfig,
} from "./board-head.js";
import { loadBoardRoleBody, loadBoardRoleCatalog } from "./board-roles.js";
import {
  callReadOnlySpecialist,
  defaultSpecialistCallState,
  defaultSpecialistDispatchConfig,
  normalizeSpecialistDispatchConfig,
  suggestSpecialistRoles,
  type SpecialistCallState,
  type SpecialistDispatchConfig,
} from "./board-specialist.js";
import {
  boardEventsFromAdvisorState,
  defaultBoardShadowConfig,
  defaultBoardShadowState,
  formatBoardShadowStatus,
  normalizeBoardShadowConfig,
  normalizeBoardShadowState,
  runBoardShadowDecision,
  type BoardShadowConfig,
  type BoardShadowState,
} from "./board-shadow.js";

// ── Config: 3 optional fields ────────────────────────────────────────────

export type AdvisorProfileId = "budget-board";

export interface AdvisorProfileRestore {
  mode: "auto" | "manual" | "off";
  review: "light" | "strict" | "off";
  checkins: "mid-hour" | "off";
  checkinIntervalMinutes: number;
  model?: string;
  /** Advisor model written by the profile; used to distinguish profile-owned vs user-changed model overrides. */
  profileModel?: string;
  board: BoardShadowConfig;
  headOfBoard: HeadOfBoardConfig;
  specialistDispatch: SpecialistDispatchConfig;
}

export interface AdvisorConfig {
  /** Explicit Pi-Rogue advisor profile; unset means built-in behavior only. */
  profile?: AdvisorProfileId;
  /** Previous advisor settings captured before applying the active profile. */
  profileRestore?: AdvisorProfileRestore;
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
  /** Advisor Board phase-1 shadow/probation mode. */
  board: BoardShadowConfig;
  /** Isolated Head-of-Board escalation adapter; disabled by default. */
  headOfBoard: HeadOfBoardConfig;
  /** Read-only specialist dispatch policy; suggest-only by default. */
  specialistDispatch: SpecialistDispatchConfig;
}

const DEFAULT_CONFIG: AdvisorConfig = {
  mode: "auto",
  review: "light",
  checkins: "off",
  checkinIntervalMinutes: 30,
  board: defaultBoardShadowConfig(),
  headOfBoard: defaultHeadOfBoardConfig(),
  specialistDispatch: defaultSpecialistDispatchConfig(),
};

const CONFIG_PATH = featureFile("advisor", "config.json");
const LEGACY_STATE_PATH = featureFile("advisor", "state.json");
const CACHE_PATH = featureFile("advisor", "cache.json");
const HISTORY_PATH = featureFile("advisor", "history.jsonl");
const DEFAULT_DIAGNOSTICS_PATH = featureFile("advisor", "diagnostics.jsonl");
const SESSION_STATE_PROP = "__piRogueAdvisorStatePath";
const ORCHESTRATION_DIR = join(homedir(), ".pi", "agent", "fiale-plus", "orchestration");

const MAX_CACHE = 64;
const MAX_NOTES = 12;
const MAX_FILES = 8;
const MAX_ERRORS = 5;
const MAX_EVIDENCE = 32;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 15 * 60;
const MIN_CHECKIN_INTERVAL_MINUTES = 10;
const MAX_CHECKIN_INTERVAL_MINUTES = 240;
const STATE_VERSION = 1;
const checkinLocks = new Set<string>();
const reviewLocks = new Set<string>();

const REVIEW_TASK_ACTIONS_LIMIT = 2;
const ADVISORY_SIGNALS_LIMIT = 4;
const BUDGET_BOARD_PROFILE_ID: AdvisorProfileId = "budget-board";

// ── SOTA models (ordered by preference) ───────────────────────────────────
const SOTA_CHAIN: Array<{ provider: string; model: string; label: string }> = [
  { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5 (Codex)" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "openai-codex", model: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

const CHEAP_DRIVER_CHAIN = [
  "openai-codex/gpt-5.5-mini",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.3-codex-spark",
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
  evidenceLedger: EvidenceLedgerEntry[];
  workflow?: WorkflowState;
  rateLimit?: AdvisorRateLimitState;
  advisorLoop?: AdvisorLoopState;
  board?: BoardShadowState;
  headOfBoard?: {
    calls: number;
    lastAt?: string;
    lastModel?: string;
    lastSkipped?: string;
  };
  specialistDispatch?: SpecialistCallState & {
    lastAt?: string;
    lastRole?: string;
    lastNote?: string;
    lastDenied?: string;
  };
  advisorPauseUntilTurn?: number;
}

type EvidenceKind = "validation" | "merge";
type EvidenceResult = "pass" | "fail" | "merged" | "not_merged" | "error";

type EvidenceLedgerEntry = {
  kind: EvidenceKind;
  sha?: string;
  command?: string;
  source: string;
  result: EvidenceResult;
  timestamp: string;
  exitCode?: number;
  pr?: number;
  details?: string;
};

type WorkflowState = {
  terminal?: {
    state: "green" | "merged";
    sha?: string;
    source: string;
    timestamp: string;
    reason: string;
    pr?: number;
  };
};

type AdvisorRateLimitState = {
  active: boolean;
  since: string;
  until: string;
  reason: string;
  retryAfterSeconds?: number;
};
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
    evidenceLedger: [],
    workflow: {},
    advisorLoop: defaultAdvisorLoopState(),
    board: defaultBoardShadowState(),
    headOfBoard: { calls: 0 },
    specialistDispatch: defaultSpecialistCallState(),
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

function normalizeProfileRestore(raw: unknown): AdvisorProfileRestore | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<AdvisorProfileRestore>;
  const interval = Number(record.checkinIntervalMinutes ?? DEFAULT_CONFIG.checkinIntervalMinutes);
  return {
    mode: record.mode === "manual" || record.mode === "off" ? record.mode : "auto",
    review: record.review === "strict" || record.review === "off" ? record.review : "light",
    checkins: record.checkins === "mid-hour" ? "mid-hour" : DEFAULT_CONFIG.checkins,
    checkinIntervalMinutes: Math.min(
      MAX_CHECKIN_INTERVAL_MINUTES,
      Math.max(
        MIN_CHECKIN_INTERVAL_MINUTES,
        Number.isFinite(interval) ? Math.round(interval) : DEFAULT_CONFIG.checkinIntervalMinutes,
      ),
    ),
    model: record.model || undefined,
    profileModel: record.profileModel || undefined,
    board: normalizeBoardShadowConfig(record.board),
    headOfBoard: normalizeHeadOfBoardConfig(record.headOfBoard),
    specialistDispatch: normalizeSpecialistDispatchConfig(record.specialistDispatch),
  };
}

export function normalizeAdvisorConfig(raw: Partial<AdvisorConfig> = {}): AdvisorConfig {
  const interval = Number(raw.checkinIntervalMinutes ?? DEFAULT_CONFIG.checkinIntervalMinutes);
  const startedAt = Number(raw.checkinStartedAt);
  return {
    profile: raw.profile === BUDGET_BOARD_PROFILE_ID ? raw.profile : undefined,
    profileRestore: raw.profile === BUDGET_BOARD_PROFILE_ID ? normalizeProfileRestore(raw.profileRestore) : undefined,
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
    board: normalizeBoardShadowConfig(raw.board),
    headOfBoard: normalizeHeadOfBoardConfig(raw.headOfBoard),
    specialistDispatch: normalizeSpecialistDispatchConfig(raw.specialistDispatch),
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

function normalizeEvidenceLedger(raw: unknown): EvidenceLedgerEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): EvidenceLedgerEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const obj = entry as Partial<EvidenceLedgerEntry>;
    const kind = obj.kind === "validation" || obj.kind === "merge" ? obj.kind : undefined;
    const result = obj.result === "pass" || obj.result === "fail" || obj.result === "merged" || obj.result === "not_merged" || obj.result === "error" ? obj.result : undefined;
    const timestamp = typeof obj.timestamp === "string" && obj.timestamp ? obj.timestamp : undefined;
    const source = typeof obj.source === "string" && obj.source ? obj.source : undefined;
    if (!kind || !result || !timestamp || !source) return [];
    const exitCode = Number(obj.exitCode);
    const pr = Number(obj.pr);
    return [{
      kind,
      result,
      timestamp,
      source,
      sha: typeof obj.sha === "string" && obj.sha ? obj.sha : undefined,
      command: typeof obj.command === "string" && obj.command ? obj.command : undefined,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      pr: Number.isFinite(pr) ? pr : undefined,
      details: typeof obj.details === "string" && obj.details ? obj.details : undefined,
    }];
  }).slice(-MAX_EVIDENCE);
}

function normalizeWorkflowState(raw: unknown): WorkflowState {
  if (!raw || typeof raw !== "object") return {};
  const terminal = (raw as WorkflowState).terminal;
  if (!terminal || typeof terminal !== "object") return {};
  if (terminal.state !== "green" && terminal.state !== "merged") return {};
  const timestamp = typeof terminal.timestamp === "string" && terminal.timestamp ? terminal.timestamp : new Date().toISOString();
  const source = typeof terminal.source === "string" && terminal.source ? terminal.source : "unknown";
  const reason = typeof terminal.reason === "string" && terminal.reason ? terminal.reason : terminal.state;
  const pr = Number(terminal.pr);
  return {
    terminal: {
      state: terminal.state,
      timestamp,
      source,
      reason,
      sha: typeof terminal.sha === "string" && terminal.sha ? terminal.sha : undefined,
      pr: Number.isFinite(pr) ? pr : undefined,
    },
  };
}

function normalizeRateLimitState(raw: unknown): AdvisorRateLimitState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const state = raw as Partial<AdvisorRateLimitState>;
  if (state.active !== true) return undefined;
  if (typeof state.since !== "string" || typeof state.until !== "string" || typeof state.reason !== "string") return undefined;
  const retryAfterSeconds = Number(state.retryAfterSeconds);
  return {
    active: true,
    since: state.since,
    until: state.until,
    reason: state.reason,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
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
      terminalEvidence: normalizeTerminalEvidence((control as { terminalEvidence?: unknown } | undefined)?.terminalEvidence),
    },
    evidenceLedger: normalizeEvidenceLedger(raw.evidenceLedger),
    workflow: normalizeWorkflowState(raw.workflow),
    rateLimit: normalizeRateLimitState(raw.rateLimit),
    advisorLoop: raw.advisorLoop && typeof raw.advisorLoop === "object" ? {
      repeatCount: Number((raw.advisorLoop as { repeatCount?: unknown }).repeatCount) || 0,
      recent: Array.isArray((raw.advisorLoop as { recent?: unknown }).recent)
        ? (raw.advisorLoop as { recent: unknown[] }).recent.map((entry) => entry && typeof entry === "object" ? entry as Partial<AdvisorLoopEntry> : undefined).filter((entry): entry is Partial<AdvisorLoopEntry> => Boolean(entry?.outputHash && entry?.contextHash && entry?.familyHash && entry?.source)).map((entry) => ({
          outputHash: String(entry.outputHash),
          outputText: String(entry.outputText ?? ""),
          contextHash: String(entry.contextHash),
          familyHash: String(entry.familyHash),
          source: String(entry.source),
          repeatCount: Number(entry.repeatCount) || 1,
          at: String(entry.at ?? ""),
        })).slice(-8)
        : [],
      lastOutputHash: typeof (raw.advisorLoop as { lastOutputHash?: unknown }).lastOutputHash === "string" ? (raw.advisorLoop as { lastOutputHash?: string }).lastOutputHash : undefined,
      lastOutputText: typeof (raw.advisorLoop as { lastOutputText?: unknown }).lastOutputText === "string" ? (raw.advisorLoop as { lastOutputText?: string }).lastOutputText : undefined,
      lastContextHash: typeof (raw.advisorLoop as { lastContextHash?: unknown }).lastContextHash === "string" ? (raw.advisorLoop as { lastContextHash?: string }).lastContextHash : undefined,
      lastSource: typeof (raw.advisorLoop as { lastSource?: unknown }).lastSource === "string" ? (raw.advisorLoop as { lastSource?: string }).lastSource : undefined,
      lastObservedAt: typeof (raw.advisorLoop as { lastObservedAt?: unknown }).lastObservedAt === "string" ? (raw.advisorLoop as { lastObservedAt?: string }).lastObservedAt : undefined,
    } : defaultAdvisorLoopState(),
    board: normalizeBoardShadowState(raw.board),
    headOfBoard: raw.headOfBoard && typeof raw.headOfBoard === "object" ? {
      calls: Math.max(0, Math.floor(Number((raw.headOfBoard as { calls?: unknown }).calls) || 0)),
      lastAt: typeof (raw.headOfBoard as { lastAt?: unknown }).lastAt === "string" ? (raw.headOfBoard as { lastAt?: string }).lastAt : undefined,
      lastModel: typeof (raw.headOfBoard as { lastModel?: unknown }).lastModel === "string" ? (raw.headOfBoard as { lastModel?: string }).lastModel : undefined,
      lastSkipped: typeof (raw.headOfBoard as { lastSkipped?: unknown }).lastSkipped === "string" ? (raw.headOfBoard as { lastSkipped?: string }).lastSkipped : undefined,
    } : { calls: 0 },
    specialistDispatch: raw.specialistDispatch && typeof raw.specialistDispatch === "object" ? {
      calls: Math.max(0, Math.floor(Number((raw.specialistDispatch as { calls?: unknown }).calls) || 0)),
      byRole: (raw.specialistDispatch as { byRole?: SpecialistCallState["byRole"] }).byRole && typeof (raw.specialistDispatch as { byRole?: unknown }).byRole === "object" ? (raw.specialistDispatch as { byRole: SpecialistCallState["byRole"] }).byRole : {},
      lastAt: typeof (raw.specialistDispatch as { lastAt?: unknown }).lastAt === "string" ? (raw.specialistDispatch as { lastAt?: string }).lastAt : undefined,
      lastRole: typeof (raw.specialistDispatch as { lastRole?: unknown }).lastRole === "string" ? (raw.specialistDispatch as { lastRole?: string }).lastRole : undefined,
      lastNote: typeof (raw.specialistDispatch as { lastNote?: unknown }).lastNote === "string" ? (raw.specialistDispatch as { lastNote?: string }).lastNote : undefined,
      lastDenied: typeof (raw.specialistDispatch as { lastDenied?: unknown }).lastDenied === "string" ? (raw.specialistDispatch as { lastDenied?: string }).lastDenied : undefined,
    } : defaultSpecialistCallState(),
    advisorPauseUntilTurn: Number.isFinite(pauseUntil) ? pauseUntil : undefined,
  }, path);
}

function saveState(s: SessionState) {
  atomicWriteText(statePathFor(s), JSON.stringify(s, null, 2) + "\n");
}

const BOARD_SHADOW_COMMON_SECRET_RE = /\b(?:sk|ghp|gho|github_pat|xox[abprs]|hf|AKIA)[-_][A-Za-z0-9_\-]{8,}\b/g;
const BOARD_SHADOW_AUTH_BEARER_RE = /\bauthorization\b\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const BOARD_SHADOW_BARE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BOARD_SHADOW_KEYED_SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;}]{4,}/gi;
const BOARD_SHADOW_NAMED_SECRET_RE = /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*_[A-Za-z0-9_=-]{4,}\b/gi;

function redactBoardShadowText(text: unknown): string {
  return sanitizeAdvisorText(text)
    .replace(BOARD_SHADOW_AUTH_BEARER_RE, (match) => `${match.split(/[:=]/, 1)[0]}=[secret]`)
    .replace(BOARD_SHADOW_BARE_BEARER_RE, "Bearer [secret]")
    .replace(BOARD_SHADOW_COMMON_SECRET_RE, "[secret]")
    .replace(BOARD_SHADOW_KEYED_SECRET_RE, (match) => `${match.split(/[:=]/, 1)[0]}=[secret]`)
    .replace(BOARD_SHADOW_NAMED_SECRET_RE, "[secret]");
}

function compactEvidenceEntry(entry: EvidenceLedgerEntry | undefined): Record<string, unknown> | undefined {
  if (!entry) return undefined;
  return {
    kind: entry.kind,
    result: entry.result,
    source: entry.source,
    command: entry.command ? truncate(redactBoardShadowText(entry.command), 240) : undefined,
    timestamp: entry.timestamp,
    exitCode: entry.exitCode,
    sha: entry.sha,
    pr: entry.pr,
  };
}

function boardRouteSnapshot(route: AdvisorRouteDecision | undefined): Record<string, unknown> | undefined {
  if (!route) return undefined;
  const raw = route as unknown as Record<string, unknown>;
  return {
    summary: summarizeRoute(route),
    label: raw.label,
    source: raw.source,
    confidence: raw.confidence,
    safety: Boolean(raw.safety),
    reason: typeof raw.reason === "string" ? truncate(sanitizeAdvisorText(raw.reason), 240) : undefined,
    trajectory: raw.trajectory,
  };
}

function boardShadowArtifactContext(state: SessionState, result: ReturnType<typeof runBoardShadowDecision>): Record<string, unknown> {
  const latestValidation = latestEvidence(state, "validation");
  const latestMerge = latestEvidence(state, "merge");
  const repeatCount = state.advisorLoop?.repeatCount ?? 0;
  return {
    sessionOutcome: {
      terminal: state.workflow?.terminal,
      latestValidation: compactEvidenceEntry(latestValidation),
      latestMerge: compactEvidenceEntry(latestMerge),
      evidenceTail: (state.evidenceLedger ?? []).slice(-8).map(compactEvidenceEntry).filter(Boolean),
      outcomeKnown: Boolean(state.workflow?.terminal || latestMerge || latestValidation),
    },
    advisor: {
      calls: state.advisorCalls,
      cacheHits: state.cacheHits,
      followUpQueued: Boolean(state.followUp),
      reviewSignalCount: state.reviewSignals.length,
      reviewControl: {
        status: state.reviewControl.status,
        pending: state.reviewControl.pending,
        consumed: state.reviewControl.consumed,
        running: state.reviewControl.running,
        lastDecision: state.reviewControl.lastDecision,
        lastReason: state.reviewControl.lastReason ? truncate(sanitizeAdvisorText(state.reviewControl.lastReason), 240) : undefined,
        lastTrigger: state.reviewControl.lastTrigger,
        terminalEvidence: state.reviewControl.terminalEvidence,
      },
      loop: {
        repeatCount,
        lastSource: state.advisorLoop?.lastSource,
        lastObservedAt: state.advisorLoop?.lastObservedAt,
        recent: (state.advisorLoop?.recent ?? []).slice(-4).map((entry) => ({
          outputHash: entry.outputHash,
          contextHash: entry.contextHash,
          familyHash: entry.familyHash,
          source: entry.source,
          repeatCount: entry.repeatCount,
          at: entry.at,
        })),
      },
    },
    router: {
      preflight: boardRouteSnapshot(state.router.preflight),
      review: boardRouteSnapshot(state.router.review),
    },
    probationMeasurements: {
      falsePositiveRate: null,
      usefulEdgeMomentCatchCandidates: result.decision.action === "would_whisper" ? 1 : 0,
      tokenCostOverheadUsd: 0,
      modelCalls: 0,
      liveWhispers: 0,
      specialistDispatches: 0,
      seniorAdvisorEscalations: state.headOfBoard?.calls ?? 0,
      steerActions: 0,
      mutatingToolAccess: 0,
      duplicateAdviceSignals: Math.max(0, repeatCount - 1),
      staleEvidenceRisks: result.risks.filter((risk) => risk.type === "stale_evidence").length,
      outcomeKnown: Boolean(state.workflow?.terminal),
    },
  };
}

function recordBoardShadowIfEnabled(ctx: any, cfg: AdvisorConfig, state: SessionState, source: string, toolResults?: any[]): void {
  if (cfg.board.mode !== "shadow") return;
  const result = runBoardShadowDecision({
    sessionId: sessionKey(ctx),
    worktree: String(ctx?.cwd || ""),
    turns: state.turns,
    evidenceLedger: state.evidenceLedger,
    toolResults,
  }, state.board);
  state.board = result.state;
  appendText(join(advisorSessionDir(ctx), "board-shadow.jsonl"), `${JSON.stringify({
    schema: "pi-rogue.advisor-board.shadow.v1",
    at: result.state.lastAt,
    source,
    decision: result.decision,
    riskIds: result.risks.map((risk) => risk.id),
    risks: result.risks,
    context: boardShadowArtifactContext(state, result),
  })}\n`);
}

function headOfBoardStatusText(cfg: AdvisorConfig, state: SessionState): string {
  return [
    `Advisor Head-of-Board: ${cfg.headOfBoard.mode}`,
    `Calls: ${state.headOfBoard?.calls ?? 0}`,
    state.headOfBoard?.lastAt ? `Last: ${state.headOfBoard.lastAt}` : "Last: never",
    state.headOfBoard?.lastModel ? `Last model: ${state.headOfBoard.lastModel}` : undefined,
    state.headOfBoard?.lastSkipped ? `Last skipped: ${state.headOfBoard.lastSkipped}` : undefined,
    "Constraints: isolated, read-only, compact board ledger only, no mutating tools/raw transcript.",
  ].filter(Boolean).join("\n");
}

function currentBoardLedger(ctx: any, state: SessionState) {
  const events = boardEventsFromAdvisorState({
    sessionId: sessionKey(ctx),
    worktree: String(ctx?.cwd || ""),
    turns: state.turns,
    pendingFiles: state.board?.pendingFiles,
    evidenceLedger: state.evidenceLedger,
  });
  return mergeHeadOfBoardRisks(buildBoardLedger(events), state.board?.lastRisks);
}

async function runHeadOfBoardCommand(ctx: any, cfg: AdvisorConfig, state: SessionState, question: string): Promise<void> {
  const ledger = currentBoardLedger(ctx, state);
  const decision = decideBoardAction(ledger);
  state.headOfBoard = state.headOfBoard ?? { calls: 0 };
  const result = await callHeadOfBoardAdapter(cfg.headOfBoard, { ledger, decision, question, reason: "user_request" }, async (systemPrompt, messages, options) => {
    return completeWithHigherAdvisorModel(ctx, cfg, systemPrompt, messages, { ...options, allowRegularFallback: false, maxAttempts: 1 });
  });
  if (result.skipped) {
    state.headOfBoard.lastSkipped = result.skipped;
    saveState(state);
    ctx.ui.notify(`Head-of-Board skipped: ${result.skipped}. Enable with /pi-rogue-advisor board head on.`, "info");
    return;
  }
  if (!result.response) {
    state.headOfBoard.lastSkipped = "no_response";
    saveState(state);
    ctx.ui.notify("Head-of-Board produced no response.", "warning");
    return;
  }
  state.headOfBoard.calls += result.accounting.headOfBoardCalls;
  state.headOfBoard.lastAt = new Date().toISOString();
  state.headOfBoard.lastModel = result.response.model;
  state.headOfBoard.lastSkipped = undefined;
  saveState(state);
  ctx.ui.notify(`Head-of-Board (${result.response.model}):\n${result.response.text}`, "info");
}

function specialistDispatchStatusText(cfg: AdvisorConfig, state: SessionState): string {
  return [
    `Advisor Specialists: ${cfg.specialistDispatch.mode}`,
    `Calls: ${state.specialistDispatch?.calls ?? 0}`,
    state.specialistDispatch?.lastRole ? `Last role: ${state.specialistDispatch.lastRole}` : "Last role: none",
    state.specialistDispatch?.lastNote ? `Last note: ${truncate(sanitizeAdvisorText(state.specialistDispatch.lastNote), 240)}` : undefined,
    state.specialistDispatch?.lastDenied ? `Last denied: ${state.specialistDispatch.lastDenied}` : undefined,
    `Policy: cooldown=${cfg.specialistDispatch.cooldownTurns} turns, maxCalls=${cfg.specialistDispatch.maxCallsPerSession}, maxCost=${cfg.specialistDispatch.maxCostTier}`,
    "Constraints: read-only specialists only, compact ledger input, strict JSON result schema.",
  ].filter(Boolean).join("\n");
}

function specialistById(roleId: string) {
  const catalog = loadBoardRoleCatalog();
  if (catalog.diagnostics.length > 0) return { diagnostic: catalog.diagnostics[0]?.message ?? "catalog diagnostics" };
  const summary = catalog.roles.find((role) => role.id === roleId);
  if (!summary) return { diagnostic: `unknown specialist '${roleId}'` };
  const loaded = loadBoardRoleBody(summary);
  if (loaded.diagnostic) return { diagnostic: loaded.diagnostic.message };
  return { role: loaded.role };
}

async function runSpecialistCommand(ctx: any, cfg: AdvisorConfig, state: SessionState, roleId: string, task: string): Promise<void> {
  const found = specialistById(roleId);
  if (!found.role) {
    ctx.ui.notify(found.diagnostic ?? "Specialist unavailable.", "error");
    return;
  }
  state.specialistDispatch = state.specialistDispatch ?? defaultSpecialistCallState();
  const result = await callReadOnlySpecialist({
    role: found.role,
    ledger: currentBoardLedger(ctx, state),
    task,
    config: cfg.specialistDispatch,
    state: state.specialistDispatch,
    currentTurn: state.turns,
    complete: async (systemPrompt, messages, options) => {
      const resp = await completeWithHigherAdvisorModel(ctx, cfg, systemPrompt, messages, { maxTokens: options.maxTokens, reasoning: "medium", allowRegularFallback: false, maxAttempts: 1 });
      if (!resp || resp.rateLimited) throw new Error(resp?.text || "specialist model unavailable");
      return resp.text;
    },
  });
  if ("denied" in result) {
    state.specialistDispatch.lastDenied = result.denied;
    saveState(state);
    ctx.ui.notify(`Specialist dispatch denied: ${result.denied}`, "warning");
    return;
  }
  if ("error" in result) {
    state.specialistDispatch = { ...result.state, lastAt: new Date().toISOString(), lastRole: roleId, lastNote: undefined, lastDenied: result.error };
    saveState(state);
    ctx.ui.notify(`Specialist ${roleId} failed: ${result.error}`, "warning");
    return;
  }
  state.specialistDispatch = { ...result.state, lastAt: new Date().toISOString(), lastRole: roleId, lastNote: result.note, lastDenied: undefined };
  saveState(state);
  ctx.ui.notify(`Specialist ${roleId}:\n${result.note}`, "info");
}

function suggestedSpecialistText(ctx: any, state: SessionState): string {
  const catalog = loadBoardRoleCatalog();
  if (catalog.diagnostics.length > 0) return `Role catalog diagnostics: ${catalog.diagnostics.map((item) => item.message).join("; ")}`;
  const suggestions = suggestSpecialistRoles(catalog.roles, currentBoardLedger(ctx, state));
  if (suggestions.length === 0) return "No specialist suggestion from current compact board ledger.";
  return suggestions.map((role) => `${role.id} — ${role.summary}`).join("\n");
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
  const terminal = terminalWorkflowReason(s);
  const latestValidation = latestEvidence(s, "validation");
  const validationPassed = latestValidation?.result === "pass";
  if (s.lastTask) lines.push(`Task: ${truncate(sanitizeAdvisorText(s.lastTask), 200)}`);
  if (s.turns) lines.push(`Turns: ${s.turns}`);
  if (latestValidation) {
    lines.push(`Latest validation: ${latestValidation.result}${latestValidation.command ? ` (${latestValidation.command})` : ""}${latestValidation.sha ? ` @ ${latestValidation.sha}` : ""}`);
  }
  if (terminal) {
    lines.push(`Workflow: ${terminal}`);
  } else {
    const notes = validationPassed ? s.notes.filter((note) => !/\b(?:fail(?:ed|ing)?|error|broken)\b/i.test(note)) : s.notes;
    if (notes.length) { lines.push("Notes:"); notes.slice(-4).forEach(n => lines.push(`- ${truncate(n, 200)}`)); }
    if (!validationPassed && s.errors.length) lines.push(`Errors: ${sanitizeAdvisorText(s.errors.slice(-2).join(" | "))}`);
  }
  if (s.files.length) lines.push(`Files: ${sanitizeAdvisorText(s.files.slice(-4).join(", "))}`);
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

function safeCurrentGitSha(ctx: any): string | undefined {
  const hinted = ctx?.git?.headSha ?? ctx?.git?.sha ?? ctx?.repository?.headSha;
  if (typeof hinted === "string" && hinted.trim()) return hinted.trim();
  const cwd = String(ctx?.cwd ?? process.cwd());
  try {
    const raw = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return String(raw).trim() || undefined;
  } catch {
    return undefined;
  }
}

function toolCommand(tool: any): string | undefined {
  const command = tool?.command ?? tool?.input?.command ?? tool?.args?.command ?? tool?.details?.command ?? tool?.toolName ?? tool?.name;
  const text = squish(command, 240);
  return text || undefined;
}

function toolExitCode(tool: any): number | undefined {
  for (const candidate of [tool?.exitCode, tool?.exit_code, tool?.code, tool?.details?.exitCode, tool?.details?.exit_code, tool?.result?.exitCode]) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function toolEvidenceText(tool: any): string {
  return [
    contentText(tool?.content),
    contentText(tool?.message),
    tool?.stdout,
    tool?.stderr,
    tool?.output,
    tool?.text,
    tool?.error,
    tool?.details?.stdout,
    tool?.details?.stderr,
    tool?.details?.output,
  ].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n").slice(0, 8000);
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  return [...new Set(candidates)].flatMap((candidate) => {
    try {
      return [JSON.parse(candidate)];
    } catch {
      return [];
    }
  });
}

function vitestResultFromValue(value: unknown): "pass" | "fail" | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const failedNumbers = ["numFailedTests", "numFailedTestSuites", "numTotalFailedTests"]
    .map((key) => Number(obj[key]))
    .filter((num) => Number.isFinite(num));
  if (failedNumbers.some((num) => num > 0)) return "fail";
  const hasExplicitZeroFailures = failedNumbers.length > 0 && failedNumbers.every((num) => num === 0);
  if (obj.success === false || obj.ok === false) return "fail";
  if (hasExplicitZeroFailures && obj.success !== false) return "pass";
  if ((obj.success === true || obj.ok === true) && (obj.numTotalTests !== undefined || obj.numTotalTestSuites !== undefined || obj.testResults !== undefined)) return "pass";
  let nestedPass = false;
  for (const nested of Object.values(obj)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const result = vitestResultFromValue(item);
        if (result === "fail") return "fail";
        if (result === "pass") nestedPass = true;
      }
    } else if (nested && typeof nested === "object") {
      const result = vitestResultFromValue(nested);
      if (result === "fail") return "fail";
      if (result === "pass") nestedPass = true;
    }
  }
  return nestedPass ? "pass" : undefined;
}

function parseVitestResult(text: string): "pass" | "fail" | undefined {
  for (const candidate of parseJsonCandidates(text)) {
    const result = vitestResultFromValue(candidate);
    if (result) return result;
  }
  return undefined;
}

function looksLikeValidationCommand(command: string | undefined, text: string): boolean {
  const commandText = command ?? "";
  return /\b(vitest|jest|pytest|npm\s+(?:test|run\s+(?:test|check|typecheck|lint))|pnpm\s+(?:test|run\s+(?:test|check|typecheck|lint))|yarn\s+(?:test|run\s+(?:test|check|typecheck|lint))|cargo\s+test|go\s+test|tsc\b|typecheck|lint)\b/i.test(commandText)
    || parseVitestResult(text) !== undefined
    || HUMAN_TEST_SUMMARY_RE.test(text);
}

function structuredValidationResult(tool: any): "pass" | "fail" | undefined {
  const text = toolEvidenceText(tool);
  const vitest = parseVitestResult(text);
  if (vitest) return vitest;
  if (STRUCTURED_FAILING_TEST_RE.test(text)) return "fail";
  if (STRUCTURED_GREEN_TEST_RE.test(text)) return "pass";
  const exitCode = toolExitCode(tool);
  if (exitCode !== undefined) return exitCode === 0 ? "pass" : "fail";
  const status = String(tool?.status ?? tool?.details?.status ?? "").toLowerCase();
  if (["success", "ok", "completed", "passed"].includes(status)) return "pass";
  if (["error", "failure", "failed"].includes(status) || tool?.isError === true || (tool?.error && String(tool.error).length > 0)) return "fail";
  return undefined;
}

function toolOverallFailed(tool: any): boolean {
  const exitCode = toolExitCode(tool);
  if (exitCode !== undefined) return exitCode !== 0;
  const status = String(tool?.status ?? tool?.details?.status ?? "").toLowerCase();
  if (["error", "failure", "failed"].includes(status)) return true;
  if (tool?.isError === true) return true;
  if (tool?.error && String(tool.error).length > 0) return true;
  return false;
}

function validationPassHasSeparateFailure(tool: any, command: string | undefined, output: string): boolean {
  if (!toolOverallFailed(tool)) return false;
  const combined = `${command ?? ""}\n${output}`;
  return /\bgh\s+pr\s+merge\b/i.test(combined)
    || /\b(?:fatal:|GraphQL:|Command exited with code\s+[1-9]\d*|error:)/i.test(output);
}

function clearGreenTerminalWorkflow(state: SessionState, reason: string): void {
  if (state.workflow?.terminal?.state !== "green") return;
  state.workflow = { ...(state.workflow ?? {}) };
  delete state.workflow.terminal;
  state.reviewControl.terminalEvidence = undefined;
  appendAdvisorDiagnostic("green_terminal_cleared", { reason, task: state.lastTask });
}


function validationResultForTools(toolResults: any[]): "pass" | "fail" | undefined {
  let sawPass = false;
  for (const tool of toolResults) {
    const command = toolCommand(tool);
    const output = toolEvidenceText(tool);
    if (!looksLikeValidationCommand(command, output)) continue;
    const result = structuredValidationResult(tool);
    if (result === "fail") return "fail";
    if (result === "pass") sawPass = true;
  }
  return sawPass ? "pass" : undefined;
}

type ToolBatchEvaluation = {
  latestValidation?: "pass" | "fail";
  separateFailure: boolean;
  failed: boolean;
};

function evaluateToolBatch(toolResults: any[]): ToolBatchEvaluation {
  let latestValidation: "pass" | "fail" | undefined;
  let separateFailure = false;
  for (const tool of toolResults) {
    const command = toolCommand(tool);
    const output = toolEvidenceText(tool);
    const isValidation = looksLikeValidationCommand(command, output);
    if (isValidation) {
      const result = structuredValidationResult(tool);
      if (result) latestValidation = result;
      if (result === "pass" && validationPassHasSeparateFailure(tool, command, output)) separateFailure = true;
      continue;
    }
    if (isActualFailure(tool)) separateFailure = true;
  }
  return { latestValidation, separateFailure, failed: separateFailure || latestValidation === "fail" };
}

function effectiveFailureFromTools(state: SessionState, toolResults: any[]): boolean {
  if (mergedTerminalWorkflowReason(state)) return false;
  const evaluation = evaluateToolBatch(toolResults);
  if (evaluation.failed) {
    clearGreenTerminalWorkflow(state, "tool failed");
    return true;
  }
  return false;
}

function hasUnresolvedMergeSignal(state: SessionState, toolResults: any[], text: string): boolean {
  for (const tool of toolResults) {
    const command = toolCommand(tool);
    const output = toolEvidenceText(tool);
    const mergeText = [command, output, text, state.lastTask].filter(Boolean).join("\n");
    if (!/\bgh\s+pr\s+(?:view|merge)\b/i.test(mergeText) && !/\bstate\b["'\s:=]+(?:MERGED|OPEN|CLOSED)\b/i.test(mergeText)) continue;
    const prState = parsePrState(output || text);
    if (prState) return prState.state !== "MERGED";
    if (/\bgh\s+pr\s+merge\b/i.test(mergeText)) return true;
  }
  return false;
}

function latestEvidence(state: SessionState, kind: EvidenceKind): EvidenceLedgerEntry | undefined {
  return [...(state.evidenceLedger ?? [])].reverse().find((entry) => entry.kind === kind);
}

function clearValidationResolvedReview(state: SessionState, entry: EvidenceLedgerEntry, ctx?: any): void {
  const reason = "latest validation passed";
  state.followUp = "";
  state.followUpTask = undefined;
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  state.advisorLoop = defaultAdvisorLoopState();
  if (state.router.review?.trajectory) {
    state.router.review = {
      ...state.router.review,
      reason,
      trajectory: { ...state.router.review.trajectory, failed: false },
    };
  }
  state.reviewControl = {
    ...state.reviewControl,
    status: "consumed",
    pending: false,
    consumed: true,
    running: false,
    lastDecision: "continue",
    lastReason: reason,
    lastAppliedAt: entry.timestamp,
  };
  if (ctx) writeText(advisorCurrentPath(ctx), `${formatAdvisorDisplay("advisor:llm", "continue", reason)}\n`);
}

function clearMergedResolvedReview(state: SessionState, entry: EvidenceLedgerEntry, ctx?: any): void {
  const reason = "PR merged";
  state.followUp = "";
  state.followUpTask = undefined;
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  state.advisorLoop = defaultAdvisorLoopState();
  if (state.router.review?.trajectory) {
    state.router.review = {
      ...state.router.review,
      reason,
      trajectory: { ...state.router.review.trajectory, failed: false },
    };
  }
  state.reviewControl = {
    ...state.reviewControl,
    status: "consumed",
    pending: false,
    consumed: true,
    running: false,
    lastDecision: "continue",
    lastReason: reason,
    lastAppliedAt: entry.timestamp,
  };
  if (ctx) writeText(advisorCurrentPath(ctx), `${formatAdvisorDisplay("advisor:llm", "continue", reason)}\n`);
}


function appendEvidence(state: SessionState, entry: EvidenceLedgerEntry, ctx?: any, options: { clearResolved?: boolean } = {}): void {
  state.evidenceLedger = [...(state.evidenceLedger ?? []), entry].slice(-MAX_EVIDENCE);
  if (entry.kind === "merge" && entry.result === "merged") {
    state.workflow = {
      ...(state.workflow ?? {}),
      terminal: {
        state: "merged",
        sha: entry.sha,
        source: entry.source,
        timestamp: entry.timestamp,
        reason: "PR merged",
        pr: entry.pr,
      },
    };
    clearMergedResolvedReview(state, entry, ctx);
    return;
  }
  if (entry.kind === "validation" && entry.result === "pass" && options.clearResolved !== false) {
    clearValidationResolvedReview(state, entry, ctx);
  }
}

function parsePrState(text: string): { state: string; mergeCommit?: string } | undefined {
  for (const candidate of parseJsonCandidates(text)) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, any>;
    if (typeof obj.state === "string") {
      return {
        state: obj.state.toUpperCase(),
        mergeCommit: typeof obj.mergeCommit?.oid === "string" ? obj.mergeCommit.oid : undefined,
      };
    }
  }
  const match = /\bstate\b["'\s:=]+(MERGED|OPEN|CLOSED)\b/i.exec(text);
  return match ? { state: match[1]!.toUpperCase() } : undefined;
}

function extractPrNumber(text: string): number | undefined {
  const match = /\bgh\s+pr\s+(?:view|merge)\s+(\d+)\b/i.exec(text)
    ?? /\bpull\/(\d+)\b/i.exec(text)
    ?? /\bPR\s*#?(\d+)\b/i.exec(text);
  const pr = Number(match?.[1]);
  return Number.isFinite(pr) ? pr : undefined;
}

function localMergeWorktreeError(text: string): boolean {
  return /already used by worktree|already checked out|worktree/i.test(text);
}

function recheckRemotePrState(ctx: any, pr?: number): { state: string; mergeCommit?: string } | undefined {
  try {
    const args = pr !== undefined
      ? ["pr", "view", String(pr), "--json", "state,mergeCommit"]
      : ["pr", "view", "--json", "state,mergeCommit"];
    const raw = execFileSync("gh", args, {
      cwd: String(ctx?.cwd ?? process.cwd()),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    return parsePrState(String(raw));
  } catch {
    return undefined;
  }
}

function observeWorkflowEvidence(state: SessionState, ctx: any, source: string, toolResults: any[], text = ""): void {
  const sha = safeCurrentGitSha(ctx);
  const timestamp = new Date().toISOString();
  const batchEvaluation = evaluateToolBatch(toolResults);
  const clearValidationResolved = (Boolean(mergedTerminalWorkflowReason(state)) || !batchEvaluation.failed) && !hasUnresolvedMergeSignal(state, toolResults, text);
  for (const tool of toolResults) {
    const command = toolCommand(tool);
    const output = toolEvidenceText(tool);
    const exitCode = toolExitCode(tool);
    if (looksLikeValidationCommand(command, output)) {
      const result = structuredValidationResult(tool);
      if (result) {
        appendEvidence(state, { kind: "validation", sha, command, source, result, timestamp, exitCode, details: squish(output, 300) }, ctx, { clearResolved: clearValidationResolved });
      }
    }

    const mergeText = [command, output, text, state.lastTask].filter(Boolean).join("\n");
    if (/\bgh\s+pr\s+(?:view|merge)\b/i.test(mergeText) || /\bstate\b["'\s:=]+(?:MERGED|OPEN|CLOSED)\b/i.test(mergeText)) {
      const pr = extractPrNumber(mergeText);
      const prState = parsePrState(output || text);
      if (prState) {
        appendEvidence(state, {
          kind: "merge",
          sha,
          command,
          source,
          result: prState.state === "MERGED" ? "merged" : "not_merged",
          timestamp,
          exitCode,
          pr,
          details: prState.mergeCommit ? `mergeCommit=${prState.mergeCommit}` : prState.state,
        }, ctx);
      } else if (/\bgh\s+pr\s+merge\b/i.test(mergeText)) {
        const localResult: EvidenceResult = exitCode === 0 ? "not_merged" : "error";
        appendEvidence(state, { kind: "merge", sha, command, source, result: localResult, timestamp, exitCode, pr, details: squish(output, 300) }, ctx);
        const shouldRecheck = localResult === "not_merged" || localMergeWorktreeError(output);
        if (shouldRecheck) {
          const remote = recheckRemotePrState(ctx, pr);
          if (remote) {
            appendEvidence(state, {
              kind: "merge",
              sha,
              command: pr !== undefined ? `gh pr view ${pr} --json state,mergeCommit` : "gh pr view --json state,mergeCommit",
              source: "remote_pr_recheck",
              result: remote.state === "MERGED" ? "merged" : "not_merged",
              timestamp: new Date().toISOString(),
              pr,
              details: remote.mergeCommit ? `mergeCommit=${remote.mergeCommit}` : remote.state,
            }, ctx);
          }
        }
      }
    }
  }
}

function recordTerminalGreenCloseout(state: SessionState, ctx: any, source: string, reason: string): void {
  if (state.workflow?.terminal?.state === "merged") return;
  state.workflow = {
    ...(state.workflow ?? {}),
    terminal: {
      state: "green",
      sha: safeCurrentGitSha(ctx),
      source,
      timestamp: new Date().toISOString(),
      reason,
    },
  };
}

function mergedTerminalWorkflowReason(state: SessionState): string | null {
  const terminal = state.workflow?.terminal;
  if (terminal?.state !== "merged") return null;
  return `terminal workflow state: PR${terminal.pr ? ` #${terminal.pr}` : ""} merged`;
}

function terminalWorkflowReason(state: SessionState): string | null {
  const terminal = state.workflow?.terminal;
  if (!terminal) return null;
  return terminal.state === "merged"
    ? mergedTerminalWorkflowReason(state)
    : "terminal workflow state: green closeout recorded";
}

type AdvisorRateLimitInfo = { reason: string; retryAfterSeconds?: number };

function activeRateLimitReason(state: SessionState, now = Date.now()): string | null {
  const limit = state.rateLimit;
  if (!limit?.active) return null;
  const until = Date.parse(limit.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return `advisor rate limit active until ${limit.until}`;
}

function clearRateLimitedReviewReplay(state: SessionState, ctx: any, reason: string): void {
  state.followUp = "";
  state.followUpTask = undefined;
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  state.advisorLoop = defaultAdvisorLoopState();
  writeText(advisorCurrentPath(ctx), `${formatAdvisorDisplay("advisor:llm", "defer", reason)}\n`);
}

function recordRateLimit(state: SessionState, ctx: any, info: AdvisorRateLimitInfo): void {
  const now = Date.now();
  const retryAfterSeconds = Math.max(1, info.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_BACKOFF_SECONDS);
  const since = new Date(now).toISOString();
  const until = new Date(now + retryAfterSeconds * 1000).toISOString();
  state.rateLimit = {
    active: true,
    since,
    until,
    reason: info.reason,
    retryAfterSeconds,
  };
  clearRateLimitedReviewReplay(state, ctx, info.reason);
}

function numericHeader(headers: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const value = Number(found);
  return Number.isFinite(value) ? value : undefined;
}

function rateLimitFromValue(value: unknown): AdvisorRateLimitInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, any>;
  const status = Number(obj.status ?? obj.status_code ?? obj.error?.status ?? obj.error?.status_code);
  const code = String(obj.code ?? obj.type ?? obj.error?.code ?? obj.error?.type ?? "").toLowerCase();
  const message = String(obj.message ?? obj.error?.message ?? "").trim();
  const headers = (obj.headers ?? obj.error?.headers) as Record<string, unknown> | undefined;
  const retryAfterSeconds = numericHeader(headers, "Retry-After")
    ?? numericHeader(headers, "X-Codex-Primary-Reset-After-Seconds")
    ?? numericHeader(headers, "x-ratelimit-reset-after");
  const looksRateLimited = status === 429 || /rate[_ -]?limit|usage[_ -]?limit|weekly limit|quota.*(?:exceeded|reached)/i.test(`${code} ${message}`);
  if (!looksRateLimited) return undefined;
  const reasonParts = ["advisor rate limit", status ? `status ${status}` : "", message].filter(Boolean);
  return { reason: reasonParts.join(": "), retryAfterSeconds };
}

function parseAdvisorRateLimit(error: unknown): AdvisorRateLimitInfo | undefined {
  const structured = rateLimitFromValue(error);
  if (structured) return structured;
  const text = error instanceof Error ? error.message : String(error ?? "");
  for (const candidate of parseJsonCandidates(text)) {
    const parsed = rateLimitFromValue(candidate);
    if (parsed) return parsed;
  }
  const textMatch = /(?:status[_\s-]?code["':\s]*|status[=:\s])?429|rate[_ -]?limit|usage[_ -]?limit|weekly limit|quota.*(?:exceeded|reached)/i.test(text);
  if (!textMatch) return undefined;
  const retryMatch = /(?:retry-after|reset[_ -]?after[_ -]?seconds)["':=\s]+(\d+)/i.exec(text);
  return {
    reason: `advisor rate limit: ${squish(text, 160)}${/\b429\b/.test(text) ? "" : " (429)"}`,
    retryAfterSeconds: retryMatch ? Number(retryMatch[1]) : undefined,
  };
}


function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return squish(value
      .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
      .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/([\"']?(?:api[_-]?key|token|secret|password|credential)[\w.-]*[\"']?\s*[:=]\s*[\"']?)([^\s'\",;}]+)/gi, "$1[REDACTED]"), 300);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeDiagnosticValue(item)]));
  }
  return value;
}

function advisorDiagnosticsPath(): string {
  return process.env.PI_ROGUE_ADVISOR_DIAGNOSTICS_PATH || DEFAULT_DIAGNOSTICS_PATH;
}

function appendAdvisorDiagnostic(event: string, details: Record<string, unknown> = {}): void {
  try {
    const safeDetails = sanitizeDiagnosticValue(details) as Record<string, unknown>;
    appendText(advisorDiagnosticsPath(), `${JSON.stringify({ at: new Date().toISOString(), event, ...safeDetails })}\n`);
  } catch {
    // Diagnostics are operational evidence only; they must never break advisor execution.
  }
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
  if (!prev || !next) return false;
  if (prev === next) return true;

  const prevRefs = githubIssueRefs(prev);
  const nextRefs = githubIssueRefs(next);
  const prevRepoRefs = githubIssueRepoRefs(prev);
  const nextRepoRefs = githubIssueRepoRefs(next);

  if (prevRepoRefs.length > 0 && nextRepoRefs.length > 0) {
    if (!nextRepoRefs.some((ref) => prevRepoRefs.includes(ref))) {
      return false;
    }
  }

  if (prevRefs.length > 0 && nextRefs.length > 0) {
    const numberLikeRefs = (refs: string[]) => refs.filter((ref) => /^issue:\d+$/.test(ref));
    const prevNumbers = numberLikeRefs(prevRefs);
    const nextNumbers = numberLikeRefs(nextRefs);
    if (prevNumbers.length > 0 && nextNumbers.length > 0 && prevNumbers.some((ref) => nextNumbers.includes(ref))) {
      return true;
    }
  }

  if (hasConflictingTaskActions(prev, next)) return false;
  return taskSimilarity(prev, next) >= 0.62;
}

const TASK_DIAGNOSTIC_ACTION_WORDS = new Set(["review", "reviews", "reviewed", "diagnose", "diagnoses", "diagnosed", "investigate", "investigates", "investigated", "inspect", "inspects", "inspected", "debug", "debugs", "debugged", "analyze", "analyzes", "analyzed"]);
const TASK_ACTION_WORDS = new Set(["fix", "fixes", "fixed", "repair", "repairs", "repaired", "rotate", "rotates", "rotated", "replace", "replaces", "replaced", "add", "adds", "added", "implement", "implements", "implemented", "update", "updates", "updated", "remove", "removes", "removed", "delete", "deletes", "deleted", "refactor", "refactors", "refactored", ...TASK_DIAGNOSTIC_ACTION_WORDS]);
const TASK_STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "then", "task", "work", "please", "need", "needs", "should", "would", "could", "have", "has", "had", "been", "about", "onto", "your", "here", "fix", "fixes", "fixed", "bug", "bugs", "issue", "issues", "update", "updates", "updated", "updating", "add", "adds", "added", "implement", "implements", "implemented", "implementing"]);

function taskTokens(task: string): Set<string> {
  return new Set(normalizeTask(task).split(" ").filter((token) => token.length > 2 && !TASK_STOPWORDS.has(token)));
}

function taskActionTokens(task: string): Set<string> {
  return new Set(normalizeTask(task).split(" ").filter((token) => TASK_ACTION_WORDS.has(token)));
}

function hasConflictingTaskActions(previousTask: string, nextTask: string): boolean {
  const prevActions = taskActionTokens(previousTask);
  const nextActions = taskActionTokens(nextTask);
  if (!prevActions.size || !nextActions.size) return false;
  const hasDiagnosticAction = (actions: Set<string>) => [...actions].some((action) => TASK_DIAGNOSTIC_ACTION_WORDS.has(action));
  if (hasDiagnosticAction(prevActions) || hasDiagnosticAction(nextActions)) return false;
  for (const action of prevActions) {
    if (nextActions.has(action)) return false;
  }
  return true;
}

function taskSimilarity(previousTask: string, nextTask: string): number {
  const prevTokens = taskTokens(previousTask);
  const nextTokens = taskTokens(nextTask);
  if (prevTokens.size === 0 || nextTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of prevTokens) {
    if (nextTokens.has(token)) overlap += 1;
  }
  const smaller = Math.min(prevTokens.size, nextTokens.size);
  if (smaller >= 2 && overlap === smaller) return 1;
  if (smaller < 3) return 0;
  return overlap / Math.max(prevTokens.size, nextTokens.size);
}

function normalizeTask(task: string): string {
  return sanitizeAdvisorText(task).toLowerCase().replace(/[^a-z0-9#/:.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function githubIssueRefs(task: string): string[] {
  const text = normalizeTask(task);
  const refs = new Set<string>();
  for (const match of text.matchAll(/github\.com\/([^\s/]+\/[^\s/)]+)\/issues\/(\d+)/g)) {
    const repo = match[1].toLowerCase();
    refs.add(`issue:${repo}:${match[2]}`);
    refs.add(`issue:${match[2]}`);
  }
  for (const match of text.matchAll(/(?:^|\s)#(\d+)(?=$|\s|[),.;:])/g)) refs.add(`issue:${match[1]}`);
  for (const match of text.matchAll(/(?:^|\s)(?:issue|ticket)\s+(\d+)(?=$|\s|[),.;:])/g)) refs.add(`issue:${match[1]}`);
  return [...refs];
}

function githubIssueRepoRefs(task: string): string[] {
  const text = normalizeTask(task);
  const repos = new Set<string>();
  for (const match of text.matchAll(/github\.com\/([^\s/]+\/[^\s/)]+)\/issues\/(\d+)/g)) {
    repos.add(`issue:${match[1].toLowerCase()}:${match[2]}`);
  }
  return [...repos];
}

function looksLikeExplicitTaskSwitch(previousTask: string, nextTask: string): boolean {
  const prev = normalizeTask(previousTask);
  const next = normalizeTask(nextTask);
  if (!prev || !next) return false;
  if (/\b(?:previous|prior|last|compare|carry over|same ticket|same issue)\b/.test(next)) return false;

  const prevRefs = githubIssueRefs(prev);
  const nextRefs = githubIssueRefs(next);
  const prevRepoRefs = githubIssueRepoRefs(prev);
  const nextRepoRefs = githubIssueRepoRefs(next);

  if (nextRepoRefs.length > 0 && prevRepoRefs.length > 0) {
    if (!nextRepoRefs.every((ref) => prevRepoRefs.includes(ref))) {
      return true;
    }
  }

  if (nextRefs.length > 0) {
    if (prevRefs.length === 0) return true;
    const numberLikeRefs = (refs: string[]) => refs.filter((ref) => /^issue:\d+$/.test(ref));
    const prevNumbers = numberLikeRefs(prevRefs);
    const nextNumbers = numberLikeRefs(nextRefs);
    const sharedNumber = nextNumbers.some((ref) => prevNumbers.includes(ref));
    if (sharedNumber) return false;
    return nextRefs.some((ref) => !prevRefs.includes(ref));
  }

  if (isTaskContinuation(prev, next)) return false;

  return /\b(?:next|new|another)\s+(?:ticket|issue|task)\b/.test(next);
}

function resetTaskScopedStateForSwitch(state: SessionState): void {
  state.notes = [];
  state.files = [];
  state.errors = [];
  state.followUp = "";
  state.followUpTask = undefined;
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  state.evidenceLedger = [];
  state.workflow = {};
  state.reviewControl = {
    ...state.reviewControl,
    status: "consumed",
    pending: false,
    consumed: true,
    running: false,
    lastDecision: "defer",
    lastReason: "task switched",
    lastAppliedAt: new Date().toISOString(),
  };
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
  appendAdvisorDiagnostic("review_repeated_snapshot_skipped", { signature, trigger, task: state.lastTask });
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
  persisted.advisorLoop = state.advisorLoop;
  persisted.followUp = state.followUp;
  persisted.followUpTask = state.followUpTask;
  persisted.reviewSignals = state.reviewSignals;
  persisted.reviewSignalsTask = state.reviewSignalsTask;
  persisted.advisorPauseUntilTurn = state.advisorPauseUntilTurn;
  persisted.evidenceLedger = state.evidenceLedger;
  persisted.workflow = state.workflow;
  persisted.rateLimit = state.rateLimit;
  if (includeReviewRoute && state.router.review) {
    persisted.router.review = state.router.review;
  }
  saveState(persisted);
}

const CLEAN_CLOSEOUT_RE = /\b(?:revalidated clean|validated clean|final (?:codex )?review (?:had no findings|clean|passed)|codex review (?:had no findings|clean)|no findings)\b/i;
const UNRESOLVED_CLOSEOUT_RE = /\b(?:pending|still needs?|still needed|still required|incomplete|not done|todo|needs (?:changes|work|fix(?:es)?|review|attention)|(?:still|currently) failing|(?:still|currently) failed)\b/i;
const STRUCTURED_GREEN_TEST_RE = /(?:\bTests\s+\d+\s+passed\s+\(\d+\)|\bTest Files\s+\d+\s+passed\s+\(\d+\)|\bnumFailedTests\s*[:=]\s*0\b|"numFailedTests"\s*:\s*0|\bsuccess\s*[:=]\s*true\b|"success"\s*:\s*true|\b(?:PIPE_)?EXIT\s*:\s*0\b)/i;
const STRUCTURED_FAILING_TEST_RE = /(?:\bTests?\s+.*?\bfailed\s+\([1-9]\d*\)|\bTest Files\s+.*?\bfailed\s+\([1-9]\d*\)|\bnumFailedTests\s*[:=]\s*[1-9]\d*\b|"numFailedTests"\s*:\s*[1-9]\d*|\b(?:PIPE_)?EXIT\s*:\s*[1-9]\d*\b)/i;
const HUMAN_TEST_SUMMARY_RE = /(?:\bTests?\s+\d+\s+(?:passed|failed)\s+\(\d+\)|\bTest Files\s+\d+\s+(?:passed|failed)\s+\(\d+\))/i;
const TERMINAL_MERGED_RE = /(?:\bPR\s+#?\d+\s+state=MERGED\b|\bstate=MERGED\b|\bmerged\s*[:=]\s*true\b|"merged"\s*:\s*true|\bPull Request successfully merged\b)/i;

type TerminalReviewEvidence = {
  kind: "tests" | "merge" | "tests_and_merge";
  task: string;
  reason: string;
  at: string;
};

function normalizeTerminalEvidence(value: unknown): TerminalReviewEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TerminalReviewEvidence>;
  if (candidate.kind !== "tests" && candidate.kind !== "merge" && candidate.kind !== "tests_and_merge") return undefined;
  return {
    kind: candidate.kind,
    task: sanitizeAdvisorText(candidate.task ?? "").slice(0, 240),
    reason: sanitizeAdvisorText(candidate.reason ?? "terminal clean closeout evidence").slice(0, 160),
    at: sanitizeAdvisorText(candidate.at ?? new Date().toISOString()).slice(0, 64),
  };
}

function closeoutEvidenceText(delta: string, meta: ReviewMaterialMeta): string {
  return [delta, ...(meta.materialSignals ?? [])].filter(Boolean).join("\n");
}

function terminalEvidenceKind(delta: string, meta: ReviewMaterialMeta): TerminalReviewEvidence["kind"] | undefined {
  const evidence = closeoutEvidenceText(delta, meta);
  if (STRUCTURED_FAILING_TEST_RE.test(evidence)) return undefined;
  const tests = STRUCTURED_GREEN_TEST_RE.test(evidence);
  const merge = TERMINAL_MERGED_RE.test(evidence);
  if (tests && merge) return "tests_and_merge";
  if (merge) return "merge";
  if (tests) return "tests";
  return undefined;
}

function hasStructuredCleanCloseoutEvidence(delta: string, meta: ReviewMaterialMeta): boolean {
  return Boolean(terminalEvidenceKind(delta, meta));
}

function recordTerminalEvidence(state: SessionState, delta: string, meta: ReviewMaterialMeta, reason: string): void {
  const kind = terminalEvidenceKind(delta, meta);
  if (!kind) return;
  state.reviewControl.terminalEvidence = {
    kind,
    task: sanitizeAdvisorText(state.lastTask).slice(0, 240),
    reason,
    at: new Date().toISOString(),
  };
}

function hasActiveTerminalEvidence(state: SessionState): boolean {
  const evidence = normalizeTerminalEvidence(state.reviewControl.terminalEvidence);
  if (!evidence) return false;
  if (!evidence.task || !state.lastTask) return true;
  return isTaskContinuation(evidence.task, state.lastTask);
}

function hasCleanCloseoutEvidence(delta: string, meta: ReviewMaterialMeta): boolean {
  if (!meta.isAgentEnd || meta.failed) return false;
  if (hasStructuredCleanCloseoutEvidence(delta, meta)) return true;
  return Boolean(CLEAN_CLOSEOUT_RE.test(delta) && !UNRESOLVED_CLOSEOUT_RE.test(delta));
}

function clearResolvedReviewWarning(state: SessionState, ctx: any, reason: string): void {
  appendAdvisorDiagnostic("review_closeout_cleared", { reason, task: state.lastTask });
  state.followUp = "";
  state.followUpTask = undefined;
  state.reviewSignals = [];
  state.reviewSignalsTask = undefined;
  state.advisorLoop = defaultAdvisorLoopState();
  if (state.router.review) {
    state.router.review = {
      ...state.router.review,
      label: "on_track",
      reason,
      review: "off",
      escalate: false,
      trajectory: state.router.review.trajectory
        ? { ...state.router.review.trajectory, failed: false }
        : state.router.review.trajectory,
    };
  }
  writeText(advisorCurrentPath(ctx), `${formatAdvisorDisplay("advisor:llm", "continue", reason)}\n`);
}

function recoverReviewControl(state: SessionState): void {
  if (!state.reviewControl.running) return;

  const pending = Boolean(state.reviewControl.pending);
  appendAdvisorDiagnostic("review_running_recovered", { pending, task: state.lastTask, lastTrigger: state.reviewControl.lastTrigger });
  state.reviewControl = {
    ...state.reviewControl,
    running: false,
    status: pending ? "needed" : state.reviewControl.status === "needed" ? "needed" : "idle",
    consumed: !pending,
    lastMaterialSignature: undefined,
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
  terminalEvidence?: TerminalReviewEvidence;
};

type AdvisorLoopEntry = {
  outputHash: string;
  outputText: string;
  contextHash: string;
  familyHash: string;
  source: string;
  repeatCount: number;
  at: string;
};

type AdvisorLoopState = {
  repeatCount: number;
  recent: AdvisorLoopEntry[];
  lastOutputHash?: string;
  lastOutputText?: string;
  lastContextHash?: string;
  lastSource?: string;
  lastObservedAt?: string;
};

function defaultAdvisorLoopState(): AdvisorLoopState {
  return { repeatCount: 0, recent: [] };
}

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
  if (!signalTask || !task || !isTaskContinuation(signalTask, task)) {
    appendAdvisorDiagnostic("stale_review_signals_dropped", { signalTask, task, count: state.reviewSignals.length });
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
  if (!state.followUpTask || !task) {
    appendAdvisorDiagnostic("stale_followup_dropped", { followUpTask: state.followUpTask ?? "", task, reason: "missing_task_scope" });
    state.followUp = "";
    state.followUpTask = undefined;
    return "";
  }
  if (!isTaskContinuation(state.followUpTask, task)) {
    appendAdvisorDiagnostic("stale_followup_dropped", { followUpTask: state.followUpTask, task, reason: "task_changed" });
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

const ADVISOR_LOOP_REPEAT_LIMIT = 3;

function comparableAdvisorLoopText(text: string): string {
  return sanitizeAdvisorText(text)
    .toLowerCase()
    .replace(/\b(?:advisor verdict|reason|summary|actions|status|nudge|full handoff|loop detected)\b[:.-]*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function advisorLoopSimilarity(left: string, right: string): number {
  const tokens = (text: string) => new Set(comparableAdvisorLoopText(text).split(" ").filter((token) => token.length > 2));
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function isRepeatedAdvisorOutput(previous: string, current: string): boolean {
  const a = comparableAdvisorLoopText(previous);
  const b = comparableAdvisorLoopText(current);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 60 && (a.includes(b) || b.includes(a))) return true;
  return advisorLoopSimilarity(a, b) >= 0.85;
}

function advisorLoopContextHash(parts: string[]): string {
  return hash("advisor-loop-context", ...parts.map((part) => squish(part, 400)));
}

function advisorLoopWarning(source: string, repeatCount: number): string {
  return `Advisor loop detected: ${source} repeated near-identical guidance across changing context ${repeatCount} times. Re-anchor to the latest brief before repeating it.`;
}

function advisorLoopFamilyHash(parts: string[]): string {
  return hash("advisor-loop-family", ...parts.map((part) => squish(part, 300)));
}

function observeAdvisorLoop(state: SessionState, source: string, familyHash: string, contextHash: string, outputText: string): { text: string; loopDetected: boolean; repeatCount: number } {
  const normalized = comparableAdvisorLoopText(outputText);
  if (!normalized) return { text: outputText, loopDetected: false, repeatCount: 0 };

  const outputHash = hash("advisor-loop-output", normalized);
  const previous = state.advisorLoop ?? defaultAdvisorLoopState();
  const recent = previous.recent ?? [];
  const matches = recent.filter((entry) => entry.source === source
    && entry.familyHash === familyHash
    && entry.contextHash !== contextHash
    && (entry.outputHash === outputHash || isRepeatedAdvisorOutput(entry.outputText, outputText)));
  const repeatCount = matches.length ? Math.max(...matches.map((entry) => entry.repeatCount || 1)) + 1 : 1;
  const loopDetected = repeatCount >= ADVISOR_LOOP_REPEAT_LIMIT;
  const now = new Date().toISOString();
  const outputSnapshot = sanitizeAdvisorText(outputText).trim().slice(0, 1200);

  state.advisorLoop = {
    repeatCount,
    recent: [...recent, { outputHash, outputText: outputSnapshot, contextHash, familyHash, source, repeatCount, at: now }].slice(-8),
    lastOutputHash: outputHash,
    lastOutputText: outputSnapshot,
    lastContextHash: contextHash,
    lastSource: source,
    lastObservedAt: now,
  };

  if (loopDetected) {
    appendAdvisorDiagnostic("advisor_loop_detected", { source, repeatCount, contextHash, familyHash, output: outputSnapshot });
  }

  return {
    text: loopDetected ? advisorLoopWarning(source, repeatCount) : outputText,
    loopDetected,
    repeatCount,
  };
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

function sendAdvisorHint(pi: ExtensionAPI, state: SessionState, familyHash: string, contextHash: string, decision: "continue" | "review" | "defer", reason: string, summary: string, actions: unknown = []): { text: string; loopDetected: boolean; repeatCount: number } {
  const cleanReason = sanitizeAdvisorText(reason);
  const cleanSummary = distinctAdvisorSummary(cleanReason, summary);
  const limitedActions = normalizeAdvisorActions(actions);
  const advisorText = advisorHandoffText(decision, cleanReason, cleanSummary, limitedActions);
  const loop = observeAdvisorLoop(state, "handoff", familyHash, contextHash, advisorText);
  pi.sendMessage(
    {
      customType: "advisor:llm",
      content: loop.text,
      display: true,
      details: { kind: "handoff", decision, reason: cleanReason, summary: cleanSummary, actions: limitedActions, loopDetected: loop.loopDetected, loopRepeatCount: loop.repeatCount },
    },
    { deliverAs: "followUp" },
  );
  return loop;
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
  return toolOverallFailed(tool);
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
  return isAdvisorPaused(state, nowTurns) || Boolean(activeRateLimitReason(state));
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
  if (activeRateLimitReason(state)) {
    setPiRogueStatus(ctx, config, state);
    return false;
  }
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
      { maxTokens: 260, reasoning: "low" as ThinkingLevel, maxAttempts: 2 },
    );
    if (!completed) return false;
    if (completed.rateLimited) {
      const next = loadState(ctx);
      recordRateLimit(next, ctx, { reason: completed.text || "advisor rate limit (429)", retryAfterSeconds: completed.retryAfterSeconds });
      saveState(next);
      setPiRogueStatus(ctx, config, next);
      return false;
    }

    const next = loadState(ctx);
    next.checkin = {
      lastAt: new Date().toISOString(),
      lastTurn: next.turns,
      lastReason: reason,
      queued: false,
    };
    const loopFamilyHash = advisorLoopFamilyHash(["checkin", source, state.lastTask || ""]);
    const loopContextHash = advisorLoopContextHash(["checkin", source, prompt, orchestrationSnapshotText(ctx), brief(next)]);
    sendAdvisorHint(pi, next, loopFamilyHash, loopContextHash, "review", "mid-hour check-in", completed.text, [completed.text]);
    saveState(next);
    setPiRogueStatus(ctx, config, next);
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
      `profile=${normalized.profile ?? "off"}`,
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

function firstPreferred(available: string[], preferred: string[]): string | undefined {
  return preferred.find((id) => available.includes(id));
}

function modelRegistryHas(ctx: any, id: string): boolean {
  const [provider, ...rest] = id.split("/");
  if (!provider || rest.length === 0) return false;
  return Boolean(ctx?.modelRegistry?.find?.(provider, rest.join("/")));
}

function firstPreferredDetected(ctx: any, available: string[], preferred: string[]): string | undefined {
  return preferred.find((id) => available.includes(id) || modelRegistryHas(ctx, id));
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

export interface AdvisorBoardProfilePlan {
  id: AdvisorProfileId;
  active: boolean;
  driverModel: string;
  advisorModel: string;
  headOfBoardModel: string;
  specialistModel: string;
  mutatesGlobalDriver: false;
  advisorConfig: AdvisorConfig;
  files: { advisor: string };
  warnings: string[];
}

export function buildAdvisorBoardProfilePlan(ctx: any, current: AdvisorConfig = normalizeAdvisorConfig({})): AdvisorBoardProfilePlan {
  const normalized = normalizeAdvisorConfig(current);
  const available = availableTextModels(ctx);
  const preferredAdvisor = SOTA_CHAIN.map((item) => `${item.provider}/${item.model}`);
  const configuredPreferredAdvisor = normalized.model && preferredAdvisor.includes(normalized.model) && (available.includes(normalized.model) || modelRegistryHas(ctx, normalized.model)) ? normalized.model : undefined;
  const advisorModel = configuredPreferredAdvisor ?? firstPreferredDetected(ctx, available, preferredAdvisor) ?? "<no preferred strong advisor model detected>";
  const driverModel = firstPreferredDetected(ctx, available, CHEAP_DRIVER_CHAIN) ?? "<no preferred cheap driver model detected>";
  const restore: AdvisorProfileRestore = normalized.profileRestore ?? {
    mode: normalized.mode,
    review: normalized.review,
    checkins: normalized.checkins,
    checkinIntervalMinutes: normalized.checkinIntervalMinutes,
    model: normalized.model,
    profileModel: advisorModel.startsWith("<") ? normalized.model : advisorModel,
    board: normalized.board,
    headOfBoard: normalized.headOfBoard,
    specialistDispatch: normalized.specialistDispatch,
  };
  const advisorConfig = normalizeAdvisorConfig({
    ...normalized,
    profile: BUDGET_BOARD_PROFILE_ID,
    profileRestore: restore,
    mode: "manual",
    review: "off",
    checkins: "off",
    model: advisorModel.startsWith("<") ? normalized.model : advisorModel,
    board: { mode: "shadow" },
    headOfBoard: profileHeadOfBoardConfig(),
    specialistDispatch: profileSpecialistDispatchConfig(),
  });
  return {
    id: BUDGET_BOARD_PROFILE_ID,
    active: normalized.profile === BUDGET_BOARD_PROFILE_ID,
    driverModel,
    advisorModel,
    headOfBoardModel: advisorModel,
    specialistModel: advisorModel,
    mutatesGlobalDriver: false,
    advisorConfig,
    files: { advisor: CONFIG_PATH },
    warnings: [
      available.length === 0 ? "No text models were detected; configure Pi model providers before enabling this profile." : "",
      driverModel.startsWith("<") ? "No preferred cheap driver candidate was detected; status is advisory and will not mutate the global main model." : "",
      advisorModel.startsWith("<") ? "No preferred strong advisor/head model was detected; profile enable will fail instead of falling back silently." : "",
    ].filter(Boolean),
  };
}

export function applyAdvisorBoardProfilePlan(plan: AdvisorBoardProfilePlan): AdvisorConfig {
  if (plan.advisorModel.startsWith("<")) throw new Error("cannot enable budget-board profile without a detected strong advisor model");
  writeJson(plan.files.advisor, plan.advisorConfig);
  return plan.advisorConfig;
}

function profileHeadOfBoardConfig(): HeadOfBoardConfig {
  return { ...defaultHeadOfBoardConfig(), mode: "enabled" };
}

function profileSpecialistDispatchConfig(): SpecialistDispatchConfig {
  return { ...defaultSpecialistDispatchConfig(), mode: "suggest", maxCostTier: "cheap", maxCallsPerSession: 3 };
}

export function budgetBoardEscalationPolicyText(config: AdvisorConfig): string {
  const cfg = normalizeAdvisorConfig(config);
  const active = cfg.profile === BUDGET_BOARD_PROFILE_ID;
  return [
    "Budget-board escalation policy:",
    `  profile: ${active ? "active" : "inactive"}`,
    `  strong-model loop: ${cfg.mode === "manual" && cfg.review === "off" ? "off (manual slash/tool calls only)" : `advisor mode=${cfg.mode}, review=${cfg.review}`}`,
    `  Head-of-Board: ${cfg.headOfBoard.mode}; triggers=user_request or material Board risk; maxTokens=${cfg.headOfBoard.maxTokens}; reasoning=${cfg.headOfBoard.reasoning}`,
    `  Specialists: ${cfg.specialistDispatch.mode}; read-only; cooldown=${cfg.specialistDispatch.cooldownTurns} turns; maxCalls=${cfg.specialistDispatch.maxCallsPerSession}; maxCost=${cfg.specialistDispatch.maxCostTier}; maxTokens=${cfg.specialistDispatch.maxTokens}`,
    "  Denials/skips are explicit: disabled, not_material, rate_limited, cooldown, budget, cost_tier, or tool_escalation.",
  ].join("\n");
}

export function disableAdvisorBoardProfile(current: AdvisorConfig): AdvisorConfig {
  const normalized = normalizeAdvisorConfig(current);
  if (normalized.profile !== BUDGET_BOARD_PROFILE_ID) return normalized;
  const restore = normalized.profileRestore ?? {
    mode: DEFAULT_CONFIG.mode,
    review: DEFAULT_CONFIG.review,
    checkins: DEFAULT_CONFIG.checkins,
    checkinIntervalMinutes: DEFAULT_CONFIG.checkinIntervalMinutes,
    model: normalized.model,
    profileModel: normalized.model,
    board: defaultBoardShadowConfig(),
    headOfBoard: defaultHeadOfBoardConfig(),
    specialistDispatch: defaultSpecialistDispatchConfig(),
  };
  const profileBoard: BoardShadowConfig = { mode: "shadow" };
  const profileHead = profileHeadOfBoardConfig();
  const profileSpecialists = profileSpecialistDispatchConfig();
  const currentModelIsProfileOwned = restore.profileModel !== undefined && normalized.model === restore.profileModel;
  return normalizeAdvisorConfig({
    ...normalized,
    profile: undefined,
    profileRestore: undefined,
    mode: normalized.mode !== "manual" ? normalized.mode : restore.mode,
    review: normalized.review !== "off" ? normalized.review : restore.review,
    checkins: normalized.checkins !== "off" ? normalized.checkins : restore.checkins,
    checkinIntervalMinutes: normalized.checkinIntervalMinutes,
    model: currentModelIsProfileOwned ? restore.model : normalized.model,
    board: JSON.stringify(normalized.board) !== JSON.stringify(profileBoard) ? normalized.board : restore.board,
    headOfBoard: JSON.stringify(normalized.headOfBoard) !== JSON.stringify(profileHead) ? normalized.headOfBoard : restore.headOfBoard,
    specialistDispatch: JSON.stringify(normalized.specialistDispatch) !== JSON.stringify(profileSpecialists) ? normalized.specialistDispatch : restore.specialistDispatch,
  });
}

function advisorBoardProfileText(plan: AdvisorBoardProfilePlan): string {
  return [
    "Pi-Rogue advisor profile: budget-board",
    `Status: ${plan.active ? "active" : "available (explicit opt-in required)"}`,
    "",
    "Role → model mapping:",
    `  driver/main: ${plan.driverModel} (recommended only; global main model is not mutated)`,
    `  advisor/head-of-board: ${plan.headOfBoardModel}`,
    `  read-only specialists: ${plan.specialistModel}`,
    "",
    "Board modes if enabled:",
    `  advisor.mode: ${plan.advisorConfig.mode} (manual slash/tool calls only)`,
    `  advisor.review: ${plan.advisorConfig.review} (no always-on expensive review loop)`,
    `  board.shadow: ${plan.advisorConfig.board.mode}`,
    `  headOfBoard: ${plan.advisorConfig.headOfBoard.mode}`,
    `  specialists: ${plan.advisorConfig.specialistDispatch.mode} (read-only, maxCost=${plan.advisorConfig.specialistDispatch.maxCostTier}, maxCalls=${plan.advisorConfig.specialistDispatch.maxCallsPerSession})`,
    "",
    budgetBoardEscalationPolicyText(plan.advisorConfig),
    "",
    `Writes on enable: ${plan.files.advisor}`,
    "Safety: explicit, reversible, no global driver/default model mutation, specialists remain read-only and suggest/explicit-call gated.",
    plan.warnings.length ? "" : undefined,
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Commands: /pi-rogue-advisor profile budget-board · /pi-rogue-advisor profile off",
  ].filter(Boolean).join("\n");
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
type ModelResolutionOptions = { allowRegularFallback?: boolean; maxAttempts?: number };
type AdvisorCompletionResult = { text: string; model: string; fallback?: boolean; rateLimited?: boolean; retryAfterSeconds?: number };

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

export async function completeWithModelFallback(ctx: any, config: AdvisorConfig, systemPrompt: string, messages: any[], options: { maxTokens: number; reasoning: ThinkingLevel; maxAttempts?: number }): Promise<AdvisorCompletionResult | null> {
  let lastError = "";
  let lastRateLimit: AdvisorRateLimitInfo | undefined;
  let attempts = 0;
  for (const resolved of await resolveModelCandidates(ctx, config)) {
    if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) break;
    attempts += 1;
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
      lastRateLimit = parseAdvisorRateLimit(error) ?? lastRateLimit;
    }
  }
  if (lastRateLimit) {
    return { text: lastRateLimit.reason, model: "none", rateLimited: true, retryAfterSeconds: lastRateLimit.retryAfterSeconds };
  }
  return lastError ? { text: `No advisor/check-in model completed successfully (${lastError}).`, model: "none" } : null;
}

export async function completeWithHigherAdvisorModel(
  ctx: any,
  config: AdvisorConfig,
  systemPrompt: string,
  messages: any[],
  options: { maxTokens: number; reasoning: ThinkingLevel; allowRegularFallback?: boolean; maxAttempts?: number },
): Promise<AdvisorCompletionResult | null> {
  const { allowRegularFallback = true, maxAttempts } = options;
  let attempts = 0;
  let lastRateLimit: AdvisorRateLimitInfo | undefined;
  for (const resolved of await resolveModelCandidates(ctx, config, { allowRegularFallback })) {
    if (maxAttempts !== undefined && attempts >= maxAttempts) break;
    attempts += 1;
    try {
      const resp = await completeSimple(resolved.model, { systemPrompt, messages }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: options.maxTokens,
        reasoning: options.reasoning,
      });
      return { text: responseText(resp) || "(empty)", model: resolved.label };
    } catch (error) {
      lastRateLimit = parseAdvisorRateLimit(error) ?? lastRateLimit;
    }
  }
  return lastRateLimit ? { text: lastRateLimit.reason, model: "none", rateLimited: true, retryAfterSeconds: lastRateLimit.retryAfterSeconds } : null;
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
  if (completed.rateLimited) {
    recordRateLimit(state, ctx, { reason: completed.text || "advisor rate limit (429)", retryAfterSeconds: completed.retryAfterSeconds });
    saveState(state);
    return { text: state.rateLimit?.reason || "Advisor rate limit active.", model: completed.model, error: "rate_limit" };
  }
  const text = completed.text;
  const loopFamilyHash = advisorLoopFamilyHash(["question", question, scope, state.lastTask || ""]);
  const loopContextHash = advisorLoopContextHash(["question", config.model ?? "auto", question, scope, includeWork ? brief(state) : "", brokerBrief]);
  const loop = observeAdvisorLoop(state, "question", loopFamilyHash, loopContextHash, text);
  if (!loop.loopDetected && text && text !== "(empty)") { cache[ck] = text; saveCache(cache); }
  state.advisorCalls++;
  saveState(state);
  return { text: loop.text, model: completed.model, fallback: completed.fallback, loopDetected: loop.loopDetected };
}

async function doReview(pi: ExtensionAPI, ctx: any, trigger: string, delta: string, meta: ReviewMaterialMeta) {
  const config = loadConfig();
  if (config.review === "off") return;
  const state = loadState(ctx);
  const reviewLockKey = statePathFor(state);
  if (reviewLocks.has(reviewLockKey)) return;
  reviewLocks.add(reviewLockKey);

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
  const signature = reviewMaterialSignature(state, delta, meta);
  if (state.reviewControl.running) {
    reviewLocks.delete(reviewLockKey);
    return;
  }
  const terminalReason = mergedTerminalWorkflowReason(state);
  if (terminalReason) {
    clearResolvedReviewWarning(state, ctx, terminalReason);
    markReviewApplied(state, signature, trigger, "continue", terminalReason, true);
    persistReviewState(state, true);
    reviewLocks.delete(reviewLockKey);
    return;
  }
  const rateLimitReason = activeRateLimitReason(state);
  if (rateLimitReason) {
    clearRateLimitedReviewReplay(state, ctx, rateLimitReason);
    markReviewApplied(state, signature, trigger, "defer", rateLimitReason, true);
    persistReviewState(state, true);
    reviewLocks.delete(reviewLockKey);
    return;
  }
  if (shouldSkipReview(state, signature) && !reviewHeuristic.safety && !meta.failed) {
    markReviewSkipped(state, signature, trigger);
    persistReviewState(state, false);
    reviewLocks.delete(reviewLockKey);
    return;
  }

  markReviewRunning(state, signature, trigger);
  persistReviewState(state, false);

  let finalized = false;
  let finalDecision: "continue" | "review" | "defer" = "defer";
  let finalReason = "pending review";

  try {
    if (hasCleanCloseoutEvidence(delta, meta) || (meta.isAgentEnd && !meta.failed && hasActiveTerminalEvidence(state))) {
      finalDecision = "continue";
      finalReason = hasActiveTerminalEvidence(state) ? "terminal workflow state" : "terminal clean closeout evidence";
      recordTerminalEvidence(state, delta, meta, finalReason);
      if (hasCleanCloseoutEvidence(delta, meta)) {
        recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
      }
      clearResolvedReviewWarning(state, ctx, finalReason);
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    const gatePrediction = binaryGatePredict(reviewInput.text, phase, trajectory);
    let reviewRoute = reviewHeuristic;
    if (gatePrediction && gatePrediction.trusted && !reviewHeuristic.safety && !meta.failed) {
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

    if (gatePrediction && gatePrediction.trusted && gatePrediction.decision === "continue" && !reviewHeuristic.safety && !meta.failed) {
      finalDecision = "continue";
      finalReason = "local gate continue";
      if (hasCleanCloseoutEvidence(delta, meta)) {
        recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
        clearResolvedReviewWarning(state, ctx, finalReason);
      }
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
      if (hasCleanCloseoutEvidence(delta, meta)) {
        recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
        clearResolvedReviewWarning(state, ctx, finalReason);
      }
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
      if (hasCleanCloseoutEvidence(delta, meta)) {
        finalDecision = "continue";
        finalReason = "clean closeout evidence";
        recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
        clearResolvedReviewWarning(state, ctx, finalReason);
      } else {
        finalDecision = "defer";
        finalReason = "no material signal";
      }
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

    const cwd = String(ctx?.cwd ?? process.cwd());
    const missingArtifacts = [...new Set([
      ...findMissingArtifactReferences(cwd, delta, b, brokerBrief),
      ...findMissingReviewArtifacts(cwd, delta, b, brokerBrief),
    ])];
    if (missingArtifacts.length > 0) {
      const missingSummary = missingArtifacts.slice(0, 4).join(", ");
      finalDecision = "defer";
      finalReason = `artifact preflight missing references: ${missingSummary}`;
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      ctx.ui?.notify?.(`Advisor artifact preflight blocked model review: missing referenced files ${missingSummary}`, "warning");
      finalized = true;
      return;
    }

    const rk = hash("rev", trigger, b, brokerBrief, delta, String(meta.fileChanged), String(meta.failed), String(meta.isAgentEnd), String(reviewRoute.label), signature);
    const bypassReviewCache = Boolean(meta.failed || reviewHeuristic.safety);
    const cache = loadCache();
    if (!bypassReviewCache && cache[rk]) {
      const cachedParsed = parseReviewPayload(cache[rk], state.lastTask);
      if (cachedParsed?.verdict === "on_track") {
        finalDecision = "continue";
        finalReason = (cachedParsed.reason || cachedParsed.summary || "cached on-track verdict").slice(0, 120);
        if (hasCleanCloseoutEvidence(delta, meta)) {
          recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
        }
        clearResolvedReviewWarning(state, ctx, finalReason);
      } else {
        finalDecision = "defer";
        finalReason = "cached verdict";
      }
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
    const completed = await completeWithModelFallback(ctx, config, REVIEW_SYSTEM, msgs, { maxTokens: 400, reasoning: "low" as ThinkingLevel, maxAttempts: 2 });
    if (completed?.rateLimited) {
      recordRateLimit(state, ctx, { reason: completed.text || "advisor rate limit (429)", retryAfterSeconds: completed.retryAfterSeconds });
      finalDecision = "defer";
      finalReason = state.rateLimit?.reason || "advisor rate limit";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }
    const raw = completed?.text;
    if (!raw) {
      finalDecision = "defer";
      finalReason = "empty verdict";
      markReviewApplied(state, signature, trigger, finalDecision, finalReason, true);
      persistReviewState(state, true);
      finalized = true;
      return;
    }

    if (!bypassReviewCache) {
      cache[rk] = raw;
      saveCache(cache);
    }

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
      if (hasCleanCloseoutEvidence(delta, meta)) {
        recordTerminalGreenCloseout(state, ctx, trigger, finalReason);
      }
      clearResolvedReviewWarning(state, ctx, finalReason);
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
    const reviewFamilyHash = advisorLoopFamilyHash(["review", reviewTask, String(meta.isAgentEnd)]);
    const reviewContextHash = advisorLoopContextHash(["review", trigger, reviewRoute.promptHash ?? "", reviewTask, b, brokerBrief, delta, String(meta.fileChanged), String(meta.failed), String(meta.isAgentEnd)]);
    const hasTaskActions = parsed.taskActions.length > 0;
    if (hasTaskActions) {
      const intendedFollowUp = [sanitizeAdvisorText(parsed.summary), ...parsed.taskActions].filter(Boolean).join(" — ");
      const hint = sendAdvisorHint(pi, state, reviewFamilyHash, reviewContextHash, decision, finalReason, parsed.summary || "", parsed.taskActions);
      state.followUp = hint.loopDetected ? hint.text : intendedFollowUp;
      state.followUpTask = reviewTask;
    } else {
      state.followUp = "";
      state.followUpTask = undefined;
    }

    const advisoryText = buildAdvisorySignalsBlock(reviewTask, parsed.advisorySignals, parsed.pivot);
    if (advisoryText) {
      const advisoryLoop = observeAdvisorLoop(state, "review-signals", reviewFamilyHash, reviewContextHash, advisoryText);
      state.reviewSignals = [advisoryLoop.text];
      state.reviewSignalsTask = reviewTask;
      sendAdvisorAnswer(pi, advisoryLoop.text);
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
    reviewLocks.delete(reviewLockKey);
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
    const rateLimitReason = activeRateLimitReason(state);
    if (rateLimitReason) {
      clearRateLimitedReviewReplay(state, ctx, rateLimitReason);
      saveState(state);
      setPiRogueStatus(ctx, cfg, state);
      return { systemPrompt: event.systemPrompt };
    }
    const hasFollowUp = Boolean(state.followUp);
    if ((isAdvisorAutoRunSuppressed(state, state.turns) && !hasFollowUp) || cfg.mode === "off" || cfg.mode === "manual") {
      return { systemPrompt: event.systemPrompt };
    }
    setPiRogueStatus(ctx, cfg, state);
    const prompt = typeof event.prompt === "string" && event.prompt.trim() ? squish(event.prompt, 1000) : "";
    if (prompt) {
      if (looksLikeExplicitTaskSwitch(state.lastTask, prompt)) resetTaskScopedStateForSwitch(state);
      state.lastTask = prompt;
    }
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
    const toolResults = event.toolResults || [];
    const tools = toolResults.map((t: any) => String(t?.toolName || t?.name || "tool"));
    const fileChanged = tools.some((t: string) => /^(edit|write)$/i.test(t));
    const text = squish(contentText(event.message?.content));
    observeWorkflowEvidence(state, ctx, "turn_end", toolResults, text);
    const failed = effectiveFailureFromTools(state, toolResults);
    if (text && text !== state.notes[state.notes.length - 1]) state.notes.push(text);
    state.turns++;
    if (state.advisorPauseUntilTurn && isAdvisorPaused(state, state.turns) === false) {
      state.advisorPauseUntilTurn = undefined;
    }
    recordBoardShadowIfEnabled(ctx, cfg, state, "turn_end", toolResults);
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
    const msgs = (event.messages || []).filter((m: any) => m.role === "assistant" || m.role === "toolResult");
    const last = msgs[msgs.length - 1];
    const delta = contentText(last?.content) || "(none)";
    const fileChanged = msgs.some((m: any) => /(?:write|edit)/i.test(JSON.stringify(m)));
    observeWorkflowEvidence(state, ctx, "agent_end", msgs, delta);
    const failed = effectiveFailureFromTools(state, msgs);
    const signals = msgs.map((m: any) => {
      const sig = contentText(m?.content);
      return `${m?.role || "msg"}: ${sig ? squish(sig, 120) : "(empty)"}`;
    });
    const suppressed = isAdvisorAutoRunSuppressedForTurnContext(state, state.turns);
    if (cfg.review === "off" || suppressed) {
      recordBoardShadowIfEnabled(ctx, cfg, state, "agent_end", msgs);
      saveState(state);
      if (!suppressed) {
        void maybeAdvisorCheckin(pi, ctx, "agent_end");
      }
      return;
    }
    recordBoardShadowIfEnabled(ctx, cfg, state, "agent_end", msgs);
    saveState(state);
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
          "  /pi-rogue-advisor status|profile|mode|model|review|pause|unpause|checkins",
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
    description: "Senior engineering advisor. Usage: /pi-rogue-advisor [|status|profile|mode|model|review|pause|unpause|checkins|question]",
    getArgumentCompletions: (prefix: string) => advisorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const rawArg = String(args ?? "").trim();
      const a = rawArg.toLowerCase();
      const rawParts = rawArg ? rawArg.split(/\s+/) : [];
      const [cmd = "", ...rest] = a ? a.split(/\s+/) : [];
      const cfg = loadConfig();
      const state = loadState(ctx);

      if (!a || cmd === "status") {
        const note = readText(advisorCurrentPath(ctx)).trim();
        const resolved = await resolveModel(ctx, cfg);
        const route = state.router.review ?? state.router.preflight;
        const pause = advisorPauseRemaining(state, state.turns);
        const loop = state.advisorLoop;
        ctx.ui.notify([
          note ? `🧭 ${truncate(note, 200)}` : "",
          route ? `Router: ${summarizeRoute(route)}${route.safety ? " · safety" : ""}` : "",
          "",
          `Mode: ${cfg.mode} | Profile: ${cfg.profile ?? "off"} | Review: ${cfg.review} | Check-ins: ${checkinDescription(cfg)} (orchestration-managed) | Model: ${resolved?.label || cfg.model || "auto"}`,
          `Board shadow: ${cfg.board.mode} | Runs: ${state.board?.counters.runs ?? 0} | Last: ${state.board?.lastDecision?.action ?? "none"}`,
          pause > 0 ? `Advisor pause: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "Advisor pause: off",
          loop?.repeatCount && loop.repeatCount > 1 ? `Advisor loop guard: ${loop.repeatCount} repeated outputs across changing context` : "Advisor loop guard: idle",
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
      if (cmd === "profile") {
        const action = rest[0] || "status";
        if (action === "status" || action === "show") {
          ctx.ui.notify(advisorBoardProfileText(buildAdvisorBoardProfilePlan(ctx, cfg)), "info");
          return;
        }
        if (action === BUDGET_BOARD_PROFILE_ID || action === "on" || action === "enable") {
          const plan = buildAdvisorBoardProfilePlan(ctx, cfg);
          try {
            const next = applyAdvisorBoardProfilePlan(plan);
            setPiRogueStatus(ctx, next, state);
            ctx.ui.notify(`${advisorBoardProfileText({ ...plan, active: true })}\n\nEnabled budget-board profile.`, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (action === "off" || action === "disable") {
          const next = disableAdvisorBoardProfile(cfg);
          saveConfig(next);
          setPiRogueStatus(ctx, next, state);
          ctx.ui.notify("Budget-board profile disabled; pre-profile advisor settings restored where available, with user changes made while active preserved.", "info");
          return;
        }
        ctx.ui.notify("Usage: /pi-rogue-advisor profile status|budget-board|off", "error");
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
          `  profile: "${cfg.profile ?? "off"}" — budget-board is explicit opt-in; off is built-in behavior`,
          `  mode: "${cfg.mode}" — auto (preflight+post+cache) | manual | off`,
          `  review: "${cfg.review}" — light (changes/errors) | strict (every 3) | off`,
          `  checkins: "${cfg.checkins}" — set by active /pi-rogue-orchestration goal or loop lifecycle`,
          `  checkinIntervalMinutes: ${cfg.checkinIntervalMinutes}`,
          pause > 0 ? `  advisorPauseUntilTurn: ${pause} turn${pause === 1 ? "" : "s"} remaining` : "  advisorPauseUntilTurn: off",
          `  model: "${cfg.model || "auto"}" — optional override for higher/advanced advisor model`,
          `  board.mode: "${cfg.board.mode}" — off | shadow (phase-1 deterministic logging only)`,
          `  headOfBoard.mode: "${cfg.headOfBoard.mode}" — off | enabled (isolated read-only adapter)`,
          `  specialistDispatch.mode: "${cfg.specialistDispatch.mode}" — off | suggest | auto (read-only specialists)`,
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
      if (cmd === "board") {
        const v = rest[0] || "status";
        if (v === "status") {
          ctx.ui.notify(`${formatBoardShadowStatus(cfg.board, state.board)}\n\n${headOfBoardStatusText(cfg, state)}\n\n${specialistDispatchStatusText(cfg, state)}${cfg.profile === BUDGET_BOARD_PROFILE_ID ? `\n\n${budgetBoardEscalationPolicyText(cfg)}` : ""}`, "info");
          return;
        }
        if (v === "shadow" || v === "on") {
          const next: AdvisorConfig = { ...cfg, board: { mode: "shadow" } };
          saveConfig(next);
          setPiRogueStatus(ctx, next, state);
          ctx.ui.notify("Advisor Board shadow mode enabled. Phase 1 logs deterministic BoardDecision data only; no live whispers, models, specialists, head-of-board, or steer.", "info");
          return;
        }
        if (v === "off") {
          const next: AdvisorConfig = { ...cfg, board: { mode: "off" }, headOfBoard: { ...cfg.headOfBoard, mode: "off" }, specialistDispatch: { ...cfg.specialistDispatch, mode: "off" } };
          saveConfig(next);
          setPiRogueStatus(ctx, next, state);
          ctx.ui.notify("Advisor Board shadow mode, Head-of-Board adapter, and specialist dispatch disabled.", "info");
          return;
        }
        if (v === "reset") {
          state.board = defaultBoardShadowState();
          state.headOfBoard = { calls: 0 };
          state.specialistDispatch = defaultSpecialistCallState();
          saveState(state);
          ctx.ui.notify("Advisor Board shadow and Head-of-Board counters reset.", "info");
          return;
        }
        if (v === "specialist" || v === "specialists") {
          const action = rest[1] || "status";
          if (action === "status") {
            ctx.ui.notify(specialistDispatchStatusText(cfg, state), "info");
            return;
          }
          if (action === "suggest") {
            ctx.ui.notify(suggestedSpecialistText(ctx, state), "info");
            return;
          }
          if (action === "off" || action === "disable") {
            const next: AdvisorConfig = { ...cfg, specialistDispatch: { ...cfg.specialistDispatch, mode: "off" } };
            saveConfig(next);
            setPiRogueStatus(ctx, next, state);
            ctx.ui.notify("Advisor specialist dispatch disabled.", "info");
            return;
          }
          if (action === "suggest-mode" || action === "suggestions") {
            const next: AdvisorConfig = { ...cfg, specialistDispatch: { ...cfg.specialistDispatch, mode: "suggest" } };
            saveConfig(next);
            setPiRogueStatus(ctx, next, state);
            ctx.ui.notify("Advisor specialist dispatch set to suggest mode.", "info");
            return;
          }
          if (action === "ask") {
            const roleId = rest[2];
            const task = rawParts.slice(4).join(" ").trim();
            if (!roleId || !task) {
              ctx.ui.notify("Usage: /pi-rogue-advisor board specialist ask <role-id> <task>", "error");
              return;
            }
            await runSpecialistCommand(ctx, cfg, state, roleId, task);
            return;
          }
          ctx.ui.notify("Usage: /pi-rogue-advisor board specialist status|suggest|suggest-mode|off|ask <role-id> <task>", "error");
          return;
        }
        if (v === "head") {
          const action = rest[1] || "status";
          if (action === "status") {
            ctx.ui.notify(headOfBoardStatusText(cfg, state), "info");
            return;
          }
          if (action === "on" || action === "enable") {
            const next: AdvisorConfig = { ...cfg, headOfBoard: { ...cfg.headOfBoard, mode: "enabled" } };
            saveConfig(next);
            setPiRogueStatus(ctx, next, state);
            ctx.ui.notify("Advisor Head-of-Board adapter enabled. Calls are isolated, read-only, episodic, and use compact board ledger input only.", "info");
            return;
          }
          if (action === "off" || action === "disable") {
            const next: AdvisorConfig = { ...cfg, headOfBoard: { ...cfg.headOfBoard, mode: "off" } };
            saveConfig(next);
            setPiRogueStatus(ctx, next, state);
            ctx.ui.notify("Advisor Head-of-Board adapter disabled.", "info");
            return;
          }
          if (action === "ask") {
            const question = rawParts.slice(3).join(" ").trim();
            if (!question) {
              ctx.ui.notify("Usage: /pi-rogue-advisor board head ask <decision question>", "error");
              return;
            }
            await runHeadOfBoardCommand(ctx, cfg, state, question);
            return;
          }
          ctx.ui.notify("Usage: /pi-rogue-advisor board head status|on|off|ask <decision question>", "error");
          return;
        }
        ctx.ui.notify("Usage: /pi-rogue-advisor board status|shadow|off|reset|head status|head on|head off|head ask <question>|specialist status|specialist suggest|specialist ask <role-id> <task>", "error");
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
