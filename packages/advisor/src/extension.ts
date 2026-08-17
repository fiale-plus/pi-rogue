import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { completeSimple, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { sessionKey as sharedSessionKey, sessionScopedDir } from "@fiale-plus/pi-core";
import { appendText, featureDir, featureFile, readText, truncate, writeText, atomicWriteText } from "./internal.js";
import { ADVISOR_CANONICAL_CONTROL_LEAVES, advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";
import { addCloseoutEvidence, closeoutText, exportCloseout, loadCloseout, recordCloseoutStatus, startCloseout, syncCloseoutFacts } from "./closeout.js";
import { buildBoardLedger, decideBoardAction, type BoardEvent } from "./board.js";
import {
  callHeadOfBoardAdapter,
  defaultHeadOfBoardConfig,
} from "./board-head.js";
import {
  callReadOnlySpecialist,
  defaultSpecialistCallState,
  defaultSpecialistDispatchConfig,
  suggestSpecialistRoles,
  type SpecialistCallState,
} from "./board-specialist.js";
import { loadBoardRoleBody, loadBoardRoleCatalog } from "./board-roles.js";
import { defaultBoardWatchConfig, normalizeBoardWatchConfig, normalizeBoardWatchState, runBoardWatch, type BoardWatchConfig, type BoardWatchState } from "./board-watcher.js";

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

type LegacyAdvisorConfig = {
  models?: unknown;
  board?: unknown;
  model?: unknown;
  mode?: unknown;
  review?: unknown;
  headOfBoard?: unknown;
  specialistDispatch?: unknown;
  profile?: unknown;
  profileRestore?: unknown;
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
const BOARD_WATCH_CONFIG_PATH = featureFile("advisor", "board-watch.json");
const LEGACY_STATE_PATH = featureFile("advisor", "state.json");

export function advisorBoardWatchConfigPath(): string {
  return BOARD_WATCH_CONFIG_PATH;
}
const CACHE_PATH = featureFile("advisor", "cache.json");
const DEFAULT_DIAGNOSTICS_PATH = featureFile("advisor", "diagnostics.jsonl");
const SESSION_STATE_PROP = "__piRogueAdvisorStatePath";

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
  boardWatch: BoardWatchState;
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

function loadBoardWatchConfig(): BoardWatchConfig {
  return normalizeBoardWatchConfig(readJson(BOARD_WATCH_CONFIG_PATH, defaultBoardWatchConfig()));
}

function saveBoardWatchConfig(config: BoardWatchConfig): void {
  writeJson(BOARD_WATCH_CONFIG_PATH, normalizeBoardWatchConfig(config));
}

function advisorSessionDir(ctxOrKey?: any): string {
  const root = join(featureDir("advisor"), "sessions");
  if (typeof ctxOrKey === "string") return join(root, safeSessionKey(ctxOrKey));
  return sessionScopedDir(root, ctxOrKey);
}

export function advisorSessionStatePath(ctxOrKey?: any): string {
  return join(advisorSessionDir(ctxOrKey), "state.json");
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
  return attachStatePath({
    _v: STATE_VERSION,
    turns: raw.turns ?? 0,
    lastTask: raw.lastTask ?? "",
    notes: (raw.notes ?? []).map(noteText).filter(Boolean).slice(-MAX_NOTES),
    files: (raw.files ?? []).slice(-MAX_FILES),
    errors: (raw.errors ?? []).slice(-MAX_ERRORS),
    advisorCalls: raw.advisorCalls ?? 0,
    cacheHits: raw.cacheHits ?? 0,
    evidenceLedger: normalizeEvidenceLedger(raw.evidenceLedger),
    boardEvents: normalizeBoardEvents(raw.boardEvents),
    boardWatch: normalizeBoardWatchState(raw.boardWatch),
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
  }, path);
}

function saveState(s: SessionState) {
  atomicWriteText(statePathFor(s), JSON.stringify(s, null, 2) + "\n");
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

function specialistDispatchStatusText(_cfg: AdvisorConfig, state: SessionState): string {
  return [
    "Advisor Specialists: explicit-only",
    `Calls: ${state.specialistDispatch?.calls ?? 0}`,
    state.specialistDispatch?.lastRole ? `Last role: ${state.specialistDispatch.lastRole}` : "Last role: none",
    "Constraints: read/search tools only, compact ledger input, bounded output.",
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


function latestEvidence(state: SessionState, kind: EvidenceKind): EvidenceLedgerEntry | undefined {
  return [...(state.evidenceLedger ?? [])].reverse().find((entry) => entry.kind === kind);
}

function appendEvidence(state: SessionState, entry: EvidenceLedgerEntry): void {
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
    return;
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
  for (const tool of toolResults) {
    const command = toolCommand(tool);
    const output = toolEvidenceText(tool);
    const exitCode = toolExitCode(tool);
    if (looksLikeValidationCommand(command, output)) {
      const result = structuredValidationResult(tool);
      if (result) {
        appendEvidence(state, { kind: "validation", sha, command, source, result, timestamp, turn: state.turns, exitCode, details: squish(output, 300) });
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
        });
      } else if (/\bgh\s+pr\s+merge\b/i.test(mergeText)) {
        const localResult: EvidenceResult = exitCode === 0 ? "not_merged" : "error";
        appendEvidence(state, { kind: "merge", sha, command, source, result: localResult, timestamp, turn: state.turns, exitCode, pr, details: squish(output, 300) });
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
            });
          }
        }
      }
    }
  }
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

function recordRateLimit(state: SessionState, _ctx: any, info: AdvisorRateLimitInfo): void {
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

function noteText(note: unknown): string {
  const text = contentText(note);
  if (/^\[object Object\](,\[object Object\])*$/.test(text)) return "";
  if (text) return squish(text, 500);
  if (note && typeof note === "object") return squish(JSON.stringify(note), 500);
  return text;
}


const STRUCTURED_GREEN_TEST_RE = /(?:\bTests\s+\d+\s+passed\s+\(\d+\)|\bTest Files\s+\d+\s+passed\s+\(\d+\)|\bnumFailedTests\s*[:=]\s*0\b|"numFailedTests"\s*:\s*0|\bsuccess\s*[:=]\s*true\b|"success"\s*:\s*true|\b(?:PIPE_)?EXIT\s*:\s*0\b)/i;
const STRUCTURED_FAILING_TEST_RE = /(?:\bTests?\s+.*?\bfailed\s+\([1-9]\d*\)|\bTest Files\s+.*?\bfailed\s+\([1-9]\d*\)|\bnumFailedTests\s*[:=]\s*[1-9]\d*\b|"numFailedTests"\s*:\s*[1-9]\d*|\b(?:PIPE_)?EXIT\s*:\s*[1-9]\d*\b)/i;
const HUMAN_TEST_SUMMARY_RE = /(?:\bTests?\s+\d+\s+(?:passed|failed)\s+\(\d+\)|\bTest Files\s+\d+\s+(?:passed|failed)\s+\(\d+\))/i;

type AdvisorHintDetails = {
  kind?: "handoff" | "answer";
  decision?: "continue" | "review" | "defer";
  reason?: string;
  summary?: string;
  actions?: unknown;
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



function normalizeAdvisorActions(actions: unknown): string[] {
  const raw = Array.isArray(actions) ? actions : typeof actions === "string" ? [actions] : [];
  return raw.map((action) => squish(action, 200)).filter(Boolean).slice(0, 2);
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

function responseText(resp: { content?: Array<{ type?: string; text?: string }> } | null | undefined): string {
  return (resp?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
}

function sessionKey(ctx: any): string {
  return sharedSessionKey(ctx);
}

type SubsystemStatusRow = {
  subsystem: string;
  status: string;
  details: string;
};

function formatSubsystemStatusRows(rows: SubsystemStatusRow[]): string {
  const subsystemWidth = Math.max(11, ...rows.map((row) => row.subsystem.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  return [
    `${"Subsystem".padEnd(subsystemWidth)} | ${"Status".padEnd(statusWidth)} | Details`,
    `${"-".repeat(subsystemWidth)}-+-${"-".repeat(statusWidth)}-+--------------------------------`,
    ...rows.map((row) => `${row.subsystem.padEnd(subsystemWidth)} | ${row.status.padEnd(statusWidth)} | ${row.details}`),
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
  const closeout = syncCloseoutFacts(ctx, state) ?? loadCloseout(ctx);
  return [
    "Pi-Rogue status",
    formatSubsystemStatusRows(piRogueSubsystemRows(config, state, ctx)),
    "",
    `Closeout: ${closeout?.status ?? "none"}`,
    "Commands: /pi-rogue status|help|doctor|closeout · /pi-rogue-advisor status|settings|model|board",
  ].join("\n");
}



function readJsonLoose(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readText(path));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
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

type AdvisorModelSummary = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  inputCost?: number;
  outputCost?: number;
};

export type AdvisorModelInspection = {
  role: AdvisorRole;
  configured?: string;
  configuredAvailable: boolean;
  recommended?: string;
  selected?: string;
  candidates: AdvisorModelSummary[];
};

function finiteModelNumber(model: unknown, key: "contextWindow" | "maxTokens"): number | undefined {
  if (!model || typeof model !== "object") return undefined;
  const value = Number((model as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelCost(model: unknown, key: "input" | "output"): number | undefined {
  if (!model || typeof model !== "object") return undefined;
  const cost = (model as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object") return undefined;
  const value = Number((cost as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function summarizeAdvisorModel(model: unknown): AdvisorModelSummary | undefined {
  const id = modelId(model);
  if (!id || !isTextModel(model)) return undefined;
  const value = model as { name?: unknown; provider?: unknown; reasoning?: unknown };
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    provider: String(value.provider ?? id.split("/", 1)[0]),
    reasoning: value.reasoning === true,
    contextWindow: finiteModelNumber(model, "contextWindow"),
    maxTokens: finiteModelNumber(model, "maxTokens"),
    inputCost: modelCost(model, "input"),
    outputCost: modelCost(model, "output"),
  };
}

function modelPreferenceRank(role: AdvisorRole, id: string): number {
  const rank = ROLE_PREFERENCES[role].indexOf(id);
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

function modelMetric(value: number | undefined): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Rank only the models Pi reports as authenticated and text-capable. Known
 * role preferences win first; metadata is only a deterministic tie-breaker
 * for models outside the preference list, not a claim of universal quality.
 */
export function rankAvailableAdvisorModels(role: AdvisorRole, models: unknown[]): AdvisorModelSummary[] {
  const summaries = models
    .map(summarizeAdvisorModel)
    .filter((model): model is AdvisorModelSummary => Boolean(model));
  const unique = [...new Map(summaries.map((model) => [model.id, model])).values()];
  return unique.sort((a, b) => {
    const preferred = modelPreferenceRank(role, a.id) - modelPreferenceRank(role, b.id);
    if (preferred !== 0) return preferred;
    if (role === "specialist") {
      const cost = modelMetric(a.outputCost ?? a.inputCost) - modelMetric(b.outputCost ?? b.inputCost);
      if (cost !== 0) return cost;
      const context = modelMetric(a.contextWindow) - modelMetric(b.contextWindow);
      if (context !== 0) return context;
    } else {
      if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
      const context = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
      if (context !== 0) return context;
      const maxTokens = (b.maxTokens ?? 0) - (a.maxTokens ?? 0);
      if (maxTokens !== 0) return maxTokens;
    }
    return a.id.localeCompare(b.id);
  });
}

export function inspectAdvisorModels(config: AdvisorConfig, models: unknown[]): AdvisorModelInspection[] {
  const roles: AdvisorRole[] = ["advisor", "specialist", "head"];
  return roles.map((role) => {
    const candidates = rankAvailableAdvisorModels(role, models);
    const configured = config.models[role];
    const configuredAvailable = Boolean(configured && candidates.some((candidate) => candidate.id === configured));
    const recommended = candidates[0]?.id;
    return {
      role,
      configured,
      configuredAvailable,
      recommended,
      selected: configuredAvailable ? configured : recommended,
      candidates,
    };
  });
}

function availableAdvisorModels(ctx: any): unknown[] {
  try {
    const models = ctx.modelRegistry?.getAvailable?.();
    return Array.isArray(models) ? models.filter(isTextModel) : [];
  } catch {
    return [];
  }
}

function formatModelFact(value: number | undefined, suffix = ""): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m${suffix}`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k${suffix}`;
  return `${value}${suffix}`;
}

function formatAdvisorModelCandidate(model: AdvisorModelSummary, selected: boolean, recommended: boolean): string {
  const tags = [selected ? "selected" : "", recommended ? "recommended" : ""].filter(Boolean).join(", ");
  const cost = model.inputCost === undefined && model.outputCost === undefined
    ? "cost=?"
    : `cost=${model.inputCost ?? "?"}/${model.outputCost ?? "?"}`;
  return `  ${tags ? `[${tags}] ` : ""}${model.id} — ${model.name} · reasoning=${model.reasoning ? "yes" : "no"} · context=${formatModelFact(model.contextWindow)} · max=${formatModelFact(model.maxTokens)} · ${cost}`;
}

export function advisorModelInspectionText(config: AdvisorConfig, models: unknown[], roleFilter?: AdvisorRole): string {
  const inspections = inspectAdvisorModels(config, models).filter((inspection) => !roleFilter || inspection.role === roleFilter);
  if (inspections.length === 0) return "Usage: /pi-rogue-advisor model list [advisor|specialist|head]";
  const lines = [
    "Advisor model choices (authenticated text models only; no model call made):",
    "Role policy: Advisor balances quality, specialists prefer efficiency, Head prefers reasoning and context.",
  ];
  for (const inspection of inspections) {
    const configured = inspection.configured ?? "auto";
    const selected = inspection.selected ?? "none available";
    lines.push(`\n${inspection.role}: configured=${configured} · selected=${selected} · recommended=${inspection.recommended ?? "none"}`);
    if (inspection.configured && !inspection.configuredAvailable) {
      lines.push(`  WARNING: configured model ${inspection.configured} is not currently available or authenticated.`);
    }
    if (inspection.candidates.length === 0) {
      lines.push("  No compatible authenticated text models found. Configure a provider/model in Pi first.");
    } else {
      for (const candidate of inspection.candidates.slice(0, 12)) {
        lines.push(formatAdvisorModelCandidate(candidate, candidate.id === inspection.selected, candidate.id === inspection.recommended));
      }
      if (inspection.candidates.length > 12) lines.push(`  … ${inspection.candidates.length - 12} more; use Pi's model configuration to narrow the catalog.`);
    }
  }
  return lines.join("\n");
}

function advisorModelStatusText(config: AdvisorConfig, models: unknown[]): string {
  return inspectAdvisorModels(config, models).map((inspection) => {
    const configured = inspection.configured ?? "auto";
    const selected = inspection.selected ?? "none available";
    const warning = inspection.configured && !inspection.configuredAvailable ? " · WARNING unavailable/auth missing" : "";
    return `${inspection.role}: configured=${configured} · selected=${selected}${warning}`;
  }).join("\n");
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
  let availableModels: unknown[] | undefined;
  const getAvailableModels = (): unknown[] => availableModels ??= available();
  const candidates: ResolvedAdvisorModel[] = [];
  const seen = new Set<string>();

  const tryCandidate = async (found: unknown, id: string, fallback: boolean): Promise<boolean> => {
    if (!found || !isTextModel(found)) return false;
    const candidateId = modelId(found) || id;
    if (!candidateId || seen.has(candidateId)) return false;
    seen.add(candidateId);
    try {
      const auth = await awaitAdvisorWork(ctx.modelRegistry?.getApiKeyAndHeaders(found), signal);
      if (auth?.ok && typeof auth.apiKey === "string" && auth.apiKey) {
        candidates.push({ model: found, auth: { apiKey: auth.apiKey, headers: auth.headers }, label: candidateId, fallback });
        return true;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      appendAdvisorDiagnostic("model_auth_resolution_failed", { model: candidateId, category: "auth_lookup_error" });
    }
    return false;
  };

  if (explicit) {
    const [provider, ...parts] = explicit.split("/");
    await tryCandidate(ctx.modelRegistry?.find?.(provider, parts.join("/")), explicit, false);
  } else {
    const primary = preferred[0];
    const [provider, ...parts] = primary.split("/");
    const found = ctx.modelRegistry?.find?.(provider, parts.join("/"));
    await tryCandidate(found ?? getAvailableModels().find((item) => modelId(item) === primary), primary, false);
  }

  // At most one fallback is attempted. Prefer the same role ranking shown by
  // `model list`; the static preference lookup is only a compatibility path
  // for runtimes whose registry cannot enumerate available models. An
  // explicit override keeps a fallback candidate even when it resolves, so a
  // provider completion failure can still fail over once.
  if ((explicit && candidates.length <= 1) || (!explicit && candidates.length === 0)) {
    // Prefer a static fallback without enumerating the catalog when it is
    // already resolvable. This keeps explicit resolution cheap and preserves
    // compatibility with registries that do not expose model enumeration.
    const staticFallbackId = preferred.find((id) => !seen.has(id));
    if (staticFallbackId) {
      const [provider, ...parts] = staticFallbackId.split("/");
      const staticFallback = ctx.modelRegistry?.find?.(provider, parts.join("/"));
      const hasConfiguredAuth = ctx.modelRegistry?.hasConfiguredAuth;
      const staticAuthConfigured = typeof hasConfiguredAuth === "function" && staticFallback
        ? hasConfiguredAuth.call(ctx.modelRegistry, staticFallback) === true
        : undefined;
      if (staticFallback && staticAuthConfigured !== false) {
        // The static fallback consumes the one fallback attempt, even when
        // request-auth resolution fails. Real registries expose
        // hasConfiguredAuth, allowing an unauthenticated static model to be
        // skipped in favor of an authenticated catalog candidate below.
        await tryCandidate(staticFallback, staticFallbackId, true);
        return candidates;
      }
    }

    let fallback: unknown;
    let fallbackId: string | undefined;
    const ranked = rankAvailableAdvisorModels(role, getAvailableModels());
    const rankedCandidate = ranked.find((item) => !seen.has(item.id));
    if (rankedCandidate) {
      fallbackId = rankedCandidate.id;
      fallback = getAvailableModels().find((item) => modelId(item) === fallbackId);
    }
    if (fallback && fallbackId) await tryCandidate(fallback, fallbackId, true);
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
    // Manual Advisor calls surface the aggregate failure so callers can report it clearly.
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

async function askAdvisor(_pi: ExtensionAPI, ctx: any, question: string, scope: string, includeWork: boolean, signal?: AbortSignal) {
  const config = loadConfig();
  const state = loadState(ctx);
  const normalizedQuestion = sanitizeAdvisorText(question).trim();
  if (!normalizedQuestion) return { text: "Ask a question.", error: "empty" };

  const normalizedScope = sanitizeAdvisorText(scope).replace(/\s+/g, " ").trim().toLowerCase();
  const sessionBrief = includeWork ? brief(state) : "";
  const ck = hash(JSON.stringify({
    version: "advisor-answer-v2",
    model: config.models?.advisor ?? "auto",
    question: normalizedQuestion,
    scope: normalizedScope,
    includeRecentWork: includeWork,
    sessionBrief,
  }));
  const cache = loadCache();
  if (cache[ck]) { state.cacheHits++; saveState(state); return { text: cache[ck], cached: true }; }

  const msgs = [
    { role: "user", content: [
      `Question: ${normalizedQuestion}`,
      normalizedScope ? `Scope: ${normalizedScope}` : "",
      sessionBrief ? `Session:\n${sessionBrief}` : "",
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
  const loopContextHash = advisorLoopContextHash(["question", config.models?.advisor ?? "auto", question, scope, includeWork ? brief(state) : ""]);
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

function lifecycleChangedFiles(tool: unknown): string[] {
  const command = toolCommand(tool);
  const toolName = String(nestedToolValue(tool, ["toolName"]) ?? nestedToolValue(tool, ["name"]) ?? "");
  const mutation = /\b(?:edit|write|patch|apply_patch|create|delete|remove|move|rename|mkdir|touch|cp|mv|rm)\b/i.test(`${toolName} ${command ?? ""}`);
  const values: unknown[] = [
    nestedToolValue(tool, ["changedFiles"]),
    nestedToolValue(tool, ["files"]),
    nestedToolValue(tool, ["result", "changedFiles"]),
  ];
  if (mutation) {
    values.push(
      nestedToolValue(tool, ["path"]),
      nestedToolValue(tool, ["file"]),
      nestedToolValue(tool, ["input", "path"]),
      nestedToolValue(tool, ["args", "path"]),
      nestedToolValue(tool, ["details", "path"]),
      nestedToolValue(tool, ["result", "path"]),
      toolEvidenceText(tool).match(/(?:created|updated|modified|edited|wrote|written|removed|deleted)\s+(?:file\s+)?[`"']?([./A-Za-z0-9_@-]+(?:\/[./A-Za-z0-9_@-]+)*)/gi)?.map((item) => item.replace(/^[^`"']*[`"']/, "").trim()),
    );
  }
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
  const seen = new Set(state.boardEvents.map((event) => event.type === "file_changed"
    ? `${event.type}:${event.path}:${event.turn ?? ""}`
    : `${event.type}:${event.tool}:${event.key}:${event.turn ?? ""}`));
  const unique = events.filter((event) => {
    const key = event.type === "file_changed"
      ? `${event.type}:${event.path}:${event.turn ?? ""}`
      : `${event.type}:${event.tool}:${event.key}:${event.turn ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  state.boardEvents = [...state.boardEvents, ...unique].slice(-MAX_BOARD_EVENTS);
}

function recordBoardWatchIfEnabled(pi: ExtensionAPI, ctx: any, state: SessionState): void {
  const config = loadBoardWatchConfig();
  if (config.mode === "off") return;
  const result = runBoardWatch(config, state.boardWatch, currentBoardLedger(ctx, state), state.turns);
  state.boardWatch = result.state;
  if (result.advice && typeof pi.sendMessage === "function") {
    pi.sendMessage({
      customType: "advisor:board",
      content: result.advice.content,
      display: true,
      details: result.advice.details,
    }, { triggerTurn: false, deliverAs: "nextTurn" });
  }
}

function collectLifecycleEvidence(event: unknown, ctx: any, agentEnd: boolean, pi: ExtensionAPI): void {
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
  state.files = [...new Set([
    ...state.files,
    ...state.boardEvents.filter((entry) => entry.type === "file_changed").map((entry) => entry.path),
  ])].slice(-MAX_FILES);
  observeWorkflowEvidence(state, ctx, agentEnd ? "agent_end" : "turn_end", toolResults, text);
  for (const result of toolResults) {
    const summary = boardEvidenceText(toolEvidenceText(result), 500);
    if (summary && /error|fail|exception/i.test(summary)) state.errors = [...state.errors, summary].slice(-MAX_ERRORS);
  }
  if (agentEnd && text) state.lastTask = text.slice(0, 500);
  recordBoardWatchIfEnabled(pi, ctx, state);
  saveState(state);
  syncCloseoutFacts(ctx, state);
}

// ── Extension entry point ──────────────────────────────────────────────────

export function registerAdvisor(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueAdvisorRegistered) return;
  p.__piRogueAdvisorRegistered = true;

  for (const customType of ["advisor:model", "advisor:rules", "advisor:llm", "advisor:board"] as const) {
    pi.registerMessageRenderer(customType, renderAdvisorHint);
  }

  // Lifecycle is deliberately limited to state ownership. It never resolves a
  // model, completes a prompt, or mutates a system prompt.
  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    closedAdvisorSessions.delete(key);
    abortAdvisorWork(ctx, "superseded");
      saveState(loadState(ctx));
  });
  pi.on("turn_end", (event, ctx) => {
    collectLifecycleEvidence(event, ctx, false, pi);
  });
  pi.on("agent_end", (event, ctx) => {
    collectLifecycleEvidence(event, ctx, true, pi);
  });
  pi.on("agent_settled", (_event, ctx) => {
    syncCloseoutFacts(ctx, loadState(ctx));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    closedAdvisorSessions.add(key);
    abortAdvisorWork(ctx, "session_shutdown");
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
    description: "Pi-Rogue management: status|help|doctor|closeout",
    getArgumentCompletions: (prefix: string) => piRogueArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const rawArg = String(args ?? "").trim();
      const parts = rawArg ? rawArg.split(/\s+/) : [];
      const command = String(parts[0] ?? "").toLowerCase();
      if (command === "closeout") {
        syncCloseoutFacts(ctx, loadState(ctx));
        const action = String(parts[1] ?? "show").toLowerCase();
        if (action === "start") {
          const record = startCloseout(ctx, parts.slice(2).join(" "));
          ctx.ui.notify(`Closeout started for session ${record.session.key}.`, "info");
          return;
        }
        if (action === "add-evidence") {
          const record = addCloseoutEvidence(ctx, parts.slice(2).join(" "));
          ctx.ui.notify(record ? `Evidence reference added (${record.evidence.length}/${24}).` : "No active closeout. Start one with /pi-rogue closeout start [summary].", record ? "info" : "warning");
          return;
        }
        if (action === "record") {
          const next = String(parts[2] ?? "").toLowerCase();
          if (parts.length !== 3 || (next !== "success" && next !== "partial" && next !== "failed" && next !== "abandoned")) {
            ctx.ui.notify("Usage: /pi-rogue closeout record success|partial|failed|abandoned", "error");
            return;
          }
          const record = recordCloseoutStatus(ctx, next);
          ctx.ui.notify(record ? `Closeout recorded as ${record.status}.` : "No active closeout. Start one with /pi-rogue closeout start [summary].", record ? "info" : "warning");
          return;
        }
        if (action === "export") {
          if (parts.length !== 2) {
            ctx.ui.notify("Usage: /pi-rogue closeout export", "error");
            return;
          }
          const exported = exportCloseout(ctx);
          ctx.ui.notify(exported.path ? `Closeout exported to ${exported.path}` : "No active closeout. Start one with /pi-rogue closeout start [summary].", exported.path ? "info" : "warning");
          return;
        }
        if (action !== "show" || parts.length !== 2) {
          ctx.ui.notify("Usage: /pi-rogue closeout start|add-evidence|record|show|export ...", "error");
          return;
        }
        ctx.ui.notify(closeoutText(loadCloseout(ctx)), "info");
        return;
      }
      const config = loadConfig();
      const state = loadState(ctx);
      const text = command === "doctor"
        ? piRogueDoctorText(ctx)
        : command === "help"
          ? "Pi-Rogue commands:\n/pi-rogue status|help|doctor|closeout [start|add-evidence|record|show|export]\n/pi-rogue-advisor status|settings|model [list [advisor|specialist|head]|advisor|specialist|head] <provider>/<model>|null|board ..."
          : piRogueCockpitText(config, state, "", ctx);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("pi-rogue-advisor", {
    description: `Explicit Advisor and Board calls (${ADVISOR_CANONICAL_CONTROL_LEAVES.join("|")}). Usage: /pi-rogue-advisor model list or model <provider>/<model>`,
    getArgumentCompletions: (prefix: string) => advisorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const rawArg = String(args ?? "").trim();
      const parts = rawArg ? rawArg.split(/\s+/) : [];
      const command = String(parts[0] ?? "").toLowerCase();
      const cfg = loadConfig();
      const state = loadState(ctx);

      if (command === "model") {
        const first = String(parts[1] ?? "").toLowerCase();
        if (first === "list") {
          const role = String(parts[2] ?? "").toLowerCase();
          const roleFilter = role === "advisor" || role === "specialist" || role === "head" ? role : undefined;
          if (role && !roleFilter) {
            ctx.ui.notify("Usage: /pi-rogue-advisor model list [advisor|specialist|head]", "error");
            return;
          }
          ctx.ui.notify(advisorModelInspectionText(cfg, availableAdvisorModels(ctx), roleFilter), "info");
          return;
        }
        const slot = first === "advisor" || first === "specialist" || first === "head" ? first : "advisor";
        const value = slot === "advisor" && first !== "advisor" ? String(parts[1] ?? "") : String(parts[2] ?? "");
        const selected = value.trim().toLowerCase() === "null" ? undefined : cleanModelSlot(value);
        if (!selected && value.trim().toLowerCase() !== "null") {
          ctx.ui.notify("Usage: /pi-rogue-advisor model [advisor|specialist|head] <provider>/<model>|null\nOr: /pi-rogue-advisor model list [advisor|specialist|head]", "error");
          return;
        }
        const models = { ...cfg.models };
        if (selected) models[slot] = selected;
        else delete models[slot];
        saveConfig(normalizeAdvisorConfig({ ...cfg, models }));
        const available = selected && availableAdvisorModels(ctx).some((model) => modelId(model) === selected);
        const warning = selected && !available ? " Warning: it is not currently available or authenticated; run `model list` to inspect choices." : "";
        ctx.ui.notify(`${slot} model ${selected ? `set to ${selected}` : "cleared (auto selection restored)"}.${warning}`, selected && !available ? "warning" : "info");
        return;
      }

      if (!rawArg || command === "status" || command === "settings" || command === "config") {
        ctx.ui.notify([
          advisorModelStatusText(cfg, availableAdvisorModels(ctx)),
          `Board: specialists=${cfg.board.specialists}, maxSpecialistCalls=${cfg.board.maxSpecialistCalls}, specialistMaxTokens=${cfg.board.specialistMaxTokens}, headMaxTokens=${cfg.board.headMaxTokens}`,
          `Explicit calls: ${state.advisorCalls} advisor, ${state.specialistDispatch?.calls ?? 0} specialist, ${state.headOfBoard?.calls ?? 0} head`,
          "Use /pi-rogue-advisor model list for role recommendations and available model facts.",
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
        if (area === "watch") {
          const action = String(parts[2] ?? "status").toLowerCase();
          const current = loadBoardWatchConfig();
          if (action === "status") {
            ctx.ui.notify([
              `Board watcher: ${current.mode}`,
              `Runs: ${state.boardWatch.runs}; interventions: ${state.boardWatch.interventions}; suppressed: ${state.boardWatch.suppressed}`,
              `Cooldown: ${current.cooldownTurns} turn(s); max interventions: ${current.maxInterventions}`,
              "Watcher is deterministic and read-only; interventions are non-binding next-turn advice.",
            ].join("\n"), "info");
            return;
          }
          if (action === "off" || action === "shadow" || action === "intervene") {
            saveBoardWatchConfig({ ...current, mode: action });
            ctx.ui.notify(`Board watcher mode set to ${action}.`, "info");
            return;
          }
          ctx.ui.notify("Usage: board watch status|off|shadow|intervene", "error");
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
        ctx.ui.notify("Usage: board watch status|off|shadow|intervene; specialist status|suggest|ask; or head status|ask", "error");
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
