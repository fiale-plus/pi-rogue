import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { sessionKey as sharedSessionKey, sessionScopedDir } from "@fiale-plus/pi-core";
import { appendText, featureDir, featureFile, readText, truncate, writeText, atomicWriteText } from "./internal.js";
import { ADVISOR_CANONICAL_CONTROL_LEAVES, advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";
import {
  appendRouteLog,
  binaryGatePredict,
  inspectBinaryGateArtifact,
  formatAdvisorDisplay,
  heuristicRoute,
  mergeReviewPolicy,
  routeNote,
  summarizeRoute,
  type AdvisorRouteDecision,
  type AdvisorRouteInput,
  type BinaryGateArtifactStatus,
  type BinaryGatePrediction,
  type ReviewPolicy,
} from "./router.js";
import { type TrajectoryFeatures } from "./binary-gate-eval.js";
import { classifyIntent, classifyMode } from "./preflight-signals.js";
import { findMissingReviewArtifacts } from "./review-preflight.js";
import { buildBoardLedger, decideBoardAction, type BoardEvent } from "./board.js";
import {
  callHeadOfBoardAdapter,
  defaultHeadOfBoardConfig,
  mergeHeadOfBoardRisks,
  normalizeHeadOfBoardConfig,
  type HeadOfBoardConfig,
} from "./board-head.js";
import {
  callReadOnlySpecialist,
  defaultSpecialistCallState,
  defaultSpecialistDispatchConfig,
  normalizeSpecialistDispatchConfig,
  suggestSpecialistRoles,
  type SpecialistCallState,
  type SpecialistDispatchConfig,
} from "./board-specialist.js";
import { loadBoardRoleBody, loadBoardRoleCatalog } from "./board-roles.js";

// ── Explicit-only configuration ─────────────────────────────────────────

export interface AdvisorModels {
  advisor?: string;
  specialist?: string;
  head?: string;
}
export interface AdvisorBoardConfig {
  specialists: "suggest" | "off";
  maxSpecialistCalls: number;
  specialistMaxTokens: number;
  headMaxTokens: number;
  maxEvidence?: number;
  maxRisks?: number;
  maxFailures?: number;
  maxSubagents?: number;
  maxTokens?: number;
}

export interface AdvisorConfig {
  models: AdvisorModels;
  board: AdvisorBoardConfig;
}

export type AdvisorProfileId = "budget-board";

export interface AdvisorProfileRestore {
  [key: string]: unknown;
}
type LegacyAdvisorConfig = {
  models?: unknown;
  board?: unknown;
  model?: unknown;
  mode?: unknown;
  review?: unknown;
  checkins?: unknown;
  checkinIntervalMinutes?: unknown;
  profile?: unknown;
  profileRestore?: unknown;
  headOfBoard?: unknown;
  specialistDispatch?: unknown;
};

const DEFAULT_CONFIG: AdvisorConfig = {
  models: {},
  board: {
    specialists: "suggest",
    maxSpecialistCalls: 3,
    specialistMaxTokens: 900,
    headMaxTokens: 1200,
  },
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
const MAX_BOARD_EVENTS = 64;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 15 * 60;
const STATE_VERSION = 1;
/** Maximum wall-clock time for one advisor model-resolution/completion work item. */
export const DEFAULT_ADVISOR_WORK_TIMEOUT_MS = 60_000;
const checkinLocks = new Set<string>();
const reviewLocks = new Set<string>();
const closedAdvisorSessions = new Set<string>();
const advisorWorks = new Map<string, AdvisorWork>();

type AdvisorWork = {
  controller: AbortController;
  deadlineAt: number;
};

class AdvisorWorkAbortError extends Error {
  constructor(readonly reason: "deadline" | "superseded" | "session_shutdown") {
    super(`Advisor work ${reason}`);
    this.name = "AbortError";
  }
}

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
  boardEvents: BoardLifecycleEvent[];
  workflow?: WorkflowState;
  rateLimit?: AdvisorRateLimitState;
  advisorLoop?: AdvisorLoopState;
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
type BoardLifecycleEvent = Extract<BoardEvent, { type: "file_changed" | "tool_failure" }>;

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
  turn?: number;
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
    boardEvents: [],
    workflow: {},
    advisorLoop: defaultAdvisorLoopState(),
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

function boundedBoardValue(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function cleanModelSlot(value: unknown): string | undefined {
  const model = typeof value === "string" ? value.trim() : "";
  return model && model.includes("/") ? model : undefined;
}

export function normalizeAdvisorConfig(raw: Partial<AdvisorConfig> | LegacyAdvisorConfig = {}): AdvisorConfig {
  const legacy = raw as LegacyAdvisorConfig;
  const sourceModels = legacy.models && typeof legacy.models === "object" ? legacy.models as Record<string, unknown> : {};
  const sourceBoard = legacy.board && typeof legacy.board === "object" ? legacy.board as Record<string, unknown> : {};
  const legacyHead = legacy.headOfBoard && typeof legacy.headOfBoard === "object" ? legacy.headOfBoard as Record<string, unknown> : {};
  const legacySpecialist = legacy.specialistDispatch && typeof legacy.specialistDispatch === "object" ? legacy.specialistDispatch as Record<string, unknown> : {};
  const models: AdvisorModels = {
    advisor: cleanModelSlot(sourceModels.advisor) ?? cleanModelSlot(legacy.model),
    specialist: cleanModelSlot(sourceModels.specialist) ?? cleanModelSlot(legacySpecialist.model),
    head: cleanModelSlot(sourceModels.head) ?? cleanModelSlot(legacyHead.model),
  };
  for (const key of Object.keys(models) as Array<keyof AdvisorModels>) {
    if (!models[key]) delete models[key];
  }
  const specialistMode = sourceBoard.specialists === "off" || legacySpecialist.mode === "off" ? "off" : "suggest";
  return {
    models,
    board: {
      specialists: specialistMode,
      maxSpecialistCalls: boundedBoardValue(sourceBoard.maxSpecialistCalls ?? legacySpecialist.maxCallsPerSession, DEFAULT_CONFIG.board.maxSpecialistCalls, 0, 8),
      specialistMaxTokens: boundedBoardValue(sourceBoard.specialistMaxTokens ?? legacySpecialist.maxTokens, DEFAULT_CONFIG.board.specialistMaxTokens, 100, 900),
      headMaxTokens: boundedBoardValue(sourceBoard.headMaxTokens ?? legacyHead.maxTokens ?? sourceBoard.maxTokens, DEFAULT_CONFIG.board.headMaxTokens, 100, 1200),
    },
  };
}

function loadConfig(): AdvisorConfig {
  return normalizeAdvisorConfig(readJson<Partial<AdvisorConfig>>(CONFIG_PATH, {}));
}

function saveConfig(c: AdvisorConfig) {
  writeJson(CONFIG_PATH, c);
}

function advisorSessionDir(ctxOrKey?: any): string {
  const root = join(featureDir("advisor"), "sessions");
  if (typeof ctxOrKey === "string") return join(root, safeSessionKey(ctxOrKey));
  return sessionScopedDir(root, ctxOrKey);
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
      turn: Number.isFinite(Number((obj as { turn?: unknown }).turn)) ? Math.max(0, Math.floor(Number((obj as { turn?: unknown }).turn))) : undefined,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      pr: Number.isFinite(pr) ? pr : undefined,
      details: typeof obj.details === "string" && obj.details ? obj.details : undefined,
    }];
  }).slice(-MAX_EVIDENCE);
}

