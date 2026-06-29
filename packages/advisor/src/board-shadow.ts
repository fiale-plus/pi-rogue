import { createHash } from "node:crypto";
import { buildBoardLedger, decideBoardAction, type BoardDecision, type BoardEvent, type BoardRisk } from "./board.js";
import { defaultBoardRiskLifecycleState, normalizeBoardRiskLifecycleState, updateBoardRiskLifecycle, type BoardRiskLifecycleState } from "./board-risk-lifecycle.js";

export type BoardShadowMode = "off" | "shadow";

export interface BoardShadowConfig {
  mode: BoardShadowMode;
}

export interface BoardShadowCounters {
  runs: number;
  silent: number;
  ledgerUpdate: number;
  wouldWhisper: number;
  byRisk: Record<string, number>;
  bySeverity: Record<string, number>;
}

export interface BoardShadowState {
  counters: BoardShadowCounters;
  lastAt?: string;
  lastDecision?: BoardDecision;
  lastRiskIds: string[];
  lastRisks: BoardRisk[];
  lastSuppressedRiskIds: string[];
  pendingFiles: string[];
  riskLifecycle: BoardRiskLifecycleState;
  lastTelemetryFingerprint?: string;
  telemetrySuppressedCount: number;
}

export interface BoardTelemetryWritePlan {
  write: boolean;
  fingerprint: string;
  suppressedCount: number;
  reason?: "same-ledger-update";
}

type AdvisorEvidence = {
  kind?: string;
  command?: string;
  result?: string;
  exitCode?: number;
  timestamp?: string;
  details?: string;
};

type AdvisorToolEvidence = {
  role?: string;
  toolName?: string;
  name?: string;
  command?: unknown;
  input?: unknown;
  args?: unknown;
  details?: unknown;
  params?: unknown;
  parameters?: unknown;
  content?: unknown;
  message?: unknown;
  output?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  isError?: boolean;
  error?: unknown;
  exitCode?: unknown;
  exit_code?: unknown;
  code?: unknown;
  status?: unknown;
  result?: unknown;
};

export interface AdvisorBoardStateInput {
  sessionId?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  turns?: number;
  /** Pending changed files carried from earlier shadow turns until green validation clears them. */
  pendingFiles?: string[];
  evidenceLedger?: AdvisorEvidence[];
  toolResults?: AdvisorToolEvidence[];
}

export function defaultBoardShadowConfig(): BoardShadowConfig {
  return { mode: "off" };
}

export function defaultBoardShadowState(): BoardShadowState {
  return {
    counters: {
      runs: 0,
      silent: 0,
      ledgerUpdate: 0,
      wouldWhisper: 0,
      byRisk: {},
      bySeverity: {},
    },
    lastRiskIds: [],
    lastRisks: [],
    lastSuppressedRiskIds: [],
    pendingFiles: [],
    riskLifecycle: defaultBoardRiskLifecycleState(),
    telemetrySuppressedCount: 0,
  };
}

function finiteCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function countRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = finiteCount(raw);
    if (count > 0) out[key] = count;
  }
  return out;
}

