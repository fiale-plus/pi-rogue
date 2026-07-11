import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { BoundedContextBroker, ContextArtifact } from "@fiale-plus/pi-core";
import { createFileContextBroker } from "./file.js";
import { createInMemoryContextBroker } from "./index.js";

export interface ContextBrokerBetaOptions {
  enabled?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  globalMaxRecords?: number;
  globalMaxBytes?: number;
  briefBytes?: number;
  lookupBytes?: number;
  searchBytes?: number;
  rewriteThresholdBytes?: number;
  hotToWarmMs?: number;
  warmToColdMs?: number;
  durable?: boolean;
  storeDir?: string;
  contextLensesEnabled?: boolean;
}

type UiLike = { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus?(key: string, text: string | undefined): void };
type SessionContextLike = Pick<ExtensionContext, "cwd" | "sessionManager"> & { ui: UiLike };

const DEFAULT_BRIEF_BYTES = 1_800;
const DEFAULT_LOOKUP_BYTES = 12_000;
const DEFAULT_SEARCH_BYTES = 2_000;
const DEFAULT_REWRITE_THRESHOLD_BYTES = 8 * 1024;
const MIN_REWRITE_THRESHOLD_BYTES = 2 * 1024;
const REWRITE_THRESHOLD_ENV = "PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES";
const CONTEXT_LENSES_ENABLED_ENV = "PI_CONTEXT_BROKER_CONTEXT_LENSES_ENABLED";
const REWRITE_THRESHOLD_PRESETS = [2 * 1024, 4 * 1024, 8 * 1024, 16 * 1024, 32 * 1024];
const LOG_ERROR_LENS_MAX_BYTES = 4 * 1024;
const PACKAGE_LENS_MAX_BYTES = 2 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_TO_WARM_MS = 2 * 60 * 60 * 1000;
const DEFAULT_WARM_TO_COLD_MS = 12 * 60 * 60 * 1000;
const DEFAULT_DURABLE_GLOBAL_MAX_RECORDS = 2_048;
const DEFAULT_DURABLE_GLOBAL_MAX_BYTES = 256 * 1024 * 1024;
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultDurableStoreDir(): string {
  return join(homedir(), ".pi", "agent", "fiale-plus", "context-broker");
}

function sqliteStorePath(storeDir?: string): string {
  return join(storeDir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR ?? defaultDurableStoreDir(), "artifacts.sqlite");
}

function sqliteRecoveryStamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function quarantineSqliteArtifacts(dbPath: string): string[] {
  const stamp = sqliteRecoveryStamp();
  const backups: string[] = [];
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(candidate)) continue;
    const backupPath = `${candidate}.recovered-${stamp}`;
    try {
      renameSync(candidate, backupPath);
      backups.push(backupPath);
    } catch (error) {
      console.warn("Context broker SQLite recovery could not move aside file", candidate, error);
    }
  }
  return backups;
}

function sqliteRecoveryNotice(mode: "repaired" | "degraded", dbPath: string, backups: string[], initialError: unknown, retryError?: unknown): string {
  const backupText = backups.length ? ` Backups: ${backups.map((path) => basename(path)).join(", ")}.` : "";
  if (mode === "repaired") {
    return `Context broker durability repaired after SQLite store failure at ${dbPath}: ${errorMessage(initialError)}. Starting with a fresh SQLite store.${backupText}`;
  }
  const retryText = retryError ? ` Retry failed: ${errorMessage(retryError)}.` : "";
  return `Context broker durability degraded after SQLite store failure at ${dbPath}: ${errorMessage(initialError)}.${retryText} Continuing with in-memory broker.${backupText}`;
}

function envFlag(name: string): boolean {
  return ENABLED_VALUES.has(String(process.env[name] ?? "").trim().toLowerCase());
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBooleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

function envNonNegativeInt(name: string): number | undefined {
  return parseNonNegativeInt(process.env[name]);
}

function clampRewriteThresholdBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(MIN_REWRITE_THRESHOLD_BYTES, value);
}

function contextBrokerConfigPath(_ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }): string {
  return join(homedir(), ".pi", "agent", "pi-rogue", "context-broker", "config.json");
}

function loadConfiguredContextBrokerConfig(ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }): { rewriteThresholdBytes?: number; contextLensesEnabled?: boolean } {
  const path = contextBrokerConfigPath(ctx);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      rewriteThresholdBytes?: unknown;
      rewrite_threshold_bytes?: unknown;
      contextLensesEnabled?: unknown;
      context_lenses_enabled?: unknown;
    };
    const rewriteThresholdBytes = clampRewriteThresholdBytes(
      parseNonNegativeInt(parsed.rewriteThresholdBytes ?? parsed.rewrite_threshold_bytes),
    );
    const contextLensesEnabled = parseBooleanish(parsed.contextLensesEnabled ?? parsed.context_lenses_enabled);
    return {
      ...(rewriteThresholdBytes === undefined ? {} : { rewriteThresholdBytes }),
      ...(contextLensesEnabled === undefined ? {} : { contextLensesEnabled }),
    };
  } catch {
    return {};
  }
}

function saveConfiguredRewriteThresholdBytes(ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }, value: number): string {
  const path = contextBrokerConfigPath(ctx);
  const existing = loadConfiguredContextBrokerConfig(ctx);
  const next = {
    ...existing,
    rewriteThresholdBytes: value,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

function saveConfiguredContextLensesEnabled(ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }, value: boolean): string {
  const path = contextBrokerConfigPath(ctx);
  const existing = loadConfiguredContextBrokerConfig(ctx);
  const next = {
    ...existing,
    contextLensesEnabled: value,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

function isEnvEnabled(): boolean {
  return envFlag("PI_CONTEXT_BROKER_ENABLED");
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|credential)/i.test(key);
}

function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/([\"']?(?:api[_-]?key|token|secret|password|credential)[\w.-]*[\"']?\s*[:=]\s*[\"']?)([^\s'\",;}]+)/gi, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value == null || typeof value !== "object") return value;
  if (depth > 6) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1),
  ]));
}

function toText(value: unknown): string {
  if (typeof value === "string") return redactSecrets(value);
  try {
    return redactSecrets(JSON.stringify(value, null, 2));
  } catch {
    return redactSecrets(String(value ?? ""));
  }
}

function sanitizeForPrompt(text: string): string {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function isHostilePayload(payload: string): boolean {
  return hasHostileText(payload);
}

function isOpaquePayload(payload: string): boolean {
  return hasOpaqueText(payload);
}

function hasOpaqueText(text: string): boolean {
  const value = String(text ?? "");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 4096) return false;

  const compacted = value.replace(/\s+/g, "");
  if (compacted.length >= 4096 && /^[A-Za-z0-9+/=_-]+$/.test(compacted) && compacted.length / Math.max(1, value.length) > 0.85) return true;
  if (/\b(?:[A-Fa-f0-9]{2}){2048,}\b/.test(value)) return true;

  const lines = value.split(/\r?\n/);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const whitespace = (value.match(/\s/g) ?? []).length;
  const whitespaceRatio = whitespace / Math.max(1, value.length);
  if (longestLine >= 4096 && whitespaceRatio < 0.03) return true;
  if (longestLine >= 2048 && whitespaceRatio < 0.02 && /[{};:,]/.test(value)) return true;
  return false;
}