function boardEvidenceText(value: unknown, max = 300): string {
  return squish(sanitizeDiagnosticValue(value), max);
}

function normalizeBoardEvents(raw: unknown): BoardLifecycleEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): BoardLifecycleEvent[] => {
    if (!entry || typeof entry !== "object") return [];
    const obj = entry as Record<string, unknown>;
    const turn = Number(obj.turn);
    const timestamp = typeof obj.timestamp === "string" && obj.timestamp ? boardEvidenceText(obj.timestamp, 80) : undefined;
    if (obj.type === "file_changed") {
      const path = boardEvidenceText(obj.path, 240);
      if (!path) return [];
      return [{ type: "file_changed", path, turn: Number.isFinite(turn) ? Math.max(0, Math.floor(turn)) : undefined, timestamp }];
    }
    if (obj.type === "tool_failure") {
      const tool = boardEvidenceText(obj.tool, 80);
      const key = boardEvidenceText(obj.key, 120);
      if (!tool || !key) return [];
      const message = boardEvidenceText(obj.message, 300);
      return [{
        type: "tool_failure",
        tool,
        key,
        message: message || undefined,
        turn: Number.isFinite(turn) ? Math.max(0, Math.floor(turn)) : undefined,
        timestamp,
      }];
    }
    return [];
  }).slice(-MAX_BOARD_EVENTS);
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
    boardEvents: normalizeBoardEvents(raw.boardEvents),
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


function headOfBoardStatusText(_cfg: AdvisorConfig, state: SessionState): string {
  return [
    "Advisor Head-of-Board: explicit-only",
    `Calls: ${state.headOfBoard?.calls ?? 0}`,
    state.headOfBoard?.lastAt ? `Last: ${state.headOfBoard.lastAt}` : "Last: never",
    state.headOfBoard?.lastModel ? `Last model: ${state.headOfBoard.lastModel}` : undefined,
    state.headOfBoard?.lastSkipped ? `Last skipped: ${state.headOfBoard.lastSkipped}` : undefined,
    "Constraints: isolated, read-only, compact board ledger only, no mutating tools/raw transcript.",
  ].filter(Boolean).join("\n");
}

export function currentBoardLedger(ctx: any, state: SessionState) {
  const validationEvents: BoardEvent[] = state.evidenceLedger.map((entry, index) => ({
    type: "validation",
    command: entry.command ?? entry.source,
    exitCode: entry.exitCode ?? (entry.result === "pass" || entry.result === "merged" ? 0 : 1),
    status: (entry.result === "pass" || entry.result === "merged" ? "green" : "red") as "green" | "red",
    turn: entry.turn ?? index + 1,
    timestamp: entry.timestamp,
    terminal: Boolean(state.workflow?.terminal),
  }));
  const events: BoardEvent[] = [
    { type: "session", id: sessionKey(ctx), worktree: String(ctx?.cwd || "") },
    ...(state.turns > 0 ? [{ type: "turn" as const, turn: state.turns }] : []),
    ...state.boardEvents,
    ...validationEvents,
  ];
  return buildBoardLedger(events);
}


async function runHeadOfBoardCommand(ctx: any, cfg: AdvisorConfig, state: SessionState, question: string): Promise<void> {
  const ledger = currentBoardLedger(ctx, state);
  const decision = decideBoardAction(ledger);
  state.headOfBoard = state.headOfBoard ?? { calls: 0 };
  const headConfig = {
    ...defaultHeadOfBoardConfig(),
    mode: "enabled" as const,
    maxTokens: cfg.board.headMaxTokens,
    callsUsed: state.headOfBoard.calls,
  };
  const result = await callHeadOfBoardAdapter(headConfig, { ledger, decision, question, reason: "user_request" }, async (systemPrompt, messages, options) => {
    return completeWithHigherAdvisorModel(ctx, cfg, systemPrompt, messages, { ...options, role: "head", maxAttempts: 2 });
  });
  if (result.skipped) {
    state.headOfBoard.lastSkipped = result.skipped;
    saveState(state);
    ctx.ui.notify(`Head-of-Board skipped: ${result.skipped}`, "info");
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
    "Advisor Specialists: explicit-only",
    `Calls: ${state.specialistDispatch?.calls ?? 0}`,
    state.specialistDispatch?.lastRole ? `Last role: ${state.specialistDispatch.lastRole}` : "Last role: none",
    "Constraints: read/search/context_lookup tools only, compact ledger input, bounded output.",
  ].join("\n");
}

function specialistById(roleId: string) {
  const catalog = loadBoardRoleCatalog();
  if (catalog.diagnostics.length > 0) return { diagnostic: catalog.diagnostics[0]?.message ?? "catalog diagnostics" };
  const summary = catalog.roles.find((role) => role.id === roleId && role.kind === "specialist");
  if (!summary) return { diagnostic: `unknown specialist '${roleId}'` };
  const loaded = loadBoardRoleBody(summary);
  if (loaded.diagnostic) return { diagnostic: loaded.diagnostic.message };
  return { role: loaded.role };
}

function inferBoardDiscoveryRoot(ctx: any): string {
  const cwd = resolve(String(ctx?.cwd || process.cwd()));
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim() || cwd;
  } catch {
    return cwd;
  }
}

