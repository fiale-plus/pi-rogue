import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { safeName } from "@fiale-plus/pi-core";
import type {
  BoundedContextBroker,
  ContextArtifact,
  ContextArtifactInput,
  ContextArtifactKind,
  ContextArtifactTier,
  ContextBrokerOptions,
  ContextBrokerStatus,
  ContextLookupQuery,
  ContextPurgeOptions,
} from "@fiale-plus/pi-core";

export interface SqliteContextBrokerOptions extends ContextBrokerOptions {
  path?: string;
  dir?: string;
}

const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_BYTES = 320;
const DEFAULT_BRIEF_BYTES = 2_000;
const TIER_ORDER: Record<ContextArtifactTier, number> = { hot: 0, warm: 1, cold: 2 };
const TIER_REMOVAL_ORDER: Record<ContextArtifactTier, number> = { cold: 0, warm: 1, hot: 2 };

function optionMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

function defaultStoreDir(): string {
  return join(homedir(), ".pi", "agent", "fiale-plus", "context-broker");
}

function defaultSqlitePath(options: SqliteContextBrokerOptions): string {
  return options.path ?? join(options.dir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR ?? defaultStoreDir(), "artifacts.sqlite");
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function payloadText(payload: string | Buffer): string {
  return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
}

function payloadBytes(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload ?? ""), "utf8");
}

function hashPayload(payload: string | Buffer): string {
  return createHash("sha256").update(Buffer.isBuffer(payload) ? payload : String(payload)).digest("hex");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  if (limit === 0) return "";

  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const contentLimit = Math.max(0, limit - ellipsisBytes);
  let used = 0;
  let result = "";

  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > contentLimit) break;
    result += char;
    used += bytes;
  }

  if (Buffer.byteLength(result + ellipsis, "utf8") <= limit) return result + ellipsis;
  return result;
}

function summarizeArtifact(summary: string | undefined, kind: ContextArtifactKind, bytes: number, sha256: string, maxBytes: number): string {
  const cleaned = String(summary ?? "").replace(/\s+/g, " ").trim();
  if (cleaned) return truncateUtf8(cleaned, maxBytes);
  return truncateUtf8(`[${kind} payload stored externally; ${bytes} bytes; sha256=${sha256.slice(0, 16)}]`, maxBytes);
}

function classifyBaseTier(input: ContextArtifactInput, tags: string[]): ContextArtifactTier {
  if (input.tier) return input.tier;
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  if (normalizedTags.includes("hot")) return "hot";
  if (normalizedTags.includes("warm")) return "warm";
  if (normalizedTags.includes("cold")) return "cold";
  if (normalizedTags.some((tag) => tag === "error" || tag === "failed" || tag === "failure")) return "hot";
  if (normalizedTags.some((tag) => tag === "archive" || tag === "historical" || tag === "completed")) return "cold";
  if (input.kind === "advisor_brief" || input.kind === "memory_note") return "hot";
  return "warm";
}

function jsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowToArtifact(row: Record<string, unknown>): ContextArtifact & { baseTier: ContextArtifactTier } {
  return {
    id: String(row.id),
    handle: String(row.handle),
    sessionId: String(row.sessionId),
    kind: String(row.kind) as ContextArtifactKind,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    payload: String(row.payload ?? ""),
    summary: String(row.summary ?? ""),
    tags: jsonList(row.tagsJson as string | undefined),
    paths: jsonList(row.pathsJson as string | undefined),
    command: row.command == null ? undefined : String(row.command),
    branch: row.branch == null ? undefined : String(row.branch),
    tier: String(row.tier) as ContextArtifactTier,
    expiresAt: row.expiresAt == null ? undefined : Number(row.expiresAt),
    pinned: Boolean(row.pinned),
    parentIds: jsonList(row.parentIdsJson as string | undefined),
    baseTier: String(row.baseTier ?? row.tier) as ContextArtifactTier,
  };
}