function hasHostileText(text: string): boolean {
  let suspicious = 0;
  let scanned = 0;
  for (const char of text.slice(0, 4096)) {
    const code = char.codePointAt(0) ?? 0;
    scanned += 1;
    if (
      code === 0x00
      || (code >= 0x01 && code <= 0x08)
      || (code >= 0x0E && code <= 0x1F)
      || (code >= 0x7F && code <= 0x9F)
    ) {
      suspicious += 1;
    }
  }
  if (scanned < 12) return suspicious > 0;
  return suspicious / scanned >= 0.05;
}

function hasHostileValue(value: unknown): boolean {
  if (typeof value === "string") return hasHostileText(value);
  if (Array.isArray(value)) return value.some(hasHostileValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => hasHostileValue(entry));
  }
  return false;
}

function hasOpaqueValue(value: unknown): boolean {
  if (typeof value === "string") return hasOpaqueText(value);
  if (Array.isArray(value)) return value.some(hasOpaqueValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => hasOpaqueValue(entry));
  }
  return false;
}

function renderLookupOutput(item: ContextArtifact, payloadLimit: number): string {
  const isBinary = item.tags.includes("hostile") || item.tags.includes("binary");
  const isOpaque = item.tags.includes("opaque");
  const payloadLines = isBinary || isOpaque
    ? [
      "payload:",
      isOpaque && !isBinary
        ? "[payload omitted from prompt because it appears opaque/high-token; use /pi-rogue-context export"
        : "[payload intentionally omitted from prompt for safety; use /pi-rogue-context export",
      sanitizeForPrompt(item.handle),
      "for full content]",
    ]
    : [
      "payload:",
      truncateUtf8(sanitizeForPrompt(item.payload), payloadLimit),
    ];

  return [
    sanitizeForPrompt(item.handle),
    `tier=${item.tier} kind=${item.kind} bytes=${item.bytes}`,
    `summary=${sanitizeForPrompt(item.summary)}`,
    ...payloadLines,
  ].join("\n");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;
  if (limit === 0) return "";

  let omittedBytes = totalBytes;
  let result = "";
  let marker = "…";

  for (let pass = 0; pass < 4; pass += 1) {
    const verboseMarker = `\n[truncated: omitted ${omittedBytes} bytes]`;
    marker = Buffer.byteLength(verboseMarker, "utf8") < limit ? verboseMarker : "…";
    const contentLimit = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
    let used = 0;
    let prefix = "";

    for (const char of text) {
      const bytes = Buffer.byteLength(char, "utf8");
      if (used + bytes > contentLimit) break;
      prefix += char;
      used += bytes;
    }

    result = prefix;
    const nextOmittedBytes = totalBytes - used;
    if (nextOmittedBytes === omittedBytes) break;
    omittedBytes = nextOmittedBytes;
  }

  return `${result}${marker}`;
}

function compact(value: string, max = 120): string {
  return truncateUtf8(value.replace(/\s+/g, " ").trim(), max);
}

function capText(value: number): string {
  return Number.isFinite(value) ? String(value) : "unbounded";
}

function lookupMissMessage(exact: boolean): string {
  return exact
    ? "No context artifact matched that exact handle. The artifact may be missing, expired, pruned, or from a non-durable prior session."
    : "No context artifacts matched that text/filter query. Try an exact ctx:// handle, narrower path/tag/kind/tier filters, or a more specific search term.";
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function promptPayloadBytes(message: any): number {
  if (message?.role === "bashExecution") return utf8Bytes(String(message.output ?? ""));
  if (message?.role === "toolResult") return utf8Bytes(contentText(message.content));
  return utf8Bytes(toText(message));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sessionIdFor(ctx: Partial<SessionContextLike>): string {
  const file = ctx.sessionManager?.getSessionFile?.();
  return file || ctx.cwd || process.cwd();
}

function messageTimestamp(entry: any): number | undefined {
  const value = entry?.message?.timestamp ?? entry?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((block) => block?.type === "text" ? block.text : toText(block)).join("\n");
  }
  return toText(content);
}

function toolPayload(event: { toolName: string; input?: unknown; content?: unknown; details?: unknown; isError?: boolean }): string {
  return [
    `tool=${event.toolName}`,
    `isError=${Boolean(event.isError)}`,
    "input:",
    toText(event.input),
    "content:",
    toText(event.content),
    "details:",
    toText(event.details),
  ].join("\n");
}

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

function brokerPlaceholder(artifact: ContextArtifact): string {
  return [
    `Context broker artifact: ${artifact.handle}`,
    `Summary: ${artifact.summary}`,
    `Payload bytes: ${artifact.bytes}`,
    `Raw payload omitted from prompt. For exact evidence, call context_lookup with { "handle": "${artifact.handle}" }.`,
    `Human/TUI command: /pi-rogue-context lookup ${artifact.handle}`,
  ].join("\n");
}

function contextLookupHistoryPlaceholder(): string {
  return [
    "Context lookup result omitted from prompt.",
    "Prior context_lookup evidence is terminal and is not re-brokered.",
    "Run context_lookup again with a focused handle/filter only if exact evidence is still needed.",
  ].join("\n");
}

function prunedPayloadPlaceholder(hostile = false): string {
  return [
    "Context broker artifact pruned before prompt assembly.",
    hostile ? "Raw hostile/binary payload omitted from prompt for safety." : "Raw payload omitted from prompt to avoid restoring pruned broker evidence.",
    "Re-run the originating command or use a retained ctx:// handle if exact evidence is still needed.",
  ].join("\n");
}

function summarizeTool(event: { toolName: string; input?: any; isError?: boolean }, bytes: number, hostile = false): string {
  const command = event.toolName === "bash" ? event.input?.command : undefined;
  const path = event.input?.path;
  const target = command ? ` command=${compact(String(command), 120)}` : path ? ` path=${path}` : "";
  const marker = hostile ? "; payload marked hostile; use /pi-rogue-context export for full content" : "";
  return `${event.isError ? "failed" : "completed"} ${event.toolName}${target}; payload=${bytes} bytes${marker}`;
}

function isPackageManagerCommand(command = ""): boolean {
  return /(^|[^a-z])(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade|remove|rm|ci|build|rebuild)\b/i.test(command);
}

function extractContextLens(
  text: string,
  options: { toolName?: string; command?: string; path?: string; isError?: boolean; exitCode?: number; }
): { kind: "log" | "package"; summary: string; body: string; maxBytes: number } | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const command = String(options.command ?? "");
  if (isPackageManagerCommand(command) && (Boolean(options.isError) || options.exitCode !== undefined && options.exitCode !== 0)) {
    const lines = normalized.split("\n");
    const interesting = lines.filter((line) => /(error|warning|warn|conflict|failed|unable to|unable|ER[0-9]{4}|pnpm ERR!|npm ERR!|yarn error|bun:|peer dep|dependency|resolve)/i.test(line));
    const body = (interesting.length > 0 ? interesting : lines.filter((line) => line.trim()).slice(0, 24)).join("\n").trim();
    if (!body) return null;
    return {
      kind: "package",
      summary: `package-manager failure/diagnostic for ${compact(command, 80)}`,
      body,
      maxBytes: PACKAGE_LENS_MAX_BYTES,
    };
  }

  const lines = normalized.split("\n");
  const hasErrors = lines.some((line) => /(fatal|exception|traceback|stack|error|failed|panic|segfault|undefined|cannot|unable to)/i.test(line));
  if (!hasErrors) return null;
  if (!/\.log$|\.err$|^\/var\/log\//i.test(String(options.path ?? command))) {
    const likelyPackageOutput = /npm|pnpm|yarn|bun/i.test(command);
    if (!likelyPackageOutput) return null;
  }

  const matches = lines.filter((line) => /(fatal|exception|traceback|stack|error|failed|panic|segfault|undefined|unable to)/i.test(line));
  const body = matches.slice(0, 12).join("\n").trim();
  if (!body) return null;
  return {
    kind: "log",
    summary: `log/error signature from ${compact(command || (options.path ? String(options.path) : options.toolName ?? "tool output"), 80)}`,
    body,
    maxBytes: LOG_ERROR_LENS_MAX_BYTES,
  };
}