export function normalizeBoardShadowState(raw: unknown): BoardShadowState {
  if (!raw || typeof raw !== "object") return defaultBoardShadowState();
  const record = raw as Partial<BoardShadowState>;
  const counters = record.counters ?? defaultBoardShadowState().counters;
  return {
    counters: {
      runs: finiteCount(counters.runs),
      silent: finiteCount(counters.silent),
      ledgerUpdate: finiteCount(counters.ledgerUpdate),
      wouldWhisper: finiteCount(counters.wouldWhisper),
      byRisk: countRecord(counters.byRisk),
      bySeverity: countRecord(counters.bySeverity),
    },
    lastAt: typeof record.lastAt === "string" ? record.lastAt : undefined,
    lastDecision: record.lastDecision,
    lastRiskIds: Array.isArray(record.lastRiskIds) ? record.lastRiskIds.map(String).slice(-16) : [],
    lastRisks: Array.isArray(record.lastRisks) ? record.lastRisks.slice(-8) : [],
    lastSuppressedRiskIds: Array.isArray((record as { lastSuppressedRiskIds?: unknown }).lastSuppressedRiskIds) ? (record as { lastSuppressedRiskIds: unknown[] }).lastSuppressedRiskIds.map(String).slice(-16) : [],
    pendingFiles: Array.isArray((record as { pendingFiles?: unknown }).pendingFiles) ? (record as { pendingFiles: unknown[] }).pendingFiles.map(String).slice(-16) : [],
    riskLifecycle: normalizeBoardRiskLifecycleState((record as { riskLifecycle?: unknown }).riskLifecycle),
    lastTelemetryFingerprint: typeof (record as { lastTelemetryFingerprint?: unknown }).lastTelemetryFingerprint === "string" ? (record as { lastTelemetryFingerprint: string }).lastTelemetryFingerprint : undefined,
    telemetrySuppressedCount: finiteCount((record as { telemetrySuppressedCount?: unknown }).telemetrySuppressedCount),
  };
}

export function normalizeBoardShadowConfig(raw: unknown): BoardShadowConfig {
  if (!raw || typeof raw !== "object") return defaultBoardShadowConfig();
  const mode = (raw as { mode?: unknown }).mode;
  return { mode: mode === "shadow" ? "shadow" : "off" };
}

function validationStatus(result: string | undefined, exitCode: number | undefined): "green" | "red" | "unknown" {
  if (result === "pass" || result === "merged") return "green";
  if (result === "fail" || result === "error" || result === "not_merged") return "red";
  if (exitCode === 0) return "green";
  if (typeof exitCode === "number" && exitCode !== 0) return "red";
  return "unknown";
}

const BOARD_PATH_RE = /(?:^|[\s"'`([{])((?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|sh|css|html))\b/g;
const KEYED_BOARD_PATH_RE = /\b(?:path|file|filePath)\s*[:=]\s*["']?([^"'\s,}]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|sh|css|html))\b/gi;
const COMMON_SECRET_RE = /\b(?:sk|ghp|gho|github_pat|xox[abprs]|hf|AKIA)[-_][A-Za-z0-9_\-]{8,}\b/g;
const AUTH_BEARER_RE = /\bauthorization\b\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const BARE_BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYED_SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;}]{4,}/gi;
const NAMED_SECRET_RE = /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*[^\s"',;}]{4,}/gi;

function redactBoardText(text: string): string {
  return text
    .replace(AUTH_BEARER_RE, (match) => `${match.split(/[:=]/, 1)[0]}=[secret]`)
    .replace(BARE_BEARER_RE, "Bearer [secret]")
    .replace(COMMON_SECRET_RE, "[secret]")
    .replace(KEYED_SECRET_RE, (match) => `${match.split(/[:=]/, 1)[0]}=[secret]`)
    .replace(NAMED_SECRET_RE, (match) => `${match.split(/=/, 1)[0]}=[secret]`);
}

function compactToolText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 3) return "";
  if (typeof value === "string") return redactBoardText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => compactToolText(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(oldText|newText|oldString|newString|old_text|new_text|old_string|new_string|content|stdout|stderr|output|result|error|message|text|transcript|patch|diff)$/i.test(key))
      .map(([key, nested]) => `${key}: ${compactToolText(nested, depth + 1)}`)
      .filter((part) => part.trim() !== `${part.split(":", 1)[0]}:`)
      .join(" ");
  }
  return "";
}

