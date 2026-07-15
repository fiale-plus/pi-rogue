import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createSqliteContextBroker, isSqliteCorruptionError, isSqliteLockedError } from "./sqlite.js";
import { MAX_CONTEXT_SOURCES_GLOBAL, MAX_CONTEXT_SOURCES_PER_SESSION } from "./index.js";

describe("createSqliteContextBroker", () => {
  it("classifies lock, corruption, extended, and unknown startup errors", () => {
    expect(isSqliteLockedError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isSqliteLockedError(new Error("database table is locked"))).toBe(true);
    expect(isSqliteCorruptionError(Object.assign(new Error("corrupt"), { code: "SQLITE_CORRUPT_INDEX" }))).toBe(true);
    expect(isSqliteCorruptionError(new Error("file is not a database"))).toBe(true);
    expect(isSqliteLockedError(new Error("permission denied"))).toBe(false);
    expect(isSqliteCorruptionError(new Error("permission denied"))).toBe(false);
  });

  it("persists handles, payloads, tiers, and pin state without replay reconstruction", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 0, briefBytes: 800 });
      const warm = broker.publish({ sessionId: "s", kind: "tool_output", payload: "needle payload", summary: "warm summary", createdAt: Date.now() });
      const cold = broker.publish({ sessionId: "s", kind: "subagent_result", payload: "archived payload", summary: "cold archive", tier: "cold", createdAt: Date.now() + 1 });
      expect(broker.pin(cold.handle, true)?.tier).toBe("hot");

      broker = createSqliteContextBroker({ path, defaultTtlMs: 0, briefBytes: 800 });

      expect(broker.lookup({ handle: warm.handle })[0]?.payload).toBe("needle payload");
      const reloadedCold = broker.lookup({ handle: cold.handle })[0];
      expect(reloadedCold?.pinned).toBe(true);
      expect(reloadedCold?.tier).toBe("hot");
      expect(broker.renderBrief({ sessionId: "s" })).toContain(cold.handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains explicit source identity independently from parent lineage across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-source-id-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0 });
      const published = broker.publish({
        sessionId: "s",
        kind: "tool_output",
        payload: "producer payload",
        sourceId: "producer-a",
        parentIds: ["logical-parent"],
      });

      const reopened = createSqliteContextBroker({ path, defaultTtlMs: 0 });
      expect(reopened.lookup({ handle: published.handle })[0]).toMatchObject({
        sourceId: "producer-a",
        parentIds: ["logical-parent"],
      });
      expect(reopened.sourceSeen("s", "producer-a")).toBe(true);
      expect(reopened.sourceSeen("s", "logical-parent")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses SQLite FTS for text lookup and enforces tier caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const broker = createSqliteContextBroker({ path: join(dir, "artifacts.sqlite"), defaultTtlMs: 0, coldMaxRecords: 1 });
      const firstCold = broker.publish({ sessionId: "s", kind: "tool_output", payload: "alpha archive", tier: "cold", createdAt: Date.now() });
      const secondCold = broker.publish({ sessionId: "s", kind: "tool_output", payload: "needle beta archive", tier: "cold", createdAt: Date.now() + 1 });

      expect(broker.lookup({ id: firstCold.id })).toEqual([]);
      expect(broker.lookup({ text: "needle" })[0]?.handle).toBe(secondCold.handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists age-based tier cooling without deleting artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 0, hotToWarmMs: 100, warmToColdMs: 200, briefBytes: 900 });
      const now = Date.now();
      const oldHot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old hot", summary: "old hot", tier: "hot", createdAt: now - 300 });
      const pinned = broker.publish({ sessionId: "s", kind: "tool_output", payload: "pinned", summary: "pinned", tier: "hot", pinned: true, createdAt: now - 300 });

      broker.prune(now);
      broker = createSqliteContextBroker({ path, defaultTtlMs: 0, hotToWarmMs: 100, warmToColdMs: 200, briefBytes: 900 });

      expect(broker.lookup({ handle: oldHot.handle })[0]?.tier).toBe("cold");
      expect(broker.lookup({ handle: pinned.handle })[0]?.tier).toBe("hot");
      expect(broker.renderBrief({ sessionId: "s" })).not.toContain(oldHot.handle);
      expect(broker.renderBrief({ sessionId: "s" })).toContain(pinned.handle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cools protected new artifacts before enforcing durable tier caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const now = Date.now();
      const broker = createSqliteContextBroker({ path: join(dir, "artifacts.sqlite"), defaultTtlMs: 0, maxRecords: 10, hotMaxRecords: 1, hotToWarmMs: 10_000, warmToColdMs: 20_000 });
      const fresh = broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh", summary: "fresh", tier: "hot", createdAt: now - 1_000 });
      const aged = broker.publish({ sessionId: "s", kind: "tool_output", payload: "aged", summary: "aged", tier: "hot", createdAt: now - 30_000 });

      expect(aged.tier).toBe("cold");
      expect(broker.lookup({ handle: fresh.handle })[0]?.tier).toBe("hot");
      expect(broker.lookup({ handle: aged.handle })[0]?.tier).toBe("cold");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes replayed source artifacts so durable handles survive caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      const original = broker.publish({ sessionId: "s", kind: "tool_output", payload: "same replayed payload", parentIds: ["tool-call-1"], createdAt: Date.now() });

      broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      const replayed = broker.publish({ sessionId: "s", kind: "tool_output", payload: "same replayed payload", parentIds: ["tool-call-1"], createdAt: Date.now() + 1 });

      expect(replayed.handle).toBe(original.handle);
      expect(broker.lookup({ handle: original.handle })[0]?.payload).toBe("same replayed payload");
      expect(broker.status().records).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a deterministic source tombstone for an expired replayed source", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      const expired = broker.publish({ sessionId: "s", kind: "tool_output", payload: "expired payload", parentIds: ["tool-call-1"], createdAt: 1 });
      expect(broker.lookup({ handle: expired.handle })).toEqual([]);

      broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      const replayed = broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh replayed payload", parentIds: ["tool-call-1"], createdAt: 1, ttlMs: Date.now() + 60_000 });

      expect(replayed.handle).toBe(expired.handle);
      expect(replayed.payload).toBe("");
      expect(broker.lookup({ handle: replayed.handle })).toEqual([]);
      expect(broker.status().records).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges unpinned durable artifacts for a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 0 });
      const scratch = broker.publish({ sessionId: "s", kind: "tool_output", payload: "scratch" });
      const pinned = broker.publish({ sessionId: "s", kind: "tool_output", payload: "keep", pinned: true });
      const other = broker.publish({ sessionId: "other", kind: "tool_output", payload: "other" });

      broker.purge({ sessionId: "s", keepPinned: true });
      broker = createSqliteContextBroker({ path, defaultTtlMs: 0 });

      expect(broker.lookup({ handle: scratch.handle })).toEqual([]);
      expect(broker.lookup({ handle: pinned.handle })[0]?.payload).toBe("keep");
      expect(broker.lookup({ handle: other.handle })[0]?.payload).toBe("other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates the WAL after purge maintenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0 });
      for (let i = 0; i < 24; i += 1) {
        broker.publish({ sessionId: "s", kind: "tool_output", payload: `payload-${i}`, summary: `sum-${i}` });
      }

      const walPath = `${path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      const before = statSync(walPath).size;
      expect(before).toBeGreaterThan(0);

      broker.purge({ sessionId: "s", keepPinned: true });

      const after = existsSync(walPath) ? statSync(walPath).size : 0;
      expect(after).toBeLessThan(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates the WAL when publish clears expired artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      for (let i = 0; i < 24; i += 1) {
        broker.publish({ sessionId: "s", kind: "tool_output", payload: `payload-${i}`, summary: `sum-${i}` });
      }

      const walPath = `${path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      const before = statSync(walPath).size;
      expect(before).toBeGreaterThan(0);

      nowSpy.mockImplementation(() => now + 10_000);
      broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh payload", summary: "fresh" });

      const after = existsSync(walPath) ? statSync(walPath).size : 0;
      expect(after).toBeLessThan(before);
    } finally {
      nowSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates the WAL after lazy expiry cleanup", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      for (let i = 0; i < 24; i += 1) {
        broker.publish({ sessionId: "s", kind: "tool_output", payload: `payload-${i}`, summary: `sum-${i}` });
      }

      const walPath = `${path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      const before = statSync(walPath).size;
      expect(before).toBeGreaterThan(0);

      nowSpy.mockImplementation(() => now + 10_000);
      broker.status();

      const after = existsSync(walPath) ? statSync(walPath).size : 0;
      expect(after).toBeLessThan(before);
    } finally {
      nowSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries locked publish transactions without consuming a sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, busyTimeoutMs: 20, busyRetryAttempts: 1, busyRetryDelayMs: 1 });
      const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "first", summary: "first" });
      expect(first.id).toContain("-0001-");

      const lockDb = new DatabaseSync(path);
      try {
        lockDb.exec("BEGIN IMMEDIATE");
        expect(() => broker.publish({ sessionId: "s", kind: "tool_output", payload: "locked", summary: "locked" }))
          .toThrow(/database is locked/i);
      } finally {
        lockDb.exec("ROLLBACK");
        lockDb.close();
      }

      const second = broker.publish({ sessionId: "s", kind: "tool_output", payload: "second", summary: "second" });
      expect(second.id).toContain("-0002-");
      expect(broker.lookup({ handle: second.handle })[0]?.payload).toBe("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives database locks during prune cleanup", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 1, busyTimeoutMs: 100 });
      const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "locked payload", summary: "locked", createdAt: now, ttlMs: 1 });
      nowSpy.mockImplementation(() => now + 10_000);

      const lockDb = new DatabaseSync(path);
      try {
        lockDb.exec("BEGIN EXCLUSIVE");
        expect(() => broker.prune()).not.toThrow();
        expect(broker.lookup({ handle: artifact.handle })[0]?.payload).toBe("locked payload");
      } finally {
        try {
          lockDb.exec("ROLLBACK");
        } catch {
          // ignore rollback noise after releasing the lock
        }
        lockDb.close();
      }
    } finally {
      nowSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy artifact parent IDs into the source ledger before pruning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-legacy-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, sessionId TEXT NOT NULL, kind TEXT NOT NULL,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
          payload TEXT NOT NULL, summary TEXT NOT NULL, tagsJson TEXT NOT NULL, pathsJson TEXT NOT NULL,
          command TEXT, branch TEXT, tier TEXT NOT NULL, baseTier TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
          expiresAt INTEGER, pinned INTEGER NOT NULL DEFAULT 0, parentIdsJson TEXT NOT NULL
        );
        -- Simulate a database written before source-ledger ingestion order was
        -- persisted separately from the source event timestamp.
        CREATE TABLE source_ledger (
          sessionId TEXT NOT NULL, sourceId TEXT NOT NULL, handle TEXT, createdAt INTEGER NOT NULL,
          PRIMARY KEY(sessionId, sourceId)
        );
      `);
      legacy.prepare(`INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("legacy-id", "ctx://legacy", "s", "tool_output", 1, 1, 3, "hash", "old", "old", "[]", "[]", null, null, "hot", "hot", 1, null, 0, '["legacy-source"]');
      legacy.close();

      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      expect(broker.sourceSeen("s", "legacy-source")).toBe(true);
      const migrated = new DatabaseSync(path);
      expect(migrated.prepare("PRAGMA table_info(source_ledger)").all().map((row) => (row as { name: string }).name)).toContain("ingestedAt");
      expect(migrated.prepare("SELECT value FROM meta WHERE key = 'source-ledger-artifact-migration-v1'").get()).toMatchObject({ value: "1" });
      migrated.close();
      broker.prune();
      expect(broker.publishBatch([{ sessionId: "s", kind: "tool_output", payload: "replayed", sourceId: "legacy-source" }]))
        .toMatchObject({ published: 0, duplicateSources: 1 });

      // A later cap/eviction must survive reopen; the historical artifact is
      // not allowed to import it back into the ledger a second time.
      const evicted = new DatabaseSync(path);
      evicted.prepare("DELETE FROM source_ledger WHERE sessionId = ? AND sourceId = ?").run("s", "legacy-source");
      evicted.close();
      const reopened = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      expect(reopened.sourceSeen("s", "legacy-source")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a durable source ledger while an atomic batch prunes to its newest tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const now = Date.now();
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 64 });
      const inputs = Array.from({ length: 96 }, (_, index) => ({
        sessionId: "s", kind: "tool_output" as const, payload: `payload-${index}`, sourceId: `source-${index}`, createdAt: now + index,
      }));
      const first = broker.publishBatch(inputs);
      expect(first).toMatchObject({ scanned: 96, published: 96, duplicateSources: 0 });
      expect(broker.status().records).toBe(64);
      expect(broker.lookup({ sessionId: "s", limit: 64 }).at(-1)?.payload).toBe("payload-32");
      broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 64 });
      expect(broker.sourceSeen("s", "source-0")).toBe(true);
      const replay = broker.publishBatch(inputs);
      expect(replay).toMatchObject({ scanned: 96, published: 0, duplicateSources: 96 });
      expect(broker.status().records).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps SQLite provenance by ingestion order when a new backfill has an old timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-source-cap-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      broker.publishBatch(Array.from({ length: MAX_CONTEXT_SOURCES_PER_SESSION }, (_, index) => ({
        sessionId: "s", kind: "tool_output" as const, payload: `payload-${index}`, sourceId: `source-${index}`, createdAt: Date.now() + index,
      })));
      // A historical event arriving now must retain provenance as the newest
      // ingestion, rather than being evicted by its source-created timestamp.
      broker.publish({ sessionId: "s", kind: "tool_output", payload: "old event arriving now", sourceId: "late-old-source", createdAt: 1 });

      const reloaded = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      expect(reloaded.sourceSeen("s", "source-0")).toBe(false);
      expect(reloaded.sourceSeen("s", "late-old-source")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("globally caps SQLite provenance across sessions by oldest ingestion", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-global-source-cap-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const seeded = new DatabaseSync(path);
      seeded.exec(`
        CREATE TABLE source_ledger (
          sessionId TEXT NOT NULL,
          sourceId TEXT NOT NULL,
          handle TEXT,
          createdAt INTEGER NOT NULL,
          ingestedAt INTEGER NOT NULL,
          PRIMARY KEY(sessionId, sourceId)
        );
        BEGIN IMMEDIATE;
      `);
      const insert = seeded.prepare("INSERT INTO source_ledger(sessionId, sourceId, handle, createdAt, ingestedAt) VALUES (?, ?, ?, ?, ?)");
      for (let index = 0; index <= MAX_CONTEXT_SOURCES_GLOBAL; index += 1) {
        insert.run(`s-${index % 32}`, `source-${index}`, `ctx://source/${index}`, index, index + 1);
      }
      seeded.exec("COMMIT");
      seeded.close();

      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      expect(broker.status().records).toBe(0);
      expect(broker.sourceSeen("s-0", "source-0")).toBe(false);
      expect(broker.sourceSeen(`s-${MAX_CONTEXT_SOURCES_GLOBAL % 32}`, `source-${MAX_CONTEXT_SOURCES_GLOBAL}`)).toBe(true);
      const db = new DatabaseSync(path);
      expect(Number((db.prepare("SELECT COUNT(*) AS count FROM source_ledger").get() as { count: number }).count)).toBe(MAX_CONTEXT_SOURCES_GLOBAL);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs one post-commit WAL checkpoint for a pruning batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-batch-wal-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({ path, defaultTtlMs: 0, maxRecords: 1 });
      const batch = broker.publishBatch([
        { sessionId: "s", kind: "tool_output", payload: "old", createdAt: 1 },
        { sessionId: "s", kind: "tool_output", payload: "new", createdAt: 2 },
      ]);
      expect(batch.pruned).toBe(1);
      expect(broker.status().records).toBe(1);
      const walPath = `${path}-wal`;
      expect(existsSync(walPath) ? statSync(walPath).size : 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces optional global caps across sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      const broker = createSqliteContextBroker({
        path,
        defaultTtlMs: 0,
        globalMaxBytes: 10,
        globalMaxRecords: Number.POSITIVE_INFINITY,
      });
      const one = broker.publish({ sessionId: "s1", kind: "tool_output", payload: "aaa", summary: "first" });
      const two = broker.publish({ sessionId: "s2", kind: "tool_output", payload: "bbb", summary: "second" });
      const pinned = broker.publish({ sessionId: "s3", kind: "tool_output", payload: "ccc", summary: "third", pinned: true });
      const four = broker.publish({ sessionId: "s1", kind: "tool_output", payload: "ddd", summary: "fourth" });

      expect(broker.lookup({ handle: one.handle })).toEqual([]);
      expect(broker.lookup({ handle: two.handle })[0]?.payload).toBe("bbb");
      expect(broker.lookup({ handle: pinned.handle })[0]?.payload).toBe("ccc");
      expect(broker.lookup({ handle: four.handle })[0]?.payload).toBe("ddd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