function contextLensPlaceholder(artifact: ContextArtifact, lens: { kind: "log" | "package"; summary: string; body: string; maxBytes: number }, commandOrPath = ""): string {
  const header = lens.kind === "package" ? "Package-manager lens" : "Log/error lens";
  const source = commandOrPath ? `source=${compact(commandOrPath, 140)}` : `source=tool=${artifact.summary}`;
  return [
    `Context broker lens (${header}):`,
    `Context broker artifact: ${artifact.handle}`,
    `Summary: ${lens.summary}`,
    `Payload bytes: ${artifact.bytes}`,
    `${source}`,
    `Lens view (max ${lens.maxBytes} bytes):`,
    truncateUtf8(lens.body, lens.maxBytes),
  ].join("\n");
}

const NON_BROKERED_TOOL_NAMES = new Set(["context_lookup"]);

function shouldBrokerToolName(toolName: string): boolean {
  return !NON_BROKERED_TOOL_NAMES.has(toolName);
}

function ttlFromNowFor(createdAt: number | undefined): number | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  return Math.max(DEFAULT_TTL_MS, Date.now() - createdAt + DEFAULT_TTL_MS);
}


function isNeverBrokeredToolName(toolName: unknown): boolean {
  return toolName === "advisor";
}

function isNeverBrokeredToolMessage(message: unknown): boolean {
  if (message == null || typeof message !== "object") return false;
  const maybe = message as { toolName?: unknown };
  return isNeverBrokeredToolName(maybe.toolName);
}

async function createDurableContextBroker(
  durable: boolean,
  durableBackend: string,
  brokerOptions: Parameters<typeof createInMemoryContextBroker>[0],
  storeDir: string | undefined,
): Promise<{ broker: BoundedContextBroker; startupNotice?: string }> {
  if (!durable) {
    return { broker: createInMemoryContextBroker(brokerOptions) };
  }

  const durableStoreDir = storeDir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR;
  if (durableBackend === "jsonl") {
    try {
      return { broker: createFileContextBroker({ ...brokerOptions, dir: durableStoreDir }) };
    } catch (error) {
      console.warn("Context broker durable file store failed to initialize; continuing with in-memory broker.", error);
      return {
        broker: createInMemoryContextBroker(brokerOptions),
        startupNotice: `Context broker durability degraded after durable file store failure: ${errorMessage(error)}. Continuing with in-memory broker.`,
      };
    }
  }

  const sqliteStore = sqliteStorePath(durableStoreDir);
  let sqliteModule: typeof import("./sqlite.js") | undefined;
  try {
    sqliteModule = await import("./sqlite.js");
  } catch (error) {
    console.warn("Context broker SQLite module failed to load; continuing with in-memory broker.", error);
    return {
      broker: createInMemoryContextBroker(brokerOptions),
      startupNotice: `Context broker durability degraded because SQLite support could not load: ${errorMessage(error)}. Continuing with in-memory broker.`,
    };
  }

  try {
    return {
      broker: sqliteModule.createSqliteContextBroker({ ...brokerOptions, dir: durableStoreDir }),
    };
  } catch (initialError) {
    if (sqliteModule.isSqliteLockedError(initialError)) {
      console.warn("Context broker SQLite store is locked; preserving the durable store and continuing in memory.", initialError, { sqliteStore });
      return {
        broker: createInMemoryContextBroker(brokerOptions),
        startupNotice: `Context broker durability temporarily degraded because the SQLite store is locked at ${sqliteStore}: ${errorMessage(initialError)}. Store files were preserved; continuing with in-memory broker for this session.`,
      };
    }
    if (!sqliteModule.isSqliteCorruptionError(initialError)) {
      console.warn("Context broker SQLite initialization failed without evidence of corruption; preserving the durable store.", initialError, { sqliteStore });
      return {
        broker: createInMemoryContextBroker(brokerOptions),
        startupNotice: `Context broker durability degraded after a non-corruption SQLite startup failure at ${sqliteStore}: ${errorMessage(initialError)}. Store files were preserved; continuing with in-memory broker.`,
      };
    }

    const backups = quarantineSqliteArtifacts(sqliteStore);
    console.warn("Context broker SQLite corruption detected; attempting recovery.", initialError, { sqliteStore, backups });
    try {
      const broker = sqliteModule.createSqliteContextBroker({ ...brokerOptions, dir: durableStoreDir });
      return {
        broker,
        startupNotice: sqliteRecoveryNotice("repaired", sqliteStore, backups, initialError),
      };
    } catch (retryError) {
      console.warn("Context broker SQLite recovery failed; switching to in-memory broker without another quarantine.", retryError, { sqliteStore, backups });
      return {
        broker: createInMemoryContextBroker(brokerOptions),
        startupNotice: sqliteRecoveryNotice("degraded", sqliteStore, backups, initialError, retryError),
      };
    }
  }
}

