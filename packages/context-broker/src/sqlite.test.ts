import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createSqliteContextBroker, isSqliteCorruptionError, isSqliteLockedError } from "./sqlite.js";

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

  it("republishes expired replayed sources instead of returning dead handles", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-sqlite-test-"));
    try {
      const path = join(dir, "artifacts.sqlite");
      let broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      const expired = broker.publish({ sessionId: "s", kind: "tool_output", payload: "expired payload", parentIds: ["tool-call-1"], createdAt: 1 });
      expect(broker.lookup({ handle: expired.handle })).toEqual([]);

      broker = createSqliteContextBroker({ path, defaultTtlMs: 1 });
      const replayed = broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh replayed payload", parentIds: ["tool-call-1"], createdAt: 1, ttlMs: Date.now() + 60_000 });

      expect(replayed.handle).not.toBe(expired.handle);
      expect(broker.lookup({ handle: replayed.handle })[0]?.payload).toBe("fresh replayed payload");
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