async function runSpecialistCommand(ctx: any, cfg: AdvisorConfig, state: SessionState, roleId: string, task: string): Promise<void> {
  const found = specialistById(roleId);
  if (!found.role) {
    ctx.ui.notify(found.diagnostic ?? "Specialist unavailable.", "error");
    return;
  }
  const specialistConfig = {
    ...defaultSpecialistDispatchConfig(),
    mode: cfg.board.specialists,
    maxCallsPerSession: cfg.board.maxSpecialistCalls,
    maxTokens: cfg.board.specialistMaxTokens,
  };
  const result = await callReadOnlySpecialist({
    role: found.role,
    ledger: currentBoardLedger(ctx, state),
    task,
    config: specialistConfig,
    state: state.specialistDispatch!,
    currentTurn: state.turns,
    complete: async (systemPrompt, messages, options) => {
      const resp = await completeWithHigherAdvisorModel(ctx, cfg, systemPrompt, messages, { maxTokens: options.maxTokens, reasoning: "medium", role: "specialist", maxAttempts: 2 });
      if (!resp || resp.rateLimited) throw new Error(resp?.text || "specialist model unavailable");
      return resp.text;
    },
  });
  if ("denied" in result) {
    state.specialistDispatch!.lastDenied = result.denied;
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
  const suggestions = suggestSpecialistRoles(catalog.roles.filter((role) => role.kind === "specialist"), currentBoardLedger(ctx, state));
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

function contextBrokerBrief(pi: ExtensionAPI, ctx: any): string {
  try {
    const text = (pi as any).__piRogueContextBroker?.renderBrief?.(ctx);
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
        appendEvidence(state, { kind: "validation", sha, command, source, result, timestamp, turn: state.turns, exitCode, details: squish(output, 300) }, ctx, { clearResolved: clearValidationResolved });
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
          turn: state.turns,
          exitCode,
          pr,
          details: prState.mergeCommit ? `mergeCommit=${prState.mergeCommit}` : prState.state,
        }, ctx);
      } else if (/\bgh\s+pr\s+merge\b/i.test(mergeText)) {
        const localResult: EvidenceResult = exitCode === 0 ? "not_merged" : "error";
        appendEvidence(state, { kind: "merge", sha, command, source, result: localResult, timestamp, turn: state.turns, exitCode, pr, details: squish(output, 300) }, ctx);
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
              turn: state.turns,
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

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Advisor work aborted");
  error.name = "AbortError";
  return error;
}

/** Race a possibly non-cooperative registry call against the owned work signal. */
function awaitAdvisorWork<T>(promise: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: (value: any) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => settle(reject, abortError(signal));

    // Always observe the supplied promise first. In particular, a caller may have
    // already created a promise that rejects after its signal has been aborted.
    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function abortAdvisorWork(ctx: any, reason: "superseded" | "session_shutdown"): void {
  const key = sessionKey(ctx);
  const work = advisorWorks.get(key);
  if (!work) return;
  advisorWorks.delete(key);
  if (!work.controller.signal.aborted) work.controller.abort(new AdvisorWorkAbortError(reason));
}

async function withAdvisorWork<T>(ctx: any, externalSignal: AbortSignal | undefined, operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>): Promise<T | null> {
  const key = sessionKey(ctx);
  abortAdvisorWork(ctx, "superseded");
  const controller = new AbortController();
  const deadlineAt = Date.now() + DEFAULT_ADVISOR_WORK_TIMEOUT_MS;
  const work: AdvisorWork = { controller, deadlineAt };
  advisorWorks.set(key, work);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new AdvisorWorkAbortError("deadline")), DEFAULT_ADVISOR_WORK_TIMEOUT_MS);
  try {
    return await operation(controller.signal, deadlineAt);
  } catch (error) {
    // Preserve caller-owned cancellation (notably the explicit /advisor tool signal).
    if (externalSignal?.aborted) throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof AdvisorWorkAbortError && reason.reason === "deadline") {
        appendAdvisorDiagnostic("advisor_work_deadline", { timeoutMs: DEFAULT_ADVISOR_WORK_TIMEOUT_MS });
      }
      return null;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (advisorWorks.get(key) === work) advisorWorks.delete(key);
  }
}