export async function registerContextBrokerBeta(pi: ExtensionAPI, options: ContextBrokerBetaOptions = {}): Promise<void> {
  const p = pi as any;
  if (p.__piRogueContextBrokerBetaRegistered) return;
  p.__piRogueContextBrokerBetaRegistered = true;

  const briefBytes = options.briefBytes ?? DEFAULT_BRIEF_BYTES;
  const lookupBytes = options.lookupBytes ?? DEFAULT_LOOKUP_BYTES;
  const searchBytes = options.searchBytes ?? DEFAULT_SEARCH_BYTES;
  const rewriteThresholdOption = options.rewriteThresholdBytes;
  const rewriteThresholdEnv = clampRewriteThresholdBytes(envNonNegativeInt(REWRITE_THRESHOLD_ENV));
  const resolvedConfig = loadConfiguredContextBrokerConfig({ cwd: process.cwd() });
  const rewriteThresholdConfigured = resolvedConfig.rewriteThresholdBytes;
  const lensesEnabledOption = options.contextLensesEnabled;
  const lensesEnabledEnv = parseBooleanish(process.env[CONTEXT_LENSES_ENABLED_ENV]);
  const lensesEnabledConfigured = resolvedConfig.contextLensesEnabled;
  let rewriteThresholdBytes =
    rewriteThresholdOption
    ?? rewriteThresholdEnv
    ?? rewriteThresholdConfigured
    ?? DEFAULT_REWRITE_THRESHOLD_BYTES;
  let rewriteThresholdSource = rewriteThresholdOption !== undefined
    ? "option"
    : rewriteThresholdEnv !== undefined
      ? "env"
      : rewriteThresholdConfigured !== undefined
        ? "config"
        : "default";
  let contextLensesEnabled = lensesEnabledOption ?? lensesEnabledEnv ?? lensesEnabledConfigured ?? false;
  let contextLensesSource = lensesEnabledOption !== undefined
    ? "option"
    : lensesEnabledEnv !== undefined
      ? "env"
      : lensesEnabledConfigured !== undefined
        ? "config"
        : "default";
  const durable = options.durable ?? (envFlag("PI_CONTEXT_BROKER_DURABLE") || Boolean(options.storeDir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR));
  const brokerOptions = {
    maxRecords: options.maxRecords ?? 64,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    globalMaxRecords: options.globalMaxRecords ?? envNonNegativeInt("PI_CONTEXT_BROKER_GLOBAL_MAX_RECORDS") ?? (durable ? DEFAULT_DURABLE_GLOBAL_MAX_RECORDS : undefined),
    globalMaxBytes: options.globalMaxBytes ?? envNonNegativeInt("PI_CONTEXT_BROKER_GLOBAL_MAX_BYTES") ?? (durable ? DEFAULT_DURABLE_GLOBAL_MAX_BYTES : undefined),
    hotToWarmMs: options.hotToWarmMs ?? envNonNegativeInt("PI_CONTEXT_BROKER_HOT_TO_WARM_MS") ?? DEFAULT_HOT_TO_WARM_MS,
    warmToColdMs: options.warmToColdMs ?? envNonNegativeInt("PI_CONTEXT_BROKER_WARM_TO_COLD_MS") ?? DEFAULT_WARM_TO_COLD_MS,
    briefBytes,
  };
  const durableBackend = String(process.env.PI_CONTEXT_BROKER_BACKEND ?? "sqlite").trim().toLowerCase();
  let broker: BoundedContextBroker;
  let startupNotice: string | undefined;
  if (durable) {
    const durableResult = await createDurableContextBroker(
      durable,
      durableBackend,
      brokerOptions,
      options.storeDir,
    );
    broker = durableResult.broker;
    startupNotice = durableResult.startupNotice;
  } else {
    broker = createInMemoryContextBroker(brokerOptions);
  }

  const seenSourceIds = new Set<string>();
  const sourceHandles = new Map<string, string>();
  let activeSessionId = process.cwd();
  const routingTelemetry = {
    contextHookCalls: 0,
    contextHookToolResults: 0,
    contextHookToolResultRewrites: 0,
    contextHookToolResultHostile: 0,
    contextHookBash: 0,
    contextHookBashRewrites: 0,
    contextHookBashHostile: 0,
    contextHookRewriteRawBytes: 0,
    contextHookRewriteReplacementBytes: 0,
    contextHookContextLookupHistoryOmissions: 0,
    contextLensHits: 0,
    contextLensMisses: 0,
    contextLensFallbacks: 0,
    contextLensEmittedBytes: 0,
    toolResultEvents: 0,
    toolResultArtifacts: 0,
    backfillScans: 0,
    backfillAdded: 0,
    backfillErrors: 0,
    toolLookupCalls: 0,
    toolLookupExactCalls: 0,
    toolLookupTextCalls: 0,
    toolLookupHits: 0,
    toolLookupMisses: 0,
    toolLookupExactMisses: 0,
    toolLookupTextMisses: 0,
    commandLookupCalls: 0,
    commandLookupExactCalls: 0,
    commandLookupTextCalls: 0,
    commandLookupHits: 0,
    commandLookupMisses: 0,
    commandLookupExactMisses: 0,
    commandLookupTextMisses: 0,
    exportCalls: 0,
    pinCalls: 0,
    statusCalls: 0,
    pruneCalls: 0,
    runtimePublishFailures: 0,
  };
  let unreportedPublishFailures = 0;
  let lastPublishFailureNoticeAt = 0;
  let lastPublishFailureKind = "unavailable";

  function recordPublishFailure(error: unknown): void {
    routingTelemetry.runtimePublishFailures += 1;
    unreportedPublishFailures += 1;
    lastPublishFailureKind = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(errorMessage(error)) ? "locked" : "unavailable";
  }

  function safeBrokerLookup(query: Parameters<typeof broker.lookup>[0]): ContextArtifact[] | null {
    try {
      return broker.lookup(query);
    } catch (error) {
      recordPublishFailure(error);
      return null;
    }
  }

  function notifyPublishFailure(ctx: { ui: UiLike }): void {
    if (unreportedPublishFailures <= 0) return;
    const now = Date.now();
    if (lastPublishFailureNoticeAt > 0 && now - lastPublishFailureNoticeAt < 60_000) return;
    const count = unreportedPublishFailures;
    unreportedPublishFailures = 0;
    lastPublishFailureNoticeAt = now;
    ctx.ui.notify(
      `Context broker durability ${lastPublishFailureKind}; preserved original tool/context flow (${count} publish failure${count === 1 ? "" : "s"}).`,
      "warning",
    );
  }

  function refreshRewriteThresholdFromConfig(ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }): void {
    if (rewriteThresholdOption !== undefined || rewriteThresholdEnv !== undefined) return;
    const configured = loadConfiguredContextBrokerConfig(ctx).rewriteThresholdBytes;
    rewriteThresholdBytes = configured ?? DEFAULT_REWRITE_THRESHOLD_BYTES;
    rewriteThresholdSource = configured !== undefined ? "config" : "default";
    if (lensesEnabledOption === undefined && lensesEnabledEnv === undefined) {
      const lensesConfigured = loadConfiguredContextBrokerConfig(ctx).contextLensesEnabled;
      contextLensesEnabled = lensesConfigured ?? false;
      contextLensesSource = lensesConfigured !== undefined ? "config" : "default";
    }
  }

  function formatContextBrokerConfig(ctx: Pick<ExtensionContext, "cwd"> | { cwd?: unknown }): string {
    return [
      `Context broker config: rewriteThresholdBytes=${rewriteThresholdBytes} (source=${rewriteThresholdSource})`,
      `Context lenses: ${contextLensesEnabled ? "on" : "off"} (source=${contextLensesSource})`,
      `config: ${contextBrokerConfigPath(ctx)}`,
      `env override: ${REWRITE_THRESHOLD_ENV}, ${CONTEXT_LENSES_ENABLED_ENV}`,
    ].join("\n");
  }

  function recordContextRewrite(rawBytes: number, replacementBytes: number): void {
    routingTelemetry.contextHookRewriteRawBytes += Math.max(0, rawBytes);
    routingTelemetry.contextHookRewriteReplacementBytes += Math.max(0, replacementBytes);
  }

  function formatRoutingTelemetry(): string {
    const savedBytes = Math.max(0, routingTelemetry.contextHookRewriteRawBytes - routingTelemetry.contextHookRewriteReplacementBytes);
    const savedPct = routingTelemetry.contextHookRewriteRawBytes > 0
      ? ((savedBytes / routingTelemetry.contextHookRewriteRawBytes) * 100).toFixed(1)
      : "0.0";
    const line = [
      `contextHook calls=${routingTelemetry.contextHookCalls}`,
      `toolResults seen=${routingTelemetry.contextHookToolResults} rewritten=${routingTelemetry.contextHookToolResultRewrites} hostile=${routingTelemetry.contextHookToolResultHostile}`,
      `bash seen=${routingTelemetry.contextHookBash} rewritten=${routingTelemetry.contextHookBashRewrites} hostile=${routingTelemetry.contextHookBashHostile}`,
      `rewriteSavings rawBytes=${routingTelemetry.contextHookRewriteRawBytes} replacementBytes=${routingTelemetry.contextHookRewriteReplacementBytes} savedBytes=${savedBytes} savedPct=${savedPct}% contextLookupHistoryOmitted=${routingTelemetry.contextHookContextLookupHistoryOmissions}`,
      `contextLenses hits=${routingTelemetry.contextLensHits} misses=${routingTelemetry.contextLensMisses} fallbacks=${routingTelemetry.contextLensFallbacks} emittedBytes=${routingTelemetry.contextLensEmittedBytes}`,
      `lookups tool(calls=${routingTelemetry.toolLookupCalls}, exact=${routingTelemetry.toolLookupExactCalls}, text=${routingTelemetry.toolLookupTextCalls}, hits=${routingTelemetry.toolLookupHits}, misses=${routingTelemetry.toolLookupMisses}, exactMisses=${routingTelemetry.toolLookupExactMisses}, textMisses=${routingTelemetry.toolLookupTextMisses})`,
      `lookups slash(calls=${routingTelemetry.commandLookupCalls}, exact=${routingTelemetry.commandLookupExactCalls}, text=${routingTelemetry.commandLookupTextCalls}, hits=${routingTelemetry.commandLookupHits}, misses=${routingTelemetry.commandLookupMisses}, exactMisses=${routingTelemetry.commandLookupExactMisses}, textMisses=${routingTelemetry.commandLookupTextMisses})`,
      `exports=${routingTelemetry.exportCalls}`,
      `pins=${routingTelemetry.pinCalls}`,
      `pruneCalls=${routingTelemetry.pruneCalls}`,
      `runtimePublishFailures=${routingTelemetry.runtimePublishFailures}`,
      `backfill scans=${routingTelemetry.backfillScans} added=${routingTelemetry.backfillAdded} errors=${routingTelemetry.backfillErrors}`,
    ];
    return `Context broker routing telemetry: ${line.join(", ")}`;
  }

  function publishToolArtifact(event: {
    toolName: string;
    input?: any;
    content?: unknown;
    details?: unknown;
    isError?: boolean;
    sourceId?: string;
    createdAt?: number;
    ttlMs?: number;
  }): ContextArtifact | null {
    if (!shouldBrokerToolName(event.toolName)) return null;

    if (event.sourceId) {
      const existingHandle = sourceHandles.get(event.sourceId);
      if (existingHandle) {
        const matches = safeBrokerLookup({ handle: existingHandle });
        if (matches === null) return null;
        const existing = matches[0];
        if (existing) return existing;
        sourceHandles.delete(event.sourceId);
        seenSourceIds.delete(event.sourceId);
      }
      if (seenSourceIds.has(event.sourceId)) seenSourceIds.delete(event.sourceId);
      seenSourceIds.add(event.sourceId);
    }

    const sanitizedEvent = {
      ...event,
      input: sanitizeValue(event.input) as any,
      content: sanitizeValue(event.content),
      details: sanitizeValue(event.details),
    };
    const payload = toolPayload(sanitizedEvent);
    const bytes = Buffer.byteLength(payload, "utf8");
    const hostilePayload = isHostilePayload(payload) || hasHostileValue(sanitizedEvent);
    const opaquePayload = !hostilePayload && (isOpaquePayload(payload) || hasOpaqueValue(sanitizedEvent));
    let artifact: ContextArtifact;
    try {
      artifact = broker.publish({
        sessionId: activeSessionId,
        kind: "tool_output",
        payload,
        summary: summarizeTool(sanitizedEvent, bytes, hostilePayload),
        tags: [
          event.toolName,
          event.isError ? "error" : "ok",
          event.sourceId ? "session-backfill" : "live",
          ...(hostilePayload ? ["hostile", "binary"] : []),
          ...(opaquePayload ? ["opaque"] : []),
        ],
        command: event.toolName === "bash" && typeof sanitizedEvent.input?.command === "string" ? sanitizedEvent.input.command : undefined,
        paths: typeof sanitizedEvent.input?.path === "string" ? [sanitizedEvent.input.path] : [],
        ttlMs: event.ttlMs ?? DEFAULT_TTL_MS,
        parentIds: event.sourceId ? [event.sourceId] : [],
        createdAt: event.createdAt,
      });
    } catch (error) {
      recordPublishFailure(error);
      return null;
    }
    if (artifact) routingTelemetry.toolResultArtifacts += 1;
    if (event.sourceId) sourceHandles.set(event.sourceId, artifact.handle);
    return artifact;
  }

  function collectToolInputs(entries: any[]): Map<string, { toolName?: string; input?: unknown }> {
    const toolInputs = new Map<string, { toolName?: string; input?: unknown }>();
    for (const entry of entries) {
      const message = entry?.type === "message" ? entry.message : entry;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          toolInputs.set(block.id, { toolName: typeof block.name === "string" ? block.name : undefined, input: block.arguments });
        }
      }
    }
    return toolInputs;
  }

  function backfillSessionArtifacts(ctx: Partial<SessionContextLike>): { added: number; scanned: number; errors: number } {
    activeSessionId = sessionIdFor(ctx);
    let entries: any[] = [];
    try {
      entries = ctx.sessionManager?.getBranch?.() ?? [];
    } catch {
      return { added: 0, scanned: 0, errors: 1 };
    }

    const toolInputs = collectToolInputs(entries);

    let added = 0;
    let scanned = 0;
    let errors = 0;

    for (const entry of entries) {
      try {
        const entryId = typeof entry?.id === "string" ? entry.id : undefined;
        const createdAt = messageTimestamp(entry);

        if (entry?.type === "message" && entry.message?.role === "toolResult") {
          scanned += 1;
          routingTelemetry.backfillScans += 1;
          const sourceId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : entryId;
          const toolInput = sourceId ? toolInputs.get(sourceId) : undefined;
          const alreadySeen = sourceId ? seenSourceIds.has(sourceId) || sourceHandles.has(sourceId) : false;
          if (publishToolArtifact({
            toolName: String(entry.message.toolName ?? toolInput?.toolName ?? "tool"),
            input: entry.message.input ?? toolInput?.input,
            content: entry.message.content,
            details: entry.message.details,
            isError: Boolean(entry.message.isError),
            sourceId,
            createdAt,
            ttlMs: ttlFromNowFor(createdAt),
          }) && !alreadySeen) {
            added += 1;
            routingTelemetry.backfillAdded += 1;
          }
        }

        if (entry?.type === "message" && entry.message?.role === "bashExecution") {
          if (entry.message.excludeFromContext === true) continue;
          scanned += 1;
          routingTelemetry.backfillScans += 1;
          const sourceId = entryId;
          const alreadySeen = sourceId ? seenSourceIds.has(sourceId) || sourceHandles.has(sourceId) : false;
          if (publishToolArtifact({
            toolName: "bash",
            input: { command: entry.message.command },
            content: entry.message.output,
            details: {
              exitCode: entry.message.exitCode,
              cancelled: entry.message.cancelled,
              truncated: entry.message.truncated,
              fullOutputPath: entry.message.fullOutputPath,
            },
            isError: typeof entry.message.exitCode === "number" ? entry.message.exitCode !== 0 : Boolean(entry.message.cancelled),
            sourceId,
            createdAt,
            ttlMs: ttlFromNowFor(createdAt),
          }) && !alreadySeen) {
            added += 1;
            routingTelemetry.backfillAdded += 1;
          }
        }
      } catch {
        errors += 1;
        routingTelemetry.backfillErrors += 1;
      }
    }

    return { added, scanned, errors };
  }

  function currentBrief(): string {
    return broker.renderBrief({ sessionId: activeSessionId, budgetBytes: briefBytes });
  }

  p.__piRogueContextBroker = {
    renderBrief: currentBrief,
    lookup: broker.lookup,
    status: broker.status,
    publish: (input: Omit<Parameters<typeof broker.publish>[0], "sessionId"> & { sessionId?: string }) => broker.publish({
      ...input,
      sessionId: input.sessionId ?? activeSessionId,
    }),
  };

  const contextActions: AutocompleteItem[] = [
    { value: "status", label: "status", description: "Show broker record, byte, and pinned counts" },
    { value: "brief", label: "brief", description: "Show the bounded broker brief" },
    { value: "lookup ", label: "lookup", description: "Lookup by ctx:// handle or current-session text" },
    { value: "pin ", label: "pin", description: "Pin an artifact by ctx:// handle or id" },
    { value: "export ", label: "export", description: "Export full payload for a ctx:// handle or id" },
    { value: "config ", label: "config", description: "Show or set context broker config" },
    { value: "prune", label: "prune", description: "Run TTL/cap pruning now" },
  ];

  function artifactCompletions(action: "lookup" | "pin" | "export", query: string): AutocompleteItem[] {
    const needle = query.trim().toLowerCase();
    return broker.lookup({ sessionId: activeSessionId, limit: 10 })
      .filter((artifact) => {
        if (!needle) return true;
        return artifact.handle.toLowerCase().includes(needle)
          || artifact.summary.toLowerCase().includes(needle)
          || artifact.kind.toLowerCase().includes(needle)
          || artifact.tags.join(" ").toLowerCase().includes(needle)
          || artifact.paths.join(" ").toLowerCase().includes(needle);
      })
      .map((artifact) => ({
        value: `${action} ${artifact.handle}`,
        label: `${action} ${artifact.kind}`,
        description: `${artifact.pinned ? "pinned; " : ""}${artifact.summary}`,
      }));
  }

  function contextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const prefix = argumentPrefix.trimStart();
    const [action = "", ...restParts] = prefix.split(/\s+/);
    const hasActionSeparator = /\s/.test(prefix);

    if (!action || !hasActionSeparator) {
      const items = contextActions.filter((item) => item.value.trim().startsWith(action));
      return items.length ? items : contextActions;
    }

    if (action === "lookup" || action === "pin" || action === "export") {
      const items = artifactCompletions(action, restParts.join(" "));
      return items.length ? items : null;
    }

    if (action === "config") {
      const rest = restParts.join(" ");
      if (!rest || !rest.includes(" ")) {
        const items = [
          { value: "config", label: "config", description: "Show context broker config" },
          { value: "config threshold ", label: "threshold", description: "Set rewrite threshold in bytes" },
          { value: "config lenses ", label: "lenses", description: "Enable or disable context-lens generation (on|off)" },
        ].filter((item) => item.value.trim().startsWith(`config ${rest}`.trimEnd()));
        return items.length ? items : null;
      }
      if (restParts[0] === "threshold") {
        const query = `config threshold ${restParts.slice(1).join(" ")}`.trimEnd();
        const items = REWRITE_THRESHOLD_PRESETS.map((value) => ({
          value: `config threshold ${value}`,
          label: `${value}`,
          description: value === DEFAULT_REWRITE_THRESHOLD_BYTES ? "default 8 KiB" : `set rewrite threshold to ${value} bytes`,
        })).filter((item) => item.value.startsWith(query));
        return items.length ? items : null;
      }
      if (restParts[0] === "lenses") {
        const query = `config lenses ${restParts.slice(1).join(" ")}`.trimEnd();
        const items = ["on", "off"].map((value) => ({
          value: `config lenses ${value}`,
          label: `${value}`,
          description: `set context lenses to ${value}`,
        })).filter((item) => item.value.startsWith(query));
        return items.length ? items : null;
      }
    }

    return null;
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshRewriteThresholdFromConfig(ctx);
    const { added, scanned, errors } = backfillSessionArtifacts(ctx);
    ctx.ui.setStatus?.("context-broker", "ctx:on");
    if (startupNotice) {
      ctx.ui.notify(startupNotice, "warning");
      startupNotice = undefined;
    }
    ctx.ui.notify(
      `Context broker enabled. Backfilled ${added}/${scanned} current-branch tool artifacts${errors ? ` (${errors} malformed skipped)` : ""}. Use /pi-rogue-context status or /pi-rogue-context brief.`,
      errors ? "warning" : "info",
    );
  });

  pi.on("session_compact", async (_event, ctx) => {
    activeSessionId = sessionIdFor(ctx);
    const before = broker.status();
    const after = broker.purge({ sessionId: activeSessionId, keepPinned: true });
    seenSourceIds.clear();
    sourceHandles.clear();
    const removed = before.records - after.records;
    if (removed > 0) ctx.ui.notify(`Context broker compact cleanup purged ${removed} unpinned artifact${removed === 1 ? "" : "s"}; pinned artifacts retained.`, "info");
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    activeSessionId = sessionIdFor(ctx);
    routingTelemetry.toolResultEvents += 1;
    publishToolArtifact({ ...event, sourceId: event.toolCallId });
    notifyPublishFailure(ctx);
  });

  pi.on("context", async (event, ctx) => {
    refreshRewriteThresholdFromConfig(ctx);
    activeSessionId = sessionIdFor(ctx);
    routingTelemetry.contextHookCalls += 1;
    const toolInputs = collectToolInputs(event.messages);
    type RewriteDraft = {
      original: any;
      replacement?: any;
      rawBytes?: number;
      artifact?: ContextArtifact;
      rewrite?: (artifact: ContextArtifact) => any;
      safeFallback?: any;
      usedContextLens?: boolean;
      contextLensCapBytes?: number;
    };
    const drafts = event.messages.map((message: any, index: number): RewriteDraft => {
      if (message?.role === "toolResult") {
        routingTelemetry.contextHookToolResults += 1;
        const raw = contentText(message.content);
        const rawBytes = utf8Bytes(raw);
        const toolInput = (typeof message.toolCallId === "string" ? toolInputs.get(message.toolCallId) : undefined) as
          | { toolName?: string; input?: any }
          | undefined;
        const toolName = String(message.toolName ?? toolInput?.toolName ?? "tool");
        const hostile = hasHostileText(raw) || hasHostileValue(message.content);
        if (hostile) routingTelemetry.contextHookToolResultHostile += 1;
        if (!shouldBrokerToolName(toolName)) {
          const hasLaterAssistant = event.messages.slice(index + 1).some((candidate: any) => candidate?.role === "assistant");
          if (!hasLaterAssistant) return { original: message };
          routingTelemetry.contextHookContextLookupHistoryOmissions += 1;
          return {
            original: message,
            rawBytes,
            replacement: { ...message, content: [{ type: "text", text: contextLookupHistoryPlaceholder() }] },
          };
        }
        const shouldRewrite = rawBytes > rewriteThresholdBytes || hostile;
        if (!shouldRewrite) return { original: message };
        const commandOrPath = String(toolInput?.input?.command ?? toolInput?.input?.path ?? "");
        const lens = (() => {
          if (!contextLensesEnabled || hostile) return null;
          try {
            return extractContextLens(raw, {
              toolName,
              command: toolInput?.input?.command,
              path: toolInput?.input?.path,
              isError: Boolean(message.isError),
              exitCode: (message as any).exitCode,
            });
          } catch {
            return null;
          }
        })();
        if (contextLensesEnabled && !lens) routingTelemetry.contextLensMisses += 1;
        const replacementText = (live: ContextArtifact) => (lens
          ? contextLensPlaceholder(live, lens, commandOrPath)
          : brokerPlaceholder(live));
        const artifact = publishToolArtifact({
          toolName,
          input: message.input ?? toolInput?.input,
          content: message.content,
          details: message.details,
          isError: Boolean(message.isError),
          sourceId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
          createdAt: typeof message.timestamp === "number" ? message.timestamp : undefined,
          ttlMs: ttlFromNowFor(typeof message.timestamp === "number" ? message.timestamp : undefined),
        });
        if (!artifact) return { original: message };
        if (lens && contextLensesEnabled) {
          routingTelemetry.contextLensHits += 1;
          routingTelemetry.contextLensEmittedBytes += Math.min(rawBytes, lens.maxBytes);
        }
        routingTelemetry.contextHookToolResultRewrites += 1;
        return {
          original: message,
          rawBytes,
          artifact,
          usedContextLens: Boolean(lens && contextLensesEnabled),
          contextLensCapBytes: lens?.maxBytes,
          rewrite: (live) => ({ ...message, content: [{ type: "text", text: replacementText(live) }] }),
          safeFallback: { ...message, content: [{ type: "text", text: prunedPayloadPlaceholder(hostile) }] },
        };
      }

      if (message?.role === "bashExecution" && message.excludeFromContext !== true) {
        routingTelemetry.contextHookBash += 1;
        const raw = String(message.output ?? "");
        const rawBytes = utf8Bytes(raw);
        const hostile = hasHostileText(raw) || hasHostileValue(message.output);
        if (hostile) routingTelemetry.contextHookBashHostile += 1;
        const shouldRewrite = rawBytes > rewriteThresholdBytes || hostile;
        if (!shouldRewrite) return { original: message };
        const sourceId = typeof message.timestamp === "number"
          ? `bash:${message.timestamp}:${stableHash([message.command ?? "", raw, message.exitCode ?? "", message.cancelled ?? ""].join("\n"))}`
          : `bash:${stableHash([message.command ?? "", raw, message.exitCode ?? "", message.cancelled ?? ""].join("\n"))}`;
        const command = String(message.command ?? "");
        const lens = (() => {
          if (!contextLensesEnabled || hostile) return null;
          try {
            return extractContextLens(raw, {
              toolName: "bash",
              command,
              isError: typeof message.exitCode === "number" ? message.exitCode !== 0 : Boolean(message.cancelled),
              exitCode: message.exitCode,
            });
          } catch {
            return null;
          }
        })();
        if (contextLensesEnabled && !lens) routingTelemetry.contextLensMisses += 1;
        const replacementText = (live: ContextArtifact) => (lens
          ? contextLensPlaceholder(live, lens, command)
          : brokerPlaceholder(live));
        const artifact = publishToolArtifact({
          toolName: "bash",
          input: { command: message.command },
          content: message.output,
          details: {
            exitCode: message.exitCode,
            cancelled: message.cancelled,
            truncated: message.truncated,
            fullOutputPath: message.fullOutputPath,
          },
          isError: typeof message.exitCode === "number" ? message.exitCode !== 0 : Boolean(message.cancelled),
          sourceId,
          createdAt: typeof message.timestamp === "number" ? message.timestamp : undefined,
          ttlMs: ttlFromNowFor(typeof message.timestamp === "number" ? message.timestamp : undefined),
        });
        if (!artifact) return { original: message };
        if (lens && contextLensesEnabled) {
          routingTelemetry.contextLensHits += 1;
          routingTelemetry.contextLensEmittedBytes += Math.min(rawBytes, lens.maxBytes);
        }
        routingTelemetry.contextHookBashRewrites += 1;
        return {
          original: message,
          rawBytes,
          artifact,
          usedContextLens: Boolean(lens && contextLensesEnabled),
          contextLensCapBytes: lens?.maxBytes,
          rewrite: (live) => ({ ...message, output: replacementText(live), truncated: true }),
          safeFallback: { ...message, output: prunedPayloadPlaceholder(hostile), truncated: true },
        };
      }

      return { original: message };
    });

    let changed = false;
    const messages = drafts.map((draft) => {
      if (draft.replacement) {
        changed = true;
        recordContextRewrite(draft.rawBytes ?? promptPayloadBytes(draft.original), promptPayloadBytes(draft.replacement));
        return draft.replacement;
      }
      if (!draft.artifact || !draft.rewrite) return draft.original;
      const matches = safeBrokerLookup({ handle: draft.artifact.handle });
      if (matches === null) {
        for (const parentId of draft.artifact.parentIds) sourceHandles.delete(parentId);
        return draft.original;
      }
      const live = matches[0];
      if (!live) {
        if (draft.usedContextLens) routingTelemetry.contextLensFallbacks += 1;
        for (const parentId of draft.artifact.parentIds) sourceHandles.delete(parentId);
        if (draft.safeFallback) {
          changed = true;
          recordContextRewrite(draft.rawBytes ?? promptPayloadBytes(draft.original), promptPayloadBytes(draft.safeFallback));
          return draft.safeFallback;
        }
        return draft.original;
      }
      changed = true;
      const replacement = draft.rewrite(live);
      recordContextRewrite(draft.rawBytes ?? promptPayloadBytes(draft.original), promptPayloadBytes(replacement));
      return replacement;
    });

    notifyPublishFailure(ctx);
    return changed ? { messages } : undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const brief = currentBrief();
    if (!brief.includes("ctx://")) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        brief,
        "Context broker rule: call context_lookup({handle:\"<ctx://...>\"}) for exact broker evidence. Briefs are summaries; /pi-rogue-context lookup is human/TUI only.",
      ].join("\n\n"),
    };
  });

  pi.registerTool({
    name: "context_lookup",
    label: "Context Lookup",
    description: "Lookup exact or searchable context broker artifacts by handle, current-session text, path, tag, kind, or tier.",
    promptSnippet: "context_lookup: retrieve context broker artifacts by ctx:// handle or focused filters before asking the user to repeat prior tool output.",
    promptGuidelines: [
      "Use context_lookup when a ctx:// handle is relevant and exact evidence is needed.",
      "Do not paste large raw broker payloads unless the user explicitly asks; summarize and cite handles instead.",
    ],
    parameters: Type.Object({
      handle: Type.Optional(Type.String({ description: "Exact ctx:// handle to retrieve" })),
      text: Type.Optional(Type.String({ description: "Current-session text search over broker summaries and indexed payload text" })),
      path: Type.Optional(Type.String({ description: "File or directory path filter" })),
      tag: Type.Optional(Type.String({ description: "Artifact tag filter" })),
      kind: Type.Optional(Type.String({ enum: ["tool_output", "diff", "file_snapshot", "subagent_result", "advisor_brief", "memory_note", "fusion_result"] })),
      tier: Type.Optional(Type.String({ enum: ["hot", "warm", "cold"] })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Maximum artifacts to return" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeSessionId = sessionIdFor(ctx);
      routingTelemetry.toolLookupCalls += 1;
      const p = params as { handle?: string; text?: string; path?: string; tag?: string; kind?: any; tier?: any; limit?: number };
      const exact = typeof p.handle === "string" && p.handle.startsWith("ctx://");
      routingTelemetry.toolLookupExactCalls += exact ? 1 : 0;
      routingTelemetry.toolLookupTextCalls += exact ? 0 : 1;
      const focused = exact || Boolean(p.text?.trim() || p.path?.trim() || p.tag?.trim() || p.kind || p.tier);
      if (!focused) {
        return textResult("context_lookup requires a focused filter: handle, text, path, tag, kind, or tier. Empty lookups are refused to avoid dumping brokered payloads into the prompt.");
      }
      const results = broker.lookup({
        handle: exact ? p.handle : undefined,
        sessionId: exact ? undefined : activeSessionId,
        text: exact ? undefined : p.text,
        path: p.path,
        tag: p.tag,
        kind: p.kind,
        tier: p.tier,
        limit: Math.min(10, Math.max(1, Math.floor(p.limit ?? (exact ? 1 : 5)))),
      });
      if (!results.length) {
        routingTelemetry.toolLookupMisses += 1;
        if (exact) routingTelemetry.toolLookupExactMisses += 1;
        else routingTelemetry.toolLookupTextMisses += 1;
        return textResult(lookupMissMessage(exact));
      }
      routingTelemetry.toolLookupHits += 1;
      return textResult(results.map((item) => renderLookupOutput(item, exact ? lookupBytes : searchBytes)).join("\n\n---\n\n"));
    },
  });

  pi.registerCommand("pi-rogue-context", {
    description: "Inspect the context broker: status | brief | lookup <handle-or-text> | pin <handle-or-id> | export <handle-or-id> | config | prune",
    getArgumentCompletions: contextArgumentCompletions,
    handler: async (args, ctx) => {
      activeSessionId = sessionIdFor(ctx);
      const [action = "status", ...rest] = String(args || "").trim().split(/\s+/).filter(Boolean);
      const query = rest.join(" ");

      if (action === "status") {
        refreshRewriteThresholdFromConfig(ctx);
        routingTelemetry.statusCalls += 1;
        const status = broker.status();
        ctx.ui.notify(
          `Context broker: enabled, session=${activeSessionId}, records=${status.records}/${status.maxRecords}, bytes=${status.bytes}/${status.maxBytes}, rewriteThresholdBytes=${rewriteThresholdBytes}(${rewriteThresholdSource}), globalCaps=records:${capText(status.globalMaxRecords)} bytes:${capText(status.globalMaxBytes)}, tiers=hot:${status.hotRecords}/${status.hotBytes} warm:${status.warmRecords}/${status.warmBytes} cold:${status.coldRecords}/${status.coldBytes}, pinned=${status.pinnedRecords}/${status.pinnedBytes} bytes`,
          "info",
        );
        ctx.ui.notify(formatRoutingTelemetry(), "info");
        return;
      }

      if (action === "brief") {
        ctx.ui.notify(currentBrief(), "info");
        return;
      }

      if (action === "lookup") {
        if (!query) {
          ctx.ui.notify("Usage: /pi-rogue-context lookup <ctx://handle-or-text>", "warning");
          return;
        }
        routingTelemetry.commandLookupCalls += 1;
        const exact = query.startsWith("ctx://");
        routingTelemetry.commandLookupExactCalls += exact ? 1 : 0;
        routingTelemetry.commandLookupTextCalls += exact ? 0 : 1;
        const results = broker.lookup(exact ? { handle: query } : { sessionId: activeSessionId, text: query, limit: 5 });
        if (results.length) {
          routingTelemetry.commandLookupHits += 1;
        } else {
          routingTelemetry.commandLookupMisses += 1;
          if (exact) routingTelemetry.commandLookupExactMisses += 1;
          else routingTelemetry.commandLookupTextMisses += 1;
        }
        ctx.ui.notify(results.length ? results.map((item) => renderLookupOutput(item, exact ? lookupBytes : searchBytes)).join("\n\n---\n\n") : lookupMissMessage(exact), "info");
        return;
      }

      if (action === "pin") {
        if (!query) {
          ctx.ui.notify("Usage: /pi-rogue-context pin <ctx://handle-or-id>", "warning");
          return;
        }
        const pinned = broker.pin(query, true);
        routingTelemetry.pinCalls += 1;
        ctx.ui.notify(pinned ? `Pinned ${pinned.handle}` : "No artifact matched that handle/id.", pinned ? "info" : "warning");
        return;
      }

      if (action === "export") {
        if (!query) {
          ctx.ui.notify("Usage: /pi-rogue-context export <ctx://handle-or-id>", "warning");
          return;
        }

        const exact = query.startsWith("ctx://");
        const artifact = exact ? broker.lookup({ handle: query })[0] : broker.lookup({ id: query })[0];
        if (!artifact) {
          ctx.ui.notify("No artifact matched that handle-or-id.", "warning");
          return;
        }

        const exportDir = mkdtempSync(join(tmpdir(), "pi-context-broker-export-"));
        const exportPath = join(exportDir, `${artifact.id}.txt`);
        writeFileSync(exportPath, artifact.payload, "utf8");
        routingTelemetry.exportCalls += 1;
        ctx.ui.notify(`Exported full payload for ${sanitizeForPrompt(artifact.handle)} (${artifact.bytes} bytes) to ${exportPath}`, "info");
        return;
      }

      if (action === "config") {
        const [key, rawValue] = rest;
        if (!key) {
          refreshRewriteThresholdFromConfig(ctx);
          ctx.ui.notify(formatContextBrokerConfig(ctx), "info");
          return;
        }
        if (key === "threshold") {
          const value = parseNonNegativeInt(rawValue);
          if (value === undefined || value < MIN_REWRITE_THRESHOLD_BYTES) {
            ctx.ui.notify(
              `Usage: /pi-rogue-context config threshold <bytes>\n` +
              `  - must be an integer >= ${MIN_REWRITE_THRESHOLD_BYTES} bytes`,
              "warning",
            );
            return;
          }
          const path = saveConfiguredRewriteThresholdBytes(ctx, value);
          if (rewriteThresholdOption === undefined && rewriteThresholdEnv === undefined) {
            rewriteThresholdBytes = value;
            rewriteThresholdSource = "config";
          }
          ctx.ui.notify(`Context broker config updated: rewriteThresholdBytes=${value}\nconfig: ${path}${rewriteThresholdSource !== "config" ? `\nNote: current ${rewriteThresholdSource} override still takes precedence this session.` : ""}`, "info");
          return;
        }
        if (key === "lenses") {
          const shouldEnable = parseBooleanish(rawValue);
          if (shouldEnable === undefined) {
            ctx.ui.notify(
              `Usage: /pi-rogue-context config lenses on|off\n` +
              `  - default is off`,
              "warning",
            );
            return;
          }
          const path = saveConfiguredContextLensesEnabled(ctx, shouldEnable);
          if (lensesEnabledOption === undefined && lensesEnabledEnv === undefined) {
            contextLensesEnabled = shouldEnable;
            contextLensesSource = "config";
          }
          ctx.ui.notify(`Context broker config updated: contextLensesEnabled=${shouldEnable}\nconfig: ${path}${contextLensesSource !== "config" ? `\nNote: current ${contextLensesSource} override still takes precedence this session.` : ""}`, "info");
          return;
        }
        ctx.ui.notify(`Usage: /pi-rogue-context config threshold <bytes> (minimum ${MIN_REWRITE_THRESHOLD_BYTES} bytes)\n       or /pi-rogue-context config lenses on|off`, "warning");
        return;
      }

      if (action === "prune") {
        routingTelemetry.pruneCalls += 1;
        const status = broker.prune();
        ctx.ui.notify(`Pruned. ${status.records} records, ${status.bytes} bytes remain.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /pi-rogue-context status | brief | lookup <handle-or-text> | pin <handle-or-id> | export <handle-or-id> | config [threshold|lenses] | prune", "warning");
    },
  });
}

export function shouldEnableContextBrokerBeta(options: ContextBrokerBetaOptions = {}): boolean {
  return Boolean(options.enabled ?? isEnvEnabled());
}
