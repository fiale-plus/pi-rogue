import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteContextBroker } from "./sqlite.js";

describe("createSqliteContextBroker", () => {
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
});