/** Contain event-handler fire-and-forget check-ins without scheduling more work. */
function containAdvisorCheckin(promise: Promise<unknown>, source: string): void {
  void promise.catch((error) => {
    appendAdvisorDiagnostic("advisor_checkin_detached_failure", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
  persisted.boardEvents = state.boardEvents;
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

function mergeRouteReview(configReview: ReviewPolicy | undefined, route?: ReviewPolicy): ReviewPolicy {
  const review = configReview ?? "light";
  if (review === "off") return "off";
  if (!route) return review;
  return mergeReviewPolicy(review, route);
}

function sessionKey(ctx: any): string {
  return sharedSessionKey(ctx);
}

type OrchestrationSnapshot = {
  goal: string;
  loop: { enabled?: boolean; interval?: string; instruction?: string };
  research: { instruction?: string; interval?: string; cycles?: number; lastResult?: string };
};

function readOrchestrationSnapshot(ctx: any): OrchestrationSnapshot {
  const dir = sessionScopedDir(ORCHESTRATION_DIR, ctx);
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

function checkinDescription(_config: AdvisorConfig): string {
  return "checkins off";
}

function setPiRogueStatus(ctx: any, _config = loadConfig(), state?: SessionState): void {
  const currentState = state ?? loadState(ctx);
  ctx.ui.setStatus("pi-rogue", `advisor explicit-only · turns=${currentState.turns} · calls=${currentState.advisorCalls}`);
}

export function shouldRunCheckin(_config: AdvisorConfig, _state: SessionState, _now = Date.now(), _startedAt = _now): string | null {
  return null;
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

function advisorBinaryGatePathStatus(_config: AdvisorConfig): { preflight: string; review: string } {
  return { preflight: "disabled (explicit-only)", review: "disabled (explicit-only)" };
}

export function formatAdvisorBinaryGateStatus(_config: AdvisorConfig, state: unknown, status: BinaryGateArtifactStatus = inspectBinaryGateArtifact()): string {
  const route = state && typeof state === "object" && "router" in state ? (state as { router?: { review?: { source?: string } } }).router?.review : undefined;
  const model = status.usable
    ? `${status.kind}; features=${status.features ?? "unknown"}; source=${status.source}; stacked=${status.stacked ? "yes" : "no"}`
    : status.available
      ? `unusable (${status.source}: ${status.error || "invalid artifact"})`
      : `unavailable (${status.error || "missing artifact"})`;
  return [
    "Binary gate:",
    `- model: ${model}`,
    "- advisor preflight: disabled (explicit-only)",
    "- advisor review: disabled (explicit-only)",
    "- can act now: no",
    `- latest route: ${route?.source ?? "no advisor route yet"}`,
    `- artifact: ${status.path}`,
  ].join("\n");
}

function piRogueSubsystemRows(_config: AdvisorConfig, state: SessionState, _ctx: any): SubsystemStatusRow[] {
  return [{
    subsystem: "advisor",
    status: "explicit-only",
    details: `turns=${state.turns} · calls=${state.advisorCalls} · specialists=${state.specialistDispatch?.calls ?? 0} · head=${state.headOfBoard?.calls ?? 0}`,
  }];
}

function piRogueCockpitText(config: AdvisorConfig, state: SessionState, _currentNote: string, ctx: any): string {
  return [
    "Pi-Rogue status",
    formatSubsystemStatusRows(piRogueSubsystemRows(config, state, ctx)),
    "",
    "Commands: /pi-rogue status|help|doctor · /pi-rogue-advisor status|settings|model|board",
  ].join("\n");
}

function piRogueRootDir(): string {
  return join(homedir(), ".pi", "agent", "pi-rogue");
}

export type PiRoguePostureId = "guarded";

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
  const advisorModel = normalized.models?.advisor ?? `${SOTA_CHAIN[0].provider}/${SOTA_CHAIN[0].model}`;
  const specialistModel = normalized.models?.specialist ?? advisorModel;
  const headModel = normalized.models?.head ?? advisorModel;
  return {
    id: BUDGET_BOARD_PROFILE_ID,
    active: false,
    driverModel: advisorModel,
    advisorModel,
    headOfBoardModel: headModel,
    specialistModel,
    mutatesGlobalDriver: false,
    advisorConfig: normalized,
    files: { advisor: CONFIG_PATH },
    warnings: [],
  };
}

export function applyAdvisorBoardProfilePlan(plan: AdvisorBoardProfilePlan): AdvisorConfig {
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
  return [
    "Advisor Board policy: explicit-only model calls.",
    `  advisor: ${cfg.models?.advisor ?? "preferred candidate"}`,
    `  specialist: ${cfg.models?.specialist ?? "preferred candidate"}`,
    `  head: ${cfg.models?.head ?? "preferred candidate"}`,
    `  bounds: ${JSON.stringify(cfg.board)}`,
  ].join("\n");
}

export function disableAdvisorBoardProfile(current: AdvisorConfig): AdvisorConfig {
  return normalizeAdvisorConfig(current);
}

function advisorBoardProfileText(plan: AdvisorBoardProfilePlan): string {
  return [
    "Pi-Rogue advisor profile: explicit-only Board",
    `Status: ${plan.active ? "active" : "available"}`,
    `advisor: ${plan.advisorModel}`,
    `specialist: ${plan.specialistModel}`,
    `head: ${plan.headOfBoardModel}`,
    budgetBoardEscalationPolicyText(plan.advisorConfig),
  ].join("\n");
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

export interface PiRoguePosturePlan {
  posture: PiRoguePostureId;
  root: string;
  advisorModel: string;
  files: {
    summary: string;
    advisor: string;
    router: string;
    contextBrokerConfig: string;
  };
}

export interface PiRoguePostureApplyResult {
  posture: PiRoguePostureId;
  files: PiRoguePosturePlan["files"];
  advisor: AdvisorConfig;
}

export function parsePiRoguePosture(value: unknown): PiRoguePostureId | null {
  return String(value ?? "").trim().toLowerCase() === "guarded" ? "guarded" : null;
}

async function strongAdvisorForGuarded(ctx: any, current: AdvisorConfig): Promise<string> {
  const preferred = SOTA_CHAIN.map((item) => `${item.provider}/${item.model}`);
  // Reuse the owned, deadline-bounded resolver; guarded posture never considers regular fallback models.
  const candidates = await resolveModelCandidates(ctx, {
    ...current,
    models: { ...current.models, advisor: current.models.advisor && preferred.includes(current.models.advisor) ? current.models.advisor : undefined },
  }, { allowRegularFallback: false });
  const strong = candidates.find((candidate) => preferred.includes(piRogueModelId(candidate.model) ?? ""));
  if (strong) return piRogueModelId(strong.model) ?? strong.label;
  throw new Error("Guarded posture requires an authenticated strong advisor model. Configure credentials for openai-codex/gpt-5.5 or another supported strong model, then retry; no files were changed.");
}

export async function buildPiRoguePosturePlan(ctx: any, postureValue: unknown, options: { advisorPath?: string } = {}): Promise<PiRoguePosturePlan> {
  const posture = parsePiRoguePosture(postureValue);
  if (!posture) throw new Error(`unknown posture: ${String(postureValue ?? "") || "(empty)"}. Supported: guarded`);
  const root = piRogueRootDir();
  const files = {
    summary: join(root, "config.json"),
    advisor: options.advisorPath ?? CONFIG_PATH,
    router: join(root, "router", "config.json"),
    contextBrokerConfig: join(root, "context-broker", "config.json"),
  };
  const current = normalizeAdvisorConfig(readJson<Partial<AdvisorConfig>>(files.advisor, {}));
  const advisorModel = await strongAdvisorForGuarded(ctx, current);
  return { posture, root, advisorModel, files };
}

function guardedRouterProfiles(advisorModel: string): Record<string, any> {
  const spark = "openai-codex/gpt-5.3-codex-spark";
  const local = "llamacpp-qwen-unsloth/qwen3.6-35b-a3b-ud-q4-k-m";
  const fusion = "fusion/opencode-go-qwen-deepseek-gpt55";
  return {
    "all-smart": { worker: advisorModel, smart: advisorModel, teacher: advisorModel, reviewer: advisorModel, explore: advisorModel, debug_diagnose: advisorModel, review: advisorModel, verify: advisorModel },
    "spark-smart": { worker: spark, smart: advisorModel, teacher: advisorModel, reviewer: advisorModel, explore: spark, debug_diagnose: advisorModel, review: advisorModel, verify: spark },
    "local-smart": { worker: local, smart: advisorModel, teacher: advisorModel, reviewer: advisorModel, explore: local, debug_diagnose: advisorModel, review: advisorModel, verify: local },
    quick: { worker: spark, smart: spark, teacher: spark, reviewer: spark },
    balanced: { worker: spark, smart: advisorModel, teacher: advisorModel, reviewer: advisorModel },
    "fusion-smart": { worker: fusion, smart: fusion, teacher: fusion, reviewer: fusion, explore: fusion, debug_diagnose: fusion, review: fusion, verify: fusion },
  };
}

export function applyPiRoguePosturePlan(plan: PiRoguePosturePlan): PiRoguePostureApplyResult {
  const existingSummary = readJsonLoose(plan.files.summary);
  const now = existingSummary?.posture === plan.posture && typeof existingSummary?.configuredAt === "string"
    ? existingSummary.configuredAt
    : new Date().toISOString();
  const existingAdvisor = readJson<Partial<AdvisorConfig>>(plan.files.advisor, {});
  const baseRestore: AdvisorProfileRestore = {
    models: existingAdvisor.models,
    board: existingAdvisor.board,
  };
  const profileRestore: AdvisorProfileRestore = {
    ...baseRestore,
    profileModel: plan.advisorModel,
    profileMode: "auto",
    profileReview: "light",
    profileCheckins: "off",
  };
  const advisor = normalizeAdvisorConfig({
    ...existingAdvisor,
    profile: BUDGET_BOARD_PROFILE_ID,
    profileRestore,
    mode: "auto",
    review: "light",
    checkins: "off",
    model: plan.advisorModel,
    board: { mode: "shadow" },
    headOfBoard: profileHeadOfBoardConfig(),
    specialistDispatch: profileSpecialistDispatchConfig(),
  });
  writeJson(plan.files.advisor, advisor);
  writeJson(plan.files.summary, {
    schema: "pi-rogue.config.v1",
    posture: plan.posture,
    configuredAt: now,
    advisor: { model: plan.advisorModel },
    context: { enabled: true, durable: true, store: join(plan.root, "context-broker", "artifacts.sqlite"), rewriteThresholdBytes: 2048 },
    router: { enabled: false, mode: "auto_model", activeProfile: "spark-smart", config: plan.files.router },
    fusion: { enabled: false, recipeId: "opencode-go-qwen-deepseek-gpt55", recipes: join(plan.root, "fusion", "recipes.json") },
    storage: { root: plan.root },
  });
  writeJson(plan.files.router, {
    enabled: false,
    mode: "auto_model",
    print: "off",
    activeProfile: "spark-smart",
    profileOrder: ["spark-smart", "local-smart", "balanced", "quick", "all-smart", "fusion-smart"],
    profiles: guardedRouterProfiles(plan.advisorModel),
  });
  const existingContext = readJson<Record<string, unknown>>(plan.files.contextBrokerConfig, {});
  const existingRewriteThreshold = typeof existingContext.rewriteThresholdBytes === "number"
    ? existingContext.rewriteThresholdBytes
    : typeof existingContext.rewrite_threshold_bytes === "number"
      ? existingContext.rewrite_threshold_bytes
      : 2048;
  const existingLensesEnabled = typeof existingContext.contextLensesEnabled === "boolean"
    ? existingContext.contextLensesEnabled
    : typeof existingContext.context_lenses_enabled === "boolean"
      ? existingContext.context_lenses_enabled
      : true;
  writeJson(plan.files.contextBrokerConfig, {
    ...existingContext,
    rewriteThresholdBytes: existingRewriteThreshold,
    contextLensesEnabled: existingLensesEnabled,
  });
  return { posture: plan.posture, files: plan.files, advisor };
}

export async function applyPiRoguePostureConfig(ctx: any, input: { posture?: unknown }, options: { advisorPath?: string } = {}): Promise<PiRoguePostureApplyResult> {
  return applyPiRoguePosturePlan(await buildPiRoguePosturePlan(ctx, input?.posture, options));
}

function piRoguePostureText(result: PiRoguePostureApplyResult): string {
  return [
    `  advisor models: ${result.advisor.models?.advisor ?? "preferred candidate"}`,
    `  Board bounds: ${JSON.stringify(result.advisor.board)}`,
    "  lifecycle model work: explicit-only",
    "Verify: /pi-rogue-advisor status",
  ].join("\n");
}

export function isGuardedPostureConfig(_summary: unknown, _advisor: AdvisorConfig, _router: unknown): boolean {
  return false;
}

function activePostureText(): string {
  const root = piRogueRootDir();
  const summary = readJsonLoose(join(root, "config.json"));
  const router = readJsonLoose(join(root, "router", "config.json")) ?? {};
  return isGuardedPostureConfig(summary, loadConfig(), router) ? "guarded" : "custom";
}

export function parseCfgPostureArgs(args: unknown): PiRoguePostureId | null {
  const raw = String(args ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { posture?: unknown };
      return parsePiRoguePosture(parsed.posture);
    } catch {
      return null;
    }
  }
  const parts = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts[0] === "posture") return parsePiRoguePosture(parts[1]);
  return parsePiRoguePosture(parts[0]);
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
    models: { ...existingAdvisor.models, advisor: plan.advisorModel },
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
  return [
    "Pi-Rogue config map:",
    `  advisor: ${CONFIG_PATH}`,
    "Layering: built-in defaults → user-root Pi-Rogue config → session state.",
  ].join("\n");
}

function piRogueConfigureText(plan: PiRogueConfigurePlan): string {
  const intro = plan.mode === "on" ? "Pi-Rogue setup: user-root defaults." : "Pi-Rogue status plan: read-only; no files written.";
  return [
    intro,
    "",
    "Derived defaults:",
    `  advisor model: ${plan.advisorModel}`,
    "",
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Safety: root status is read-only; use explicit Advisor commands for changes.",
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
  const packages = configuredPackages(ctx).filter((entry) => entry.includes("pi-rogue"));
  const hasNpm = packages.some((entry) => entry.includes("npm:@fiale-plus/pi-rogue") || entry === "@fiale-plus/pi-rogue");
  const localSources = packages.filter((entry) => !entry.includes("npm:@fiale-plus/pi-rogue") && entry.includes("pi-rogue"));
  return [
    "Pi-Rogue doctor:",
    `  ${hasNpm ? "ok" : "warn"}: canonical package ${hasNpm ? "is registered" : "was not detected in settings"}`,
    `  ${localSources.length === 0 ? "ok" : "warn"}: local package registrations${localSources.length ? `: ${localSources.join(", ")}` : " not detected"}`,
    "  advisor lifecycle: explicit-only, data-only state collection",
    "",
    "This command is informational only; it does not modify config.",
  ].join("\n");
}

// ── Model resolution (higher/advanced first, then optional regular fallback) ──
type AdvisorRole = "advisor" | "specialist" | "head";
type ResolvedAdvisorModel = { model: unknown; auth: { apiKey: string; headers?: Record<string, string> }; label: string; fallback?: boolean };
type ModelResolutionOptions = { role?: AdvisorRole; allowRegularFallback?: boolean; maxAttempts?: number };
type AdvisorCompletionResult = { text: string; model: string; fallback?: boolean; rateLimited?: boolean; retryAfterSeconds?: number };
type AdvisorCompletionOptions = {
  maxTokens: number;
  reasoning: ThinkingLevel;
  role?: AdvisorRole;
  allowRegularFallback?: boolean;
  maxAttempts?: number;
  signal?: AbortSignal;
};

const ROLE_PREFERENCES: Record<AdvisorRole, string[]> = {
  advisor: SOTA_CHAIN.map((item) => `${item.provider}/${item.model}`),
  head: SOTA_CHAIN.map((item) => `${item.provider}/${item.model}`),
  specialist: CHEAP_DRIVER_CHAIN,
};

function modelId(model: unknown): string {
  if (!model || typeof model !== "object") return "";
  const value = model as { provider?: unknown; id?: unknown; model?: unknown };
  const provider = String(value.provider ?? "").trim();
  const id = String(value.id ?? value.model ?? "").trim();
  return provider && id && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
}

function isTextModel(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const input = (model as { input?: unknown }).input;
  return !Array.isArray(input) || input.length === 0 || input.includes("text");
}

async function resolveModelCandidatesWithinWork(ctx: any, config: AdvisorConfig, options: ModelResolutionOptions, signal: AbortSignal): Promise<ResolvedAdvisorModel[]> {
  const role = options.role ?? "advisor";
  const explicit = config.models[role];
  const preferred = ROLE_PREFERENCES[role];
  const available = (): unknown[] => {
    try {
      const rows = ctx.modelRegistry?.getAvailable?.();
      return Array.isArray(rows) ? rows.filter(isTextModel) : [];
    } catch {
      return [];
    }
  };
  const specs = explicit ? [explicit, preferred.find((id) => id !== explicit)] : [preferred[0]];
  const candidates: ResolvedAdvisorModel[] = [];
  const seen = new Set<string>();
  for (const [index, id] of specs.entries()) {
    if (!id || seen.has(id) || candidates.length >= 2) continue;
    seen.add(id);
    const [provider, ...parts] = id.split("/");
    let found = ctx.modelRegistry?.find?.(provider, parts.join("/"));
    if (!found && !explicit && index === 0) {
      found = available().find((item) => modelId(item) === id);
    }
    if (!found && explicit && index === 1) {
      found = available().find((item) => preferred.includes(modelId(item)));
    }
    if (!found || !isTextModel(found)) continue;
    try {
      const auth = await awaitAdvisorWork(ctx.modelRegistry?.getApiKeyAndHeaders(found), signal);
      if (auth?.ok && typeof auth.apiKey === "string" && auth.apiKey) {
        candidates.push({ model: found, auth: { apiKey: auth.apiKey, headers: auth.headers }, label: modelId(found) || id, fallback: index > 0 });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      appendAdvisorDiagnostic("model_auth_resolution_failed", { model: id, category: "auth_lookup_error" });
    }
  }
  if (!explicit && candidates.length === 0) {
    const preferredRank = (id: string): number => {
      const index = preferred.indexOf(id);
      return index < 0 ? preferred.length : index;
    };
    for (const found of available().sort((a, b) => preferredRank(modelId(a)) - preferredRank(modelId(b)))) {
      if (candidates.length >= 1 || seen.has(modelId(found))) break;
      const id = modelId(found);
      if (!id) continue;
      seen.add(id);
      try {
        const auth = await awaitAdvisorWork(ctx.modelRegistry?.getApiKeyAndHeaders(found), signal);
        if (auth?.ok && typeof auth.apiKey === "string" && auth.apiKey) candidates.push({ model: found, auth: { apiKey: auth.apiKey, headers: auth.headers }, label: id });
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }
  return candidates;
}

export async function resolveModelCandidates(ctx: any, config: AdvisorConfig, options: ModelResolutionOptions = {}): Promise<ResolvedAdvisorModel[]> {
  return (await withAdvisorWork(ctx, undefined, (signal) => resolveModelCandidatesWithinWork(ctx, config, options, signal))) ?? [];
}

async function resolveModel(ctx: any, config: AdvisorConfig, role: AdvisorRole = "advisor"): Promise<ResolvedAdvisorModel | null> {
  return (await resolveModelCandidates(ctx, config, { role }))[0] ?? null;
}


async function completeAdvisorWork(
  ctx: any,
  config: AdvisorConfig,
  systemPrompt: string,
  messages: any[],
  options: AdvisorCompletionOptions,
  includeFallbackFlag: boolean,
): Promise<AdvisorCompletionResult | null> {
  return withAdvisorWork(ctx, options.signal, async (signal, deadlineAt) => {
    let lastError = "";
    let lastRateLimit: AdvisorRateLimitInfo | undefined;
    let attempts = 0;
    const candidates = await resolveModelCandidatesWithinWork(ctx, config, options, signal);
    for (const resolved of candidates) {
      if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) break;
      attempts += 1;
      try {
        const timeoutMs = Math.max(1, deadlineAt - Date.now());
        const selectedModel = resolved.model as Parameters<typeof completeSimple>[0];
        const resp = await awaitAdvisorWork(completeSimple(selectedModel, { systemPrompt, messages }, {
          apiKey: resolved.auth.apiKey,
          headers: resolved.auth.headers,
          maxTokens: options.maxTokens,
          reasoning: options.reasoning,
          timeoutMs,
          signal,
        }), signal);
        return {
          text: responseText(resp) || "(empty)",
          model: resolved.label,
          ...(includeFallbackFlag ? { fallback: resolved.fallback } : {}),
        };
      } catch (error) {
        // A provider-thrown AbortError is not cancellation unless our signal says so.
        if (signal.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        lastRateLimit = parseAdvisorRateLimit(error) ?? lastRateLimit;
      }
    }
    if (lastRateLimit) return { text: lastRateLimit.reason, model: "none", rateLimited: true, retryAfterSeconds: lastRateLimit.retryAfterSeconds };
    // Manual Advisor calls surface the aggregate failure, while automatic
    // higher-model check-ins retain their historical null-on-failure contract
    // so callers do not record an error string as a successful check-in.
    return lastError && includeFallbackFlag
      ? { text: `No advisor/check-in model completed successfully (${lastError}).`, model: "none" }
      : null;
  });
}

export async function completeWithModelFallback(ctx: any, config: AdvisorConfig, systemPrompt: string, messages: any[], options: AdvisorCompletionOptions): Promise<AdvisorCompletionResult | null> {
  return completeAdvisorWork(ctx, config, systemPrompt, messages, options, true);
}

export async function completeWithHigherAdvisorModel(ctx: any, config: AdvisorConfig, systemPrompt: string, messages: any[], options: AdvisorCompletionOptions): Promise<AdvisorCompletionResult | null> {
  return completeAdvisorWork(ctx, config, systemPrompt, messages, options, false);
}

async function askAdvisor(pi: ExtensionAPI, ctx: any, question: string, scope: string, includeWork: boolean, signal?: AbortSignal) {
  const config = loadConfig();
  const state = loadState(ctx);
  const normalizedQuestion = sanitizeAdvisorText(question).trim();
  if (!normalizedQuestion) return { text: "Ask a question.", error: "empty" };

  const normalizedScope = sanitizeAdvisorText(scope).replace(/\s+/g, " ").trim().toLowerCase();
  const sessionBrief = includeWork ? brief(state) : "";
  const brokerBrief = includeWork ? contextBrokerBrief(pi, ctx) : "";
  const ck = hash(JSON.stringify({
    version: "advisor-answer-v2",
    model: config.models?.advisor ?? "auto",
    question: normalizedQuestion,
    scope: normalizedScope,
    includeRecentWork: includeWork,
    sessionBrief,
    brokerBrief,
  }));
  const cache = loadCache();
  if (cache[ck]) { state.cacheHits++; saveState(state); return { text: cache[ck], cached: true }; }

  const msgs = [
    { role: "user", content: [
      `Question: ${normalizedQuestion}`,
      normalizedScope ? `Scope: ${normalizedScope}` : "",
      sessionBrief ? `Session:\n${sessionBrief}` : "",
      brokerBrief ? `Context broker brief:\n${brokerBrief}` : "",
    ].filter(Boolean).join("\n"), timestamp: new Date().toISOString() },
  ] as any[];

  const completed = await completeWithModelFallback(ctx, config, ADVISOR_SYSTEM, msgs, { maxTokens: 600, reasoning: "medium" as ThinkingLevel, signal });
  if (!completed) return { text: "No model available. Install one via pi config.", error: "no_model" };
  if (completed.rateLimited) {
    recordRateLimit(state, ctx, { reason: completed.text || "advisor rate limit (429)", retryAfterSeconds: completed.retryAfterSeconds });
    saveState(state);
    return { text: state.rateLimit?.reason || "Advisor rate limit active.", model: completed.model, error: "rate_limit" };
  }
  const text = completed.text;
  const loopFamilyHash = advisorLoopFamilyHash(["question", question, scope, state.lastTask || ""]);
  const loopContextHash = advisorLoopContextHash(["question", config.models?.advisor ?? "auto", question, scope, includeWork ? brief(state) : "", brokerBrief]);
  const loop = observeAdvisorLoop(state, "question", loopFamilyHash, loopContextHash, text);
  if (!loop.loopDetected && text && text !== "(empty)") { cache[ck] = text; saveCache(cache); }
  state.advisorCalls++;
  saveState(state);
  return { text: loop.text, model: completed.model, fallback: completed.fallback, loopDetected: loop.loopDetected };
}


function nestedToolValue(tool: unknown, keys: string[]): unknown {
  if (!tool || typeof tool !== "object") return undefined;
  let value: unknown = tool;
  for (const key of keys) {
    if (!value || typeof value !== "object" || !(key in value)) return undefined;
    const record = value as Record<string, unknown>;
    value = record[key];
  }
  return value;
}

function lifecycleChangedFiles(tool: any): string[] {
  const command = toolCommand(tool);
  const toolName = String(nestedToolValue(tool, ["toolName"]) ?? nestedToolValue(tool, ["name"]) ?? "");
  const mutation = /\b(?:edit|write|patch|apply_patch|create|delete|remove|move|rename|mkdir|touch|cp|mv|rm)\b/i.test(`${toolName} ${command ?? ""}`);
  if (!mutation) return [];
  const values: unknown[] = [
    nestedToolValue(tool, ["path"]),
    nestedToolValue(tool, ["file"]),
    nestedToolValue(tool, ["input", "path"]),
    nestedToolValue(tool, ["args", "path"]),
    nestedToolValue(tool, ["details", "path"]),
    nestedToolValue(tool, ["result", "path"]),
    nestedToolValue(tool, ["changedFiles"]),
    nestedToolValue(tool, ["files"]),
    nestedToolValue(tool, ["result", "changedFiles"]),
  ];
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => boardEvidenceText(value, 240)).filter(Boolean))];
}

function lifecycleFailureEvent(tool: unknown, turn: number, timestamp: string): BoardLifecycleEvent | undefined {
  if (!toolOverallFailed(tool)) return undefined;
  const command = toolCommand(tool) ?? "tool";
  const toolName = boardEvidenceText(nestedToolValue(tool, ["toolName"]) ?? nestedToolValue(tool, ["name"]) ?? command.split(/\s+/, 1)[0], 80) || "tool";
  const key = boardEvidenceText(nestedToolValue(tool, ["errorCode"]) ?? nestedToolValue(tool, ["details", "errorCode"]) ?? command, 120) || "failure";
  const message = boardEvidenceText(toolEvidenceText(tool), 300);
  return { type: "tool_failure", tool: toolName, key, message: message || undefined, turn, timestamp };
}

function collectLifecycleBoardEvents(state: SessionState, toolResults: unknown[], turn: number, timestamp: string): void {
  const events: BoardLifecycleEvent[] = [];
  for (const tool of toolResults) {
    for (const path of lifecycleChangedFiles(tool)) events.push({ type: "file_changed", path, turn, timestamp });
    const failure = lifecycleFailureEvent(tool, turn, timestamp);
    if (failure) events.push(failure);
  }
  state.boardEvents = [...state.boardEvents, ...events].slice(-MAX_BOARD_EVENTS);
}

function collectLifecycleEvidence(event: unknown, ctx: any, agentEnd: boolean): void {
  const state = loadState(ctx);
  const record = event && typeof event === "object" ? event as Record<string, unknown> : {};
  const turnIndex = Number(record.turnIndex);
  if (!agentEnd) state.turns = Math.max(state.turns + 1, Number.isFinite(turnIndex) ? Math.floor(turnIndex) + 1 : 0);
  const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
  const text = noteText(message?.content ?? record.messages ?? "");
  if (text) state.notes = [...state.notes, text].slice(-MAX_NOTES);
  const toolResults = Array.isArray(record.toolResults) ? record.toolResults : [];
  const timestamp = new Date().toISOString();
  collectLifecycleBoardEvents(state, toolResults, state.turns, timestamp);
  observeWorkflowEvidence(state, ctx, agentEnd ? "agent_end" : "turn_end", toolResults, text);
  for (const result of toolResults) {
    const summary = boardEvidenceText(toolEvidenceText(result), 500);
    if (summary && /error|fail|exception/i.test(summary)) state.errors = [...state.errors, summary].slice(-MAX_ERRORS);
  }
  if (agentEnd && text) state.lastTask = text.slice(0, 500);
  saveState(state);
}

// ── Extension entry point ──────────────────────────────────────────────────

export function shouldRunAdvisorReview(
  review: ReviewPolicy,
  meta: { isAgentEnd: boolean; fileChanged: boolean; failed: boolean },
  route: AdvisorRouteDecision,
  turns: number,
): boolean {
  return review === "strict"
    ? meta.isAgentEnd || meta.fileChanged || meta.failed || route.label !== "abstain" || turns % 3 === 0
    : review !== "off" && (meta.fileChanged || meta.failed);
}

export function applyReviewGatePrediction(heuristic: AdvisorRouteDecision, prediction: BinaryGatePrediction | null, failed = false): AdvisorRouteDecision {
  if (!prediction?.trusted || heuristic.safety || failed) return heuristic;
  const gateContinues = prediction.decision === "continue";
  return {
    ...heuristic,
    label: gateContinues ? "abstain" : "course_correct",
    confidence: prediction.confidence,
    source: "model",
    reason: gateContinues ? "local gate predicts continue" : "local gate predicts review",
    review: gateContinues ? "off" : "strict",
    escalate: !gateContinues,
  };
}

export function applyPreflightGatePrediction(heuristic: AdvisorRouteDecision, prediction: BinaryGatePrediction | null): AdvisorRouteDecision {
  if (!prediction?.trusted || heuristic.safety) return heuristic;
  const label = prediction.decision === "continue" ? "continue" : "escalate_to_advisor";
  return {
    ...heuristic,
    label,
    confidence: prediction.confidence,
    reason: prediction.decision === "continue" ? "local gate predicts continue" : "local gate predicts review",
    source: "model",
    preflight: label === "continue" ? "off" : "full",
    escalate: label === "escalate_to_advisor",
  };
}

export function registerAdvisor(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueAdvisorRegistered) return;
  p.__piRogueAdvisorRegistered = true;

  for (const customType of ["advisor:model", "advisor:rules", "advisor:llm"] as const) {
    pi.registerMessageRenderer(customType, renderAdvisorHint);
  }

  // Lifecycle is deliberately limited to state ownership. It never resolves a
  // model, completes a prompt, mutates a system prompt, or calls a router.
  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    closedAdvisorSessions.delete(key);
    abortAdvisorWork(ctx, "superseded");
    checkinLocks.delete(key);
    saveState(loadState(ctx));
  });
  pi.on("turn_end", (event, ctx) => {
    collectLifecycleEvidence(event, ctx, false);
  });
  pi.on("agent_end", (event, ctx) => {
    collectLifecycleEvidence(event, ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    closedAdvisorSessions.add(key);
    abortAdvisorWork(ctx, "session_shutdown");
    checkinLocks.delete(key);
    ctx.ui.setStatus("pi-rogue", undefined);
  });

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description: "Explicit senior engineering advice. No lifecycle or background calls.",
    parameters: Type.Object({
      question: Type.String({ description: "One concise question" }),
      scope: Type.Optional(Type.String({ description: "architecture|implementation|debug|review|planning" })),
      includeRecentWork: Type.Optional(Type.Boolean({ description: "Include compact session evidence (default true)" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const r = await askAdvisor(pi, ctx, String(params.question || ""), String(params.scope || ""), params.includeRecentWork !== false, signal);
      onUpdate?.({ content: [{ type: "text", text: r.cached ? "(cached)" : r.model ? `Consulting ${r.model}…` : "" }], details: { model: r.model, fallback: r.fallback } });
      return { content: [{ type: "text", text: r.text }], details: { cached: r.cached, error: r.error, model: r.model, fallback: r.fallback } };
    },
  });

  pi.registerCommand("pi-rogue", {
    description: "Pi-Rogue management: status|help|doctor",
    getArgumentCompletions: (prefix: string) => piRogueArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const command = String(args ?? "").trim().toLowerCase();
      const config = loadConfig();
      const state = loadState(ctx);
      const text = command === "doctor"
        ? piRogueDoctorText(ctx)
        : command === "help"
          ? "Pi-Rogue commands:\n/pi-rogue status|help|doctor\n/pi-rogue-advisor status|settings|model [advisor|specialist|head] <provider>/<model>|null|board ..."
          : piRogueCockpitText(config, state, "", ctx);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("pi-rogue-advisor", {
    description: `Explicit Advisor and Board calls (${ADVISOR_CANONICAL_CONTROL_LEAVES.join("|")}). Usage: /pi-rogue-advisor model <provider>/<model> or a question`,
    getArgumentCompletions: (prefix: string) => advisorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const rawArg = String(args ?? "").trim();
      const parts = rawArg ? rawArg.split(/\s+/) : [];
      const command = String(parts[0] ?? "").toLowerCase();
      const cfg = loadConfig();
      const state = loadState(ctx);

      if (command === "model") {
        const first = String(parts[1] ?? "");
        const slot = first === "advisor" || first === "specialist" || first === "head" ? first : "advisor";
        const value = slot === "advisor" && first !== "advisor" ? first : String(parts[2] ?? "");
        const selected = value.trim().toLowerCase() === "null" ? undefined : cleanModelSlot(value);
        if (!selected && value.trim().toLowerCase() !== "null") {
          ctx.ui.notify("Usage: /pi-rogue-advisor model [advisor|specialist|head] <provider>/<model>|null", "error");
          return;
        }
        const models = { ...cfg.models };
        if (selected) models[slot] = selected;
        else delete models[slot];
        saveConfig(normalizeAdvisorConfig({ ...cfg, models }));
        ctx.ui.notify(`${slot} model ${selected ? `set to ${selected}` : "cleared (auto selection restored)"}.`, "info");
        return;
      }

      if (!rawArg || command === "status" || command === "settings" || command === "config") {
        const resolved = await resolveModel(ctx, cfg);
        ctx.ui.notify([
          `Advisor model: ${resolved?.label ?? cfg.models.advisor ?? "no compatible model"}`,
          `Specialist model: ${cfg.models.specialist ?? "preferred cheapest compatible text model"}`,
          `Head-of-Board model: ${cfg.models.head ?? "preferred strongest compatible text model"}`,
          `Board: specialists=${cfg.board.specialists}, maxSpecialistCalls=${cfg.board.maxSpecialistCalls}, specialistMaxTokens=${cfg.board.specialistMaxTokens}, headMaxTokens=${cfg.board.headMaxTokens}`,
          `Explicit calls: ${state.advisorCalls} advisor, ${state.specialistDispatch?.calls ?? 0} specialist, ${state.headOfBoard?.calls ?? 0} head`,
        ].join("\n"), "info");
        return;
      }

      if (command === "board") {
        const area = String(parts[1] ?? "status").toLowerCase();
        if (area === "specialist" || area === "specialists") {
          const action = String(parts[2] ?? "status").toLowerCase();
          if (action === "status") {
            ctx.ui.notify(specialistDispatchStatusText(cfg, state), "info");
            return;
          }
          if (action === "suggest") {
            ctx.ui.notify(suggestedSpecialistText(ctx, state), "info");
            return;
          }
          if (action === "ask") {
            const roleId = parts[3];
            const task = parts.slice(4).join(" ").trim();
            if (!roleId || !task) {
              ctx.ui.notify("Usage: /pi-rogue-advisor board specialist ask <role-id> <task>", "error");
              return;
            }
            await runSpecialistCommand(ctx, cfg, state, roleId, task);
            return;
          }
          ctx.ui.notify("Usage: board specialist status|suggest|ask <role-id> <task>", "error");
          return;
        }
        if (area === "head") {
          const action = String(parts[2] ?? "status").toLowerCase();
          if (action === "status") {
            ctx.ui.notify(`Advisor Head-of-Board: explicit-only\nCalls: ${state.headOfBoard?.calls ?? 0}\nConstraints: read-only compact Board ledger`, "info");
            return;
          }
          if (action === "ask") {
            const question = parts.slice(3).join(" ").trim();
            if (!question) {
              ctx.ui.notify("Usage: /pi-rogue-advisor board head ask <decision question>", "error");
              return;
            }
            await runHeadOfBoardCommand(ctx, cfg, state, question);
            return;
          }
          ctx.ui.notify("Usage: board head status|ask <decision question>", "error");
          return;
        }
        ctx.ui.notify("Usage: board specialist status|suggest|ask or board head status|ask", "error");
        return;
      }

      const result = await askAdvisor(pi, ctx, rawArg, "slash", true);
      if (result.error) {
        ctx.ui.notify(result.text, "warning");
        return;
      }
      sendAdvisorAnswer(pi, result.text);
    },
  });
}

export default function advisorExtension(pi: ExtensionAPI) { registerAdvisor(pi); }