function compactValidationText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 3) return "";
  if (typeof value === "string") return redactBoardText(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => compactValidationText(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map((nested) => compactValidationText(nested, depth + 1)).filter(Boolean).join(" ");
  return "";
}

function isBoardPath(path: string): boolean {
  return path.length <= 240
    && !/^https?:\/\//i.test(path)
    && !path.includes("node_modules")
    && !/[\n\r]/.test(path);
}

function extractBoardPaths(text: string): string[] {
  const found = new Set<string>();
  for (const regex of [BOARD_PATH_RE, KEYED_BOARD_PATH_RE]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const candidate = (match[1] || "").replace(/[)\]};,.]+$/, "");
      if (candidate && isBoardPath(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

function toolName(tool: AdvisorToolEvidence): string {
  return String(tool.toolName || tool.name || "tool").trim() || "tool";
}

function toolDetails(tool: AdvisorToolEvidence): Record<string, unknown> | undefined {
  return tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details as Record<string, unknown> : undefined;
}

function safeDetailText(tool: AdvisorToolEvidence): string {
  const details = toolDetails(tool);
  if (!details) return "";
  const safe: Record<string, unknown> = {};
  for (const key of ["command", "path", "file", "filePath", "args", "params", "parameters", "exitCode", "exit_code"]) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  return compactToolText(safe);
}

function toolExitCode(tool: AdvisorToolEvidence): number | undefined {
  const result = tool.result && typeof tool.result === "object" ? tool.result as { exitCode?: unknown; exit_code?: unknown } : undefined;
  const details = toolDetails(tool);
  for (const candidate of [tool.exitCode, tool.exit_code, tool.code, result?.exitCode, result?.exit_code, details?.exitCode, details?.exit_code]) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function toolStatus(tool: AdvisorToolEvidence): "green" | "red" | undefined {
  const details = toolDetails(tool);
  const resultStatus = tool.result && typeof tool.result === "object" ? (tool.result as { status?: unknown; result?: unknown }).status ?? (tool.result as { status?: unknown; result?: unknown }).result : tool.result;
  const raw = String(tool.status ?? resultStatus ?? details?.status ?? details?.result ?? "").toLowerCase();
  if (/^(success|succeeded|pass|passed|green|ok)$/.test(raw)) return "green";
  if (/^(fail|failed|failure|error|red)$/.test(raw)) return "red";
  return undefined;
}

function isFailedTool(tool: AdvisorToolEvidence): boolean {
  const exitCode = toolExitCode(tool);
  return tool.isError === true || Boolean(tool.error) || (typeof exitCode === "number" && exitCode !== 0);
}

function looksLikeBoardValidation(name: string, text: string): boolean {
  const value = `${name} ${text}`.toLowerCase();
  if (/\btest files?\b[\s\S]{0,80}\b(?:passed|failed)\b/.test(value)) return true;
  if (/\btests?\b[\s\S]{0,80}\b(?:passed|failed)\b/.test(value)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|check|lint|typecheck|build)\b/.test(value)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+run\s+[^\s;&|]*(?:test|check|lint|typecheck|build)[^\s;&|]*/.test(value)) return true;
  if (/\bnpx\s+(?:vitest|jest|tsc|eslint)\b/.test(value)) return true;
  if (/\b(?:vitest|jest)\s+(?:run|--run)\b/.test(value)) return true;
  if (/\btsc(?:\s|$)/.test(value)) return true;
  if (/\beslint\b/.test(value)) return true;
  if (/\bprettier\b[^;&|]*\s--check\b/.test(value)) return true;
  return false;
}

function toolStructuralText(tool: AdvisorToolEvidence): string {
  return compactToolText([tool.command, tool.input, tool.args, tool.params, tool.parameters, safeDetailText(tool)]);
}

function toolFailureSummary(tool: AdvisorToolEvidence, name: string): string {
  const exitCode = toolExitCode(tool);
  const command = toolStructuralText(tool).replace(/\s+/g, " ").trim();
  return [
    `${name} failed`,
    typeof exitCode === "number" ? `exit ${exitCode}` : "",
    command ? truncateSafe(command, 160) : "",
  ].filter(Boolean).join(": ");
}

function truncateSafe(text: string, max: number): string {
  const clean = redactBoardText(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function boardEventsFromToolResults(toolResults: AdvisorToolEvidence[] | undefined, turn: number): BoardEvent[] {
  const tools = toolResults ?? [];
  const events: BoardEvent[] = [];
  for (const [index, tool] of tools.entries()) {
    const toolTurn = turn + ((index + 1) / Math.max(2, tools.length + 1));
    const name = toolName(tool);
    const structuralText = toolStructuralText(tool);
    const validationText = [structuralText, compactValidationText([tool.message, tool.content, tool.output, tool.stdout, tool.stderr])].filter(Boolean).join(" ");
    const exitCode = toolExitCode(tool);
    const status = toolStatus(tool);
    if (/^(edit|write)$/i.test(name)) {
      for (const path of extractBoardPaths(structuralText)) {
        events.push({ type: "file_changed", path, turn: toolTurn });
      }
    }
    if (looksLikeBoardValidation(name, validationText) && (typeof exitCode === "number" || status)) {
      const validationStatus = status ?? (exitCode === 0 ? "green" : "red");
      const validationExitCode = exitCode ?? (validationStatus === "green" ? 0 : 1);
      events.push({
        type: "validation",
        command: truncateSafe(structuralText || name, 240),
        exitCode: validationExitCode,
        status: validationStatus,
        terminal: validationStatus === "green",
        turn: toolTurn,
      });
    }
    if (isFailedTool(tool)) {
      const message = toolFailureSummary(tool, name);
      events.push({ type: "tool_failure", tool: name, key: message.toLowerCase().slice(0, 80), message, turn: toolTurn });
    }
  }
  return events;
}

export function boardEventsFromAdvisorState(input: AdvisorBoardStateInput): BoardEvent[] {
  const events: BoardEvent[] = [{
    type: "session",
    id: input.sessionId || "session",
    repo: input.repo,
    branch: input.branch,
    worktree: input.worktree,
  }];
  const turn = input.turns ?? 0;
  events.push({ type: "turn", turn, progress: false });

  const pendingTurn = Math.max(0, turn);
  for (const file of input.pendingFiles ?? []) {
    events.push({ type: "file_changed", path: file, turn: pendingTurn });
  }

  const evidenceEntries = (input.evidenceLedger ?? []).filter((entry) => entry.kind === "validation" || entry.kind === "merge");
  const evidenceBaseTurn = Math.max(0, turn - evidenceEntries.length);
  for (const [index, entry] of evidenceEntries.entries()) {
    const status = validationStatus(entry.result, entry.exitCode);
    events.push({
      type: "validation",
      command: truncateSafe(String(entry.command || entry.details || entry.kind || "evidence"), 240),
      exitCode: entry.exitCode ?? (status === "green" ? 0 : 1),
      status,
      terminal: status === "green" && (entry.result === "pass" || entry.result === "merged"),
      turn: evidenceBaseTurn + index,
      timestamp: entry.timestamp,
    });
  }

  events.push(...boardEventsFromToolResults(input.toolResults, turn));

  return events;
}

function eventTurn(event: BoardEvent): number {
  return "turn" in event && typeof event.turn === "number" ? event.turn : 0;
}

function pendingFilesAfterEvents(events: BoardEvent[]): string[] {
  const pending = new Set<string>();
  for (const event of [...events].sort((a, b) => eventTurn(a) - eventTurn(b))) {
    if (event.type === "validation" && event.status === "green") {
      pending.clear();
    } else if (event.type === "file_changed") {
      pending.add(event.path);
    }
  }
  return [...pending].slice(-16);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

export function boardTelemetryFingerprint(decision: BoardDecision, risks: BoardRisk[]): string {
  return digest({
    action: decision.action,
    severity: decision.action === "would_whisper" ? decision.severity : undefined,
    riskIds: risks.map((risk) => risk.id).sort(),
    risks: [...risks].sort((a, b) => a.id.localeCompare(b.id)).map((risk) => ({
      id: risk.id,
      type: risk.type,
      severity: risk.severity,
      evidence: risk.evidence,
      evidencePointers: [...risk.evidencePointers].sort(),
    })),
  });
}

export function planBoardTelemetryWrite(previous: BoardShadowState | undefined, decision: BoardDecision, risks: BoardRisk[]): BoardTelemetryWritePlan {
  const fingerprint = boardTelemetryFingerprint(decision, risks);
  const repeatedLedgerUpdate = decision.action === "ledger_update" && previous?.lastTelemetryFingerprint === fingerprint;
  if (repeatedLedgerUpdate) {
    return {
      write: false,
      fingerprint,
      suppressedCount: (previous?.telemetrySuppressedCount ?? 0) + 1,
      reason: "same-ledger-update",
    };
  }
  return { write: true, fingerprint, suppressedCount: 0 };
}

export function applyBoardTelemetryWritePlan(state: BoardShadowState, plan: BoardTelemetryWritePlan): BoardShadowState {
  const next = structuredClone(state);
  next.lastTelemetryFingerprint = plan.fingerprint;
  next.telemetrySuppressedCount = plan.suppressedCount;
  return next;
}

export function updateBoardShadowState(previous: BoardShadowState | undefined, decision: BoardDecision, risks: BoardRisk[], now = new Date(), pendingFiles?: string[], riskLifecycle?: BoardRiskLifecycleState, suppressedRiskIds?: string[]): BoardShadowState {
  const next = previous ? structuredClone(previous) : defaultBoardShadowState();
  next.pendingFiles = pendingFiles ?? next.pendingFiles ?? [];
  next.counters.runs += 1;
  if (decision.action === "silent") next.counters.silent += 1;
  if (decision.action === "ledger_update") next.counters.ledgerUpdate += 1;
  if (decision.action === "would_whisper") next.counters.wouldWhisper += 1;
  for (const risk of risks) {
    next.counters.byRisk[risk.type] = (next.counters.byRisk[risk.type] ?? 0) + 1;
    next.counters.bySeverity[risk.severity] = (next.counters.bySeverity[risk.severity] ?? 0) + 1;
  }
  next.lastAt = now.toISOString();
  next.lastDecision = decision;
  next.lastRiskIds = risks.map((risk) => risk.id);
  next.lastRisks = risks.slice(0, 8);
  next.lastSuppressedRiskIds = suppressedRiskIds ?? next.lastSuppressedRiskIds ?? [];
  next.riskLifecycle = riskLifecycle ?? next.riskLifecycle ?? defaultBoardRiskLifecycleState();
  return next;
}

export function runBoardShadowDecision(input: AdvisorBoardStateInput, previous?: BoardShadowState, now = new Date()): { events: BoardEvent[]; risks: BoardRisk[]; decision: BoardDecision; state: BoardShadowState } {
  const events = boardEventsFromAdvisorState({ ...input, pendingFiles: input.pendingFiles ?? previous?.pendingFiles });
  const ledger = buildBoardLedger(events);
  const lifecycle = updateBoardRiskLifecycle(previous?.riskLifecycle, ledger, ledger.risks);
  let decision: BoardDecision;
  if (lifecycle.visibleRisks.length > 0) {
    decision = decideBoardAction({ ...ledger, risks: lifecycle.visibleRisks });
  } else if (ledger.risks.length > 0) {
    decision = { action: "ledger_update", riskIds: ledger.risks.map((risk) => risk.id) };
  } else {
    decision = { action: "silent" };
  }
  return { events, risks: ledger.risks, decision, state: updateBoardShadowState(previous, decision, ledger.risks, now, pendingFilesAfterEvents(events), lifecycle.state, lifecycle.suppressedRiskIds) };
}

export function formatBoardShadowStatus(config: BoardShadowConfig, state?: BoardShadowState): string {
  const s = state ?? defaultBoardShadowState();
  const last = s.lastDecision ? `${s.lastDecision.action}${s.lastDecision.action === "would_whisper" ? `:${s.lastDecision.severity}` : ""}` : "none";
  const riskCounts = Object.entries(s.counters.byRisk).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
  return [
    `Board shadow: ${config.mode}`,
    `Runs: ${s.counters.runs} | Silent: ${s.counters.silent} | Ledger updates: ${s.counters.ledgerUpdate} | Would whisper: ${s.counters.wouldWhisper}`,
    `Last decision: ${last}${s.lastAt ? ` at ${s.lastAt}` : ""}`,
    `Risk counts: ${riskCounts}`,
    "Phase 1: no model calls, no specialists, no head-of-board, no live whispers, no steer.",
  ].join("\n");
}