function tierLine(artifact: ContextArtifact): string {
  const pin = artifact.pinned ? " pinned" : "";
  const path = artifact.paths.length ? ` paths=${artifact.paths.slice(0, 3).join(",")}` : "";
  const tags = artifact.tags.length ? ` tags=${artifact.tags.slice(0, 3).join(",")}` : "";
  return `- ${artifact.handle} tier=${artifact.tier} kind=${artifact.kind}${pin}${path}${tags} summary="${artifact.summary}"`;
}

function escapeFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function ftsQuery(text: string): string {
  return text.split(/\s+/).map((term) => term.trim()).filter(Boolean).map(escapeFtsTerm).join(" AND ");
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function stableSource(input: ContextArtifactInput): string | undefined {
  return input.parentIds?.find(Boolean);
}

function initialize(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      sessionId TEXT NOT NULL,
      kind TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      payload TEXT NOT NULL,
      summary TEXT NOT NULL,
      tagsJson TEXT NOT NULL,
      pathsJson TEXT NOT NULL,
      command TEXT,
      branch TEXT,
      tier TEXT NOT NULL,
      baseTier TEXT NOT NULL,
      expiresAt INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      parentIdsJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(sessionId);
    CREATE INDEX IF NOT EXISTS idx_artifacts_handle ON artifacts(handle);
    CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
    CREATE INDEX IF NOT EXISTS idx_artifacts_tier ON artifacts(tier);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(createdAt);
    CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(id UNINDEXED, summary, payload, command, tags, paths);
  `);
}

export function createSqliteContextBroker(options: SqliteContextBrokerOptions = {}): BoundedContextBroker {
  const dbPath = defaultSqlitePath(options);
  if (dbPath !== ":memory:" && !existsSync(dirname(dbPath))) ensureParent(dbPath);
  const db = new DatabaseSync(dbPath);
  initialize(db);

  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const globalMaxRecords = typeof options.globalMaxRecords === "number" && Number.isFinite(options.globalMaxRecords)
    ? Math.max(1, Math.floor(options.globalMaxRecords))
    : Number.POSITIVE_INFINITY;
  const globalMaxBytes = typeof options.globalMaxBytes === "number" && Number.isFinite(options.globalMaxBytes)
    ? Math.max(1, Math.floor(options.globalMaxBytes))
    : Number.POSITIVE_INFINITY;
  const defaultTtlMs = Math.max(0, Math.floor(options.defaultTtlMs ?? DEFAULT_TTL_MS));
  const tierTtlMs: Record<ContextArtifactTier, number> = {
    hot: Math.max(0, Math.floor(options.hotTtlMs ?? defaultTtlMs)),
    warm: Math.max(0, Math.floor(options.warmTtlMs ?? defaultTtlMs)),
    cold: Math.max(0, Math.floor(options.coldTtlMs ?? defaultTtlMs)),
  };
  const tierMaxRecords: Record<ContextArtifactTier, number> = {
    hot: Math.max(1, Math.floor(options.hotMaxRecords ?? maxRecords)),
    warm: Math.max(1, Math.floor(options.warmMaxRecords ?? maxRecords)),
    cold: Math.max(1, Math.floor(options.coldMaxRecords ?? maxRecords)),
  };
  const tierMaxBytes: Record<ContextArtifactTier, number> = {
    hot: Math.max(1, Math.floor(options.hotMaxBytes ?? maxBytes)),
    warm: Math.max(1, Math.floor(options.warmMaxBytes ?? maxBytes)),
    cold: Math.max(1, Math.floor(options.coldMaxBytes ?? maxBytes)),
  };
  const hotToWarmMs = optionMs(options.hotToWarmMs);
  const warmToColdMs = optionMs(options.warmToColdMs);
  const summaryBytes = Math.max(16, Math.floor(options.summaryBytes ?? DEFAULT_SUMMARY_BYTES));
  const defaultBriefBytes = Math.max(64, Math.floor(options.briefBytes ?? DEFAULT_BRIEF_BYTES));

  function nextSequence(): number {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'sequence'").get();
    const next = Number(row?.value ?? 0) + 1;
    db.prepare("INSERT INTO meta(key, value) VALUES('sequence', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
    return next;
  }

  function deleteArtifact(id: string): void {
    db.prepare("DELETE FROM artifact_fts WHERE id = ?").run(id);
    db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  function cooledTier(artifact: ContextArtifact & { baseTier: ContextArtifactTier }, now = Date.now()): ContextArtifactTier {
    if (artifact.pinned) return "hot";
    if (artifact.baseTier === "cold") return "cold";
    const age = Math.max(0, now - artifact.createdAt);
    if (age >= warmToColdMs) return "cold";
    if (artifact.baseTier === "hot" && age >= hotToWarmMs) return "warm";
    return artifact.baseTier;
  }

  function applyCooling(now = Date.now(), _protectedIds = new Set<string>()): void {
    const rows = db.prepare("SELECT id, createdAt, tier, baseTier, pinned FROM artifacts WHERE pinned = 0").all();
    const update = db.prepare("UPDATE artifacts SET tier = ?, updatedAt = ? WHERE id = ?");
    for (const row of rows) {
      const artifact = {
        id: String(row.id),
        createdAt: Number(row.createdAt),
        tier: String(row.tier) as ContextArtifactTier,
        baseTier: String(row.baseTier ?? row.tier) as ContextArtifactTier,
        pinned: Boolean(row.pinned),
      };
      const nextTier = cooledTier(artifact as ContextArtifact & { baseTier: ContextArtifactTier }, now);
      if (artifact.tier !== nextTier) update.run(nextTier, now, artifact.id);
    }
  }

  function currentStatus(): ContextBrokerStatus {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS records,
        COALESCE(SUM(bytes), 0) AS bytes,
        COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinnedRecords,
        COALESCE(SUM(CASE WHEN pinned = 1 THEN bytes ELSE 0 END), 0) AS pinnedBytes,
        COALESCE(SUM(CASE WHEN tier = 'hot' THEN 1 ELSE 0 END), 0) AS hotRecords,
        COALESCE(SUM(CASE WHEN tier = 'hot' THEN bytes ELSE 0 END), 0) AS hotBytes,
        COALESCE(SUM(CASE WHEN tier = 'warm' THEN 1 ELSE 0 END), 0) AS warmRecords,
        COALESCE(SUM(CASE WHEN tier = 'warm' THEN bytes ELSE 0 END), 0) AS warmBytes,
        COALESCE(SUM(CASE WHEN tier = 'cold' THEN 1 ELSE 0 END), 0) AS coldRecords,
        COALESCE(SUM(CASE WHEN tier = 'cold' THEN bytes ELSE 0 END), 0) AS coldBytes
      FROM artifacts
    `).get() ?? {};
    return {
      records: Number(row.records ?? 0),
      bytes: Number(row.bytes ?? 0),
      pinnedRecords: Number(row.pinnedRecords ?? 0),
      pinnedBytes: Number(row.pinnedBytes ?? 0),
      hotRecords: Number(row.hotRecords ?? 0),
      hotBytes: Number(row.hotBytes ?? 0),
      warmRecords: Number(row.warmRecords ?? 0),
      warmBytes: Number(row.warmBytes ?? 0),
      coldRecords: Number(row.coldRecords ?? 0),
      coldBytes: Number(row.coldBytes ?? 0),
      maxRecords,
      maxBytes,
      globalMaxRecords,
      globalMaxBytes,
    };
  }

  function dropExpired(now = Date.now(), protectedIds = new Set<string>()): void {
    const rows = db.prepare("SELECT id FROM artifacts WHERE pinned = 0 AND expiresAt IS NOT NULL AND expiresAt <= ?").all(now);
    for (const row of rows) {
      const id = String(row.id);
      if (!protectedIds.has(id)) deleteArtifact(id);
    }
  }

  function capStats(sessionId: string, tier?: ContextArtifactTier): { records: number; bytes: number } {
    const row = tier
      ? db.prepare("SELECT COUNT(*) AS records, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts WHERE sessionId = ? AND tier = ?").get(sessionId, tier)
      : db.prepare("SELECT COUNT(*) AS records, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts WHERE sessionId = ?").get(sessionId);
    return { records: Number(row?.records ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  function withinCaps(sessionId: string, tier?: ContextArtifactTier): boolean {
    const stats = capStats(sessionId, tier);
    return stats.records <= (tier ? tierMaxRecords[tier] : maxRecords) && stats.bytes <= (tier ? tierMaxBytes[tier] : maxBytes);
  }

  function globalStats(): { records: number; bytes: number } {
    const row = db.prepare("SELECT COUNT(*) AS records, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts").get();
    return { records: Number(row?.records ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  function withinGlobalCaps(): boolean {
    if (globalMaxRecords === Number.POSITIVE_INFINITY && globalMaxBytes === Number.POSITIVE_INFINITY) return true;
    const { records, bytes } = globalStats();
    return records <= globalMaxRecords && bytes <= globalMaxBytes;
  }

  function removalCandidate(sessionId: string, protectedIds: Set<string>, tier?: ContextArtifactTier): string | undefined {
    const protectedList = [...protectedIds];
    const protectedClause = protectedList.length ? `AND id NOT IN (${protectedList.map(() => "?").join(",")})` : "";
    const tierClause = tier ? "AND tier = ?" : "";
    const order = tier ? "createdAt ASC, rowid ASC" : "CASE tier WHEN 'cold' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END ASC, createdAt ASC, rowid ASC";
    const params = tier ? [sessionId, tier, ...protectedList] : [sessionId, ...protectedList];
    const row = db.prepare(`SELECT id FROM artifacts WHERE sessionId = ? AND pinned = 0 ${tierClause} ${protectedClause} ORDER BY ${order} LIMIT 1`).get(...params);
    return row?.id == null ? undefined : String(row.id);
  }

  function removalCandidateGlobal(protectedIds: Set<string>, tier?: ContextArtifactTier): string | undefined {
    const protectedList = [...protectedIds];
    const protectedClause = protectedList.length ? `AND id NOT IN (${protectedList.map(() => "?").join(",")})` : "";
    const tierClause = tier ? "AND tier = ?" : "";
    const order = tier
      ? "createdAt ASC, rowid ASC"
      : "CASE tier WHEN 'cold' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END ASC, createdAt ASC, rowid ASC";
    const params = tier ? [tier, ...protectedList] : [...protectedList];
    const row = db.prepare(
      `SELECT id FROM artifacts WHERE pinned = 0 ${tierClause} ${protectedClause} ORDER BY ${order} LIMIT 1`,
    ).get(...params);
    return row?.id == null ? undefined : String(row.id);
  }

  function prune(now = Date.now(), protectedIds = new Set<string>()): ContextBrokerStatus {
    dropExpired(now, protectedIds);
    applyCooling(now, protectedIds);
    const sessions = db.prepare("SELECT DISTINCT sessionId FROM artifacts").all().map((row) => String(row.sessionId));
    for (const sessionId of sessions) {
      for (const tier of ["cold", "warm", "hot"] as ContextArtifactTier[]) {
        while (!withinCaps(sessionId, tier)) {
          const id = removalCandidate(sessionId, protectedIds, tier);
          if (!id) break;
          deleteArtifact(id);
        }
      }

      while (!withinCaps(sessionId)) {
        const id = removalCandidate(sessionId, protectedIds);
        if (!id) break;
        deleteArtifact(id);
      }
    }

    while (!withinGlobalCaps()) {
      const id = removalCandidateGlobal(protectedIds);
      if (!id) break;
      deleteArtifact(id);
    }
    return currentStatus();
  }

  function status(): ContextBrokerStatus {
    dropExpired();
    applyCooling();
    return currentStatus();
  }

  function purge(options: ContextPurgeOptions = {}): ContextBrokerStatus {
    dropExpired();
    applyCooling();
    const keepPinned = options.keepPinned ?? true;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.sessionId) {
      clauses.push("sessionId = ?");
      params.push(options.sessionId);
    }
    if (keepPinned) clauses.push("pinned = 0");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT id FROM artifacts ${where}`).all(...params);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) deleteArtifact(String(row.id));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return currentStatus();
  }

  function publish(input: ContextArtifactInput): ContextArtifact {
    dropExpired();
    const source = stableSource(input);
    if (source) {
      const existing = db.prepare("SELECT * FROM artifacts WHERE sessionId = ? AND parentIdsJson LIKE ? ESCAPE '\\' ORDER BY createdAt DESC, rowid DESC LIMIT 1")
        .get(input.sessionId, likePattern(`"${source}"`));
      if (existing) return rowToArtifact(existing);
    }

    const now = input.createdAt ?? Date.now();
    const payload = payloadText(input.payload);
    const sha256 = hashPayload(input.payload);
    const bytes = payloadBytes(input.payload);
    const tags = normalizeList(input.tags);
    const paths = normalizeList(input.paths);
    const parentIds = normalizeList(input.parentIds);
    const baseTier = classifyBaseTier(input, tags);
    const tier: ContextArtifactTier = input.pinned ? "hot" : baseTier;
    const ttlMs = input.ttlMs ?? tierTtlMs[tier];
    const sequence = nextSequence();
    const id = `ctx-${now.toString(36)}-${String(sequence).padStart(4, "0")}-${sha256.slice(0, 12)}`;
    const session = safeName(input.sessionId || "session");
    const kind = input.kind;
    const handle = `ctx://session/${session}/${kind}/${sha256.slice(0, 16)}/${id}`;
    const artifact = {
      id,
      handle,
      sessionId: input.sessionId,
      kind,
      createdAt: now,
      updatedAt: now,
      bytes,
      sha256,
      payload,
      summary: summarizeArtifact(input.summary, kind, bytes, sha256, summaryBytes),
      tags,
      paths,
      command: input.command?.trim() || undefined,
      branch: input.branch?.trim() || undefined,
      tier,
      baseTier,
      expiresAt: ttlMs > 0 ? now + ttlMs : undefined,
      pinned: Boolean(input.pinned),
      parentIds,
    } satisfies ContextArtifact & { baseTier: ContextArtifactTier };

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO artifacts(id, handle, sessionId, kind, createdAt, updatedAt, bytes, sha256, payload, summary, tagsJson, pathsJson, command, branch, tier, baseTier, expiresAt, pinned, parentIdsJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.handle,
        artifact.sessionId,
        artifact.kind,
        artifact.createdAt,
        artifact.updatedAt,
        artifact.bytes,
        artifact.sha256,
        artifact.payload,
        artifact.summary,
        JSON.stringify(artifact.tags),
        JSON.stringify(artifact.paths),
        artifact.command ?? null,
        artifact.branch ?? null,
        artifact.tier,
        artifact.baseTier,
        artifact.expiresAt ?? null,
        artifact.pinned ? 1 : 0,
        JSON.stringify(artifact.parentIds),
      );
      db.prepare("INSERT INTO artifact_fts(id, summary, payload, command, tags, paths) VALUES (?, ?, ?, ?, ?, ?)").run(
        artifact.id,
        artifact.summary,
        artifact.payload,
        artifact.command ?? "",
        artifact.tags.join(" "),
        artifact.paths.join(" "),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    prune(Date.now(), new Set([artifact.id]));
    return lookup({ id: artifact.id })[0] ?? artifact;
  }

  function lookup(query: ContextLookupQuery = {}): ContextArtifact[] {
    dropExpired();
    applyCooling();
    const storedCount = Number(db.prepare("SELECT COUNT(*) AS count FROM artifacts").get()?.count ?? 1) || 1;
    const limit = Math.max(1, Math.floor(query.limit ?? storedCount));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    let joinFts = false;

    if (query.id) { clauses.push("a.id = ?"); params.push(query.id); }
    if (query.handle) { clauses.push("a.handle = ?"); params.push(query.handle); }
    if (query.sessionId) { clauses.push("a.sessionId = ?"); params.push(query.sessionId); }
    if (query.kind) { clauses.push("a.kind = ?"); params.push(query.kind); }
    if (query.branch) { clauses.push("a.branch = ?"); params.push(query.branch); }
    if (query.tier) { clauses.push("a.tier = ?"); params.push(query.tier); }
    if (query.tag) { clauses.push("a.tagsJson LIKE ? ESCAPE '\\'"); params.push(likePattern(`"${query.tag}"`)); }
    if (query.path) { clauses.push("(a.pathsJson LIKE ? ESCAPE '\\' OR a.pathsJson LIKE ? ESCAPE '\\')"); params.push(likePattern(`"${query.path}"`), likePattern(`"${query.path.replace(/\/$/, "")}/`)); }
    if (query.commandPrefix) { clauses.push("a.command LIKE ? ESCAPE '\\'"); params.push(`${query.commandPrefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`); }
    if (query.text?.trim()) {
      joinFts = true;
      clauses.push("artifact_fts MATCH ?");
      params.push(ftsQuery(query.text.trim()));
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT a.* FROM artifacts a
      ${joinFts ? "JOIN artifact_fts ON artifact_fts.id = a.id" : ""}
      ${where}
      ORDER BY a.pinned DESC,
        CASE a.tier WHEN 'hot' THEN ${TIER_ORDER.hot} WHEN 'warm' THEN ${TIER_ORDER.warm} ELSE ${TIER_ORDER.cold} END ASC,
        a.createdAt DESC,
        a.rowid DESC
      LIMIT ?
    `;

    try {
      return db.prepare(sql).all(...params, limit).map(rowToArtifact);
    } catch {
      if (!query.text?.trim()) return [];
      const fallbackQuery = { ...query, text: undefined };
      const text = query.text.toLowerCase();
      return lookup(fallbackQuery).filter((artifact) => [artifact.summary, artifact.payload, artifact.command, artifact.tags.join(" "), artifact.paths.join(" ")].join("\n").toLowerCase().includes(text)).slice(0, limit);
    }
  }

  function pin(idOrHandle: string, pinned = true): ContextArtifact | null {
    dropExpired();
    const artifact = lookup(idOrHandle.startsWith("ctx://") ? { handle: idOrHandle } : { id: idOrHandle })[0] as (ContextArtifact & { baseTier?: ContextArtifactTier }) | undefined;
    if (!artifact) return null;
    const nextTier: ContextArtifactTier = pinned ? "hot" : artifact.baseTier ?? artifact.tier;
    const updatedAt = Date.now();
    db.prepare("UPDATE artifacts SET pinned = ?, tier = ?, updatedAt = ? WHERE id = ?").run(pinned ? 1 : 0, nextTier, updatedAt, artifact.id);
    prune();
    return lookup({ id: artifact.id })[0] ?? null;
  }

  function renderBrief(query: ContextLookupQuery & { budgetBytes?: number } = {}): string {
    const budget = Math.max(64, Math.floor(query.budgetBytes ?? defaultBriefBytes));
    const explicitCold = query.tier === "cold" || Boolean(query.handle || query.id);
    const baseQuery = { ...query };
    delete (baseQuery as { budgetBytes?: number }).budgetBytes;
    const candidates = lookup({ ...baseQuery, limit: query.limit ?? 32 })
      .filter((artifact) => explicitCold || artifact.tier !== "cold");
    const hot = candidates.filter((artifact) => artifact.tier === "hot");
    const warm = candidates.filter((artifact) => artifact.tier === "warm");
    const cold = candidates.filter((artifact) => artifact.tier === "cold");
    const lines = [
      "## Context Broker",
      `Budget: ${budget} bytes`,
      hot.length ? "Hot:" : "",
      ...hot.map(tierLine),
      warm.length ? "Warm:" : "",
      ...warm.map(tierLine),
      cold.length ? "Cold:" : "",
      ...cold.map(tierLine),
      "Lookup: use broker lookup by handle/path/tag/kind/session before replaying raw payloads.",
    ].filter(Boolean);

    return truncateUtf8(lines.join("\n"), budget);
  }

  return { publish, lookup, pin, prune, purge, status, renderBrief };
}

export function contextBrokerSqlitePathForSession(baseDir: string, sessionId: string): string {
  return join(baseDir, safeName(sessionId), "artifacts.sqlite");
}
