import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryContextBroker, MAX_CONTEXT_SOURCES_GLOBAL, MAX_CONTEXT_SOURCES_PER_SESSION, rememberSource } from "./index.js";

describe("createInMemoryContextBroker", () => {
  it("publishes stable, unique handles and looks up artifacts by handle", () => {
    const broker = createInMemoryContextBroker();
    const first = broker.publish({
      sessionId: "session-a",
      kind: "tool_output",
      payload: "same payload",
      summary: "tests passed",
      tags: ["test"],
      paths: ["packages/core"],
    });
    const second = broker.publish({
      sessionId: "session-a",
      kind: "tool_output",
      payload: "same payload",
      summary: "same payload repeat",
      tags: ["test"],
      paths: ["packages/core"],
    });

    expect(first.handle).not.toEqual(second.handle);
    expect(first.handle).toMatch(/^ctx:\/\/session\/session-a\/tool_output\//);
    expect(broker.lookup({ handle: first.handle })).toEqual([first]);
    expect(broker.lookup({ handle: second.handle })).toEqual([second]);
  });

  it("filters by session, kind, tag, path, and text", () => {
    const broker = createInMemoryContextBroker();
    const core = broker.publish({
      sessionId: "s1",
      kind: "tool_output",
      payload: "vitest packages/core passed",
      tags: ["test", "core"],
      paths: ["packages/core/src/context-broker.ts"],
    });
    broker.publish({
      sessionId: "s2",
      kind: "advisor_brief",
      payload: "different payload",
      tags: ["advisor"],
      paths: ["packages/advisor/src/router.ts"],
    });

    expect(broker.lookup({ sessionId: "s1", kind: "tool_output", tag: "core" })).toEqual([core]);
    expect(broker.lookup({ path: "packages/core" })).toEqual([core]);
    expect(broker.lookup({ text: "vitest" })).toEqual([core]);
    expect(broker.lookup({ sessionId: "s2", kind: "tool_output" })).toEqual([]);
  });

  it("keeps legacy fusion_result artifacts queryable for upgrades", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 500 });
    const artifact = broker.publish({
      sessionId: "s",
      kind: "fusion_result",
      payload: JSON.stringify({ responses: ["legacy panel output"] }),
      summary: "legacy Fusion result retained for lookup",
      tags: ["legacy"],
      tier: "warm",
    } as any);

    expect(broker.lookup({ sessionId: "s", kind: "fusion_result" })).toEqual([artifact]);
    expect(broker.renderBrief({ sessionId: "s", kind: "fusion_result" })).toContain("legacy Fusion result retained for lookup");
  });

  it("uses a metadata-only summary when callers omit summaries", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 500 });
    const artifact = broker.publish({
      sessionId: "s",
      kind: "tool_output",
      payload: "SECRET_TOKEN=abc123\n".repeat(20),
      paths: ["logs/secret-output.txt"],
    });

    const brief = broker.renderBrief({ sessionId: "s" });

    expect(artifact.summary).toContain("payload stored externally");
    expect(artifact.summary).not.toContain("SECRET_TOKEN");
    expect(brief).not.toContain("SECRET_TOKEN");
    expect(brief).toContain(artifact.handle);
  });

  it("enforces record caps by pruning oldest unpinned artifacts", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 2, defaultTtlMs: 0 });
    const first = broker.publish({ sessionId: "s", kind: "memory_note", payload: "one", createdAt: 1 });
    const second = broker.publish({ sessionId: "s", kind: "memory_note", payload: "two", createdAt: 2 });
    const third = broker.publish({ sessionId: "s", kind: "memory_note", payload: "three", createdAt: 3 });

    expect(broker.lookup({ id: first.id })).toEqual([]);
    expect(broker.lookup({ id: second.id })).toEqual([second]);
    expect(broker.lookup({ id: third.id })).toEqual([third]);
    expect(broker.status().records).toBe(2);
  });

  it("applies caps independently per session", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 1, defaultTtlMs: 0 });
    const sessionOne = broker.publish({ sessionId: "s1", kind: "tool_output", payload: "one", createdAt: 1 });
    const sessionTwo = broker.publish({ sessionId: "s2", kind: "tool_output", payload: "two", createdAt: 2 });

    expect(broker.lookup({ sessionId: "s1" })).toEqual([sessionOne]);
    expect(broker.lookup({ sessionId: "s2" })).toEqual([sessionTwo]);
    expect(broker.status().records).toBe(2);
  });

  it("uses sequence tie-breakers when createdAt timestamps tie", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 2, defaultTtlMs: 0 });
    const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "alpha", createdAt: 1000 });
    const second = broker.publish({ sessionId: "s", kind: "tool_output", payload: "bravo", createdAt: 1000 });
    const third = broker.publish({ sessionId: "s", kind: "tool_output", payload: "charlie", createdAt: 1000 });

    expect(broker.lookup({ id: first.id })).toEqual([]);
    expect(broker.lookup({ id: second.id })).toEqual([second]);
    expect(broker.lookup({ id: third.id })).toEqual([third]);
  });

  it("enforces byte caps by pruning oldest unpinned artifacts", () => {
    const broker = createInMemoryContextBroker({ maxBytes: 6, defaultTtlMs: 0 });
    const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "12345", createdAt: 1 });
    const second = broker.publish({ sessionId: "s", kind: "tool_output", payload: "abcde", createdAt: 2 });

    expect(broker.lookup({ id: first.id })).toEqual([]);
    expect(broker.lookup({ id: second.id })).toEqual([second]);
    expect(broker.status().bytes).toBe(5);
  });

  it("preserves the returned handle when a new artifact exceeds maxBytes", () => {
    const broker = createInMemoryContextBroker({ maxBytes: 4, defaultTtlMs: 0 });
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "oversized", createdAt: 1 });

    expect(broker.lookup({ id: artifact.id })).toEqual([artifact]);
    expect(broker.lookup({ handle: artifact.handle })).toEqual([artifact]);
    expect(broker.status().bytes).toBe(Buffer.byteLength("oversized", "utf8"));
  });

  it("computes bytes and SHA-256 on raw Buffer payload bytes", () => {
    const broker = createInMemoryContextBroker({ maxBytes: 1024, defaultTtlMs: 0 });
    const payload = Buffer.from([0x66, 0xff, 0x61, 0x62, 0x80, 0x00]);
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload, createdAt: 1 });
    const expectedSha = createHash("sha256").update(payload).digest("hex");

    expect(artifact.bytes).toBe(payload.length);
    expect(artifact.sha256).toBe(expectedSha);
    expect(Buffer.byteLength(artifact.payload, "utf8")).toBeGreaterThan(artifact.bytes);
  });

  it("keeps pinned artifacts visible while pruning unpinned records", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 2, defaultTtlMs: 0 });
    const pinned = broker.publish({ sessionId: "s", kind: "diff", payload: "important", pinned: true, createdAt: 1 });
    const older = broker.publish({ sessionId: "s", kind: "diff", payload: "temporary", createdAt: 2 });
    const newer = broker.publish({ sessionId: "s", kind: "diff", payload: "latest", createdAt: 3 });

    expect(broker.lookup({ id: pinned.id })).toEqual([pinned]);
    expect(broker.lookup({ id: older.id })).toEqual([]);
    expect(broker.lookup({ id: newer.id })).toEqual([newer]);
    expect(broker.status().pinnedRecords).toBe(1);
  });

  it("expires unpinned artifacts by ttl", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 10 });
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old", createdAt: 100 });

    broker.prune(111);

    expect(broker.lookup({ id: artifact.id })).toEqual([]);
  });

  it("prunes expired artifacts before lookup without an explicit prune call", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 1 });
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "expired", createdAt: 1 });

    expect(broker.lookup({ id: artifact.id })).toEqual([]);
    expect(broker.status().records).toBe(0);
  });

  it("omits expired artifacts from rendered prompt briefs", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 1, briefBytes: 500 });
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "expired secret", summary: "expired summary", createdAt: 1 });

    const brief = broker.renderBrief({ sessionId: "s" });

    expect(brief).not.toContain(artifact.handle);
    expect(brief).not.toContain("expired summary");
  });

  it("keeps pinned expired artifacts visible until unpinned", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 1 });
    const artifact = broker.publish({ sessionId: "s", kind: "tool_output", payload: "pinned", pinned: true, createdAt: 1 });

    expect(broker.lookup({ id: artifact.id })).toEqual([artifact]);
    expect(broker.pin(artifact.id, false)).toBeNull();
    expect(broker.lookup({ id: artifact.id })).toEqual([]);
  });

  it("classifies artifacts into hot, warm, and cold tiers on publish", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 0 });
    const failure = broker.publish({ sessionId: "s", kind: "tool_output", payload: "failed", tags: ["error"], createdAt: 1 });
    const command = broker.publish({ sessionId: "s", kind: "tool_output", payload: "passed", tags: ["ok"], createdAt: 2 });
    const archive = broker.publish({ sessionId: "s", kind: "subagent_result", payload: "old", tags: ["completed"], createdAt: 3 });
    const explicit = broker.publish({ sessionId: "s", kind: "diff", payload: "manual", tier: "cold", createdAt: 4 });

    expect(failure.tier).toBe("hot");
    expect(command.tier).toBe("warm");
    expect(archive.tier).toBe("cold");
    expect(explicit.tier).toBe("cold");
    expect(broker.lookup({ sessionId: "s", tier: "cold" }).map((artifact) => artifact.id)).toEqual([explicit.id, archive.id]);
  });

  it("cools old artifacts across hot, warm, and cold tiers without deleting them", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 1200, defaultTtlMs: 0, hotToWarmMs: 100, warmToColdMs: 200 });
    const now = Date.now();
    const oldHot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old-hot", summary: "old hot", tier: "hot", createdAt: now - 300 });
    const oldWarm = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old-warm", summary: "old warm", tier: "warm", createdAt: now - 300 });
    const freshHot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh-hot", summary: "fresh hot", tier: "hot", createdAt: now - 50 });
    const pinned = broker.publish({ sessionId: "s", kind: "tool_output", payload: "pinned", summary: "pinned hot", tier: "hot", pinned: true, createdAt: now - 300 });

    broker.prune(now);

    expect(broker.lookup({ handle: oldHot.handle })[0]?.tier).toBe("cold");
    expect(broker.lookup({ handle: oldWarm.handle })[0]?.tier).toBe("cold");
    expect(broker.lookup({ handle: freshHot.handle })[0]?.tier).toBe("hot");
    expect(broker.lookup({ handle: pinned.handle })[0]?.tier).toBe("hot");
    const brief = broker.renderBrief({ sessionId: "s" });
    expect(brief).not.toContain(oldHot.handle);
    expect(brief).not.toContain(oldWarm.handle);
    expect(brief).toContain(freshHot.handle);
    expect(brief).toContain(pinned.handle);
  });

  it("cools protected new artifacts before enforcing tier caps", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 0, maxRecords: 10, hotMaxRecords: 1, hotToWarmMs: 10_000, warmToColdMs: 20_000 });
    const now = Date.now();
    const fresh = broker.publish({ sessionId: "s", kind: "tool_output", payload: "fresh", summary: "fresh", tier: "hot", createdAt: now - 1_000 });
    const aged = broker.publish({ sessionId: "s", kind: "tool_output", payload: "aged", summary: "aged", tier: "hot", createdAt: now - 30_000 });

    expect(aged.tier).toBe("cold");
    expect(broker.lookup({ handle: fresh.handle })[0]?.tier).toBe("hot");
    expect(broker.lookup({ handle: aged.handle })[0]?.tier).toBe("cold");
  });

  it("renders prompt briefs hot-first, warm-second, and excludes cold unless explicit", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 900, defaultTtlMs: 0 });
    const cold = broker.publish({ sessionId: "s", kind: "tool_output", payload: "cold", summary: "cold archive", tier: "cold", createdAt: 1 });
    const warm = broker.publish({ sessionId: "s", kind: "tool_output", payload: "warm", summary: "warm command", tier: "warm", createdAt: 2 });
    const hot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "hot", summary: "hot failure", tier: "hot", createdAt: 3 });

    const brief = broker.renderBrief({ sessionId: "s" });
    expect(brief).toContain("Hot:");
    expect(brief).toContain(hot.handle);
    expect(brief).toContain("Warm:");
    expect(brief).toContain(warm.handle);
    expect(brief).not.toContain(cold.handle);
    expect(brief.indexOf(hot.handle)).toBeLessThan(brief.indexOf(warm.handle));

    const coldBrief = broker.renderBrief({ sessionId: "s", tier: "cold", budgetBytes: 500 });
    expect(coldBrief).toContain("Cold:");
    expect(coldBrief).toContain(cold.handle);

    expect(broker.pin(cold.handle, true)?.tier).toBe("hot");
    expect(broker.renderBrief({ sessionId: "s" })).toContain(cold.handle);
    expect(broker.pin(cold.handle, false)?.tier).toBe("cold");
    expect(broker.renderBrief({ sessionId: "s" })).not.toContain(cold.handle);
  });

  it("applies tier-specific record, byte, and ttl retention", () => {
    const broker = createInMemoryContextBroker({
      defaultTtlMs: 0,
      hotMaxRecords: 1,
      warmMaxBytes: 6,
      coldTtlMs: 10,
    });
    const oldHot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old-hot", tier: "hot", createdAt: 1 });
    const newHot = broker.publish({ sessionId: "s", kind: "tool_output", payload: "new-hot", tier: "hot", createdAt: 2 });
    const oldWarm = broker.publish({ sessionId: "s", kind: "tool_output", payload: "12345", tier: "warm", createdAt: 3 });
    const newWarm = broker.publish({ sessionId: "s", kind: "tool_output", payload: "abcde", tier: "warm", createdAt: 4 });
    const cold = broker.publish({ sessionId: "s", kind: "tool_output", payload: "cold", tier: "cold", createdAt: 5 });

    expect(broker.lookup({ id: oldHot.id })).toEqual([]);
    expect(broker.lookup({ id: newHot.id })).toEqual([newHot]);
    expect(broker.lookup({ id: oldWarm.id })).toEqual([]);
    expect(broker.lookup({ id: newWarm.id })).toEqual([newWarm]);

    broker.prune(16);
    expect(broker.lookup({ id: cold.id })).toEqual([]);
  });

  it("renders empty prompt briefs without fake handles", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 180 });

    const brief = broker.renderBrief({ sessionId: "empty" });

    expect(brief).toContain("Context Broker");
    expect(brief).toContain("context_lookup");
    expect(brief).not.toContain("ctx://");
  });

  it("renders a bounded prompt brief with lookup instructions", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 500 });
    broker.publish({
      sessionId: "s",
      kind: "tool_output",
      payload: "x".repeat(500),
      summary: "large command output passed with no failures",
      tags: ["test"],
      paths: ["packages/core"],
    });

    const brief = broker.renderBrief();

    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(500);
    expect(brief).toContain("Context Broker");
    expect(brief).toContain("ctx://session/s/tool_output/");
    expect(brief).toContain("context_lookup");
  });

  it("enforces prompt brief budgets by UTF-8 byte length", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 170 });
    broker.publish({
      sessionId: "emoji-session",
      kind: "tool_output",
      payload: "✅".repeat(200),
      summary: "✅ 測試 passed ".repeat(20),
      tags: ["測試", "✅"],
      paths: ["packages/核心/✅.ts"],
    });

    const brief = broker.renderBrief({ budgetBytes: 170 });

    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(170);
    expect(brief).toContain("Context Broker");
  });

  it("purges unpinned session artifacts while retaining pinned evidence", () => {
    const broker = createInMemoryContextBroker();
    const unpinned = broker.publish({ sessionId: "s", kind: "tool_output", payload: "scratch", summary: "scratch" });
    const pinned = broker.publish({ sessionId: "s", kind: "tool_output", payload: "keep", summary: "keep", pinned: true });
    const other = broker.publish({ sessionId: "other", kind: "tool_output", payload: "other", summary: "other" });

    const status = broker.purge({ sessionId: "s", keepPinned: true });

    expect(status.records).toBe(2);
    expect(broker.lookup({ handle: unpinned.handle })).toEqual([]);
    expect(broker.lookup({ handle: pinned.handle })[0]?.payload).toBe("keep");
    expect(broker.lookup({ handle: other.handle })[0]?.payload).toBe("other");
  });

  it("keeps in-memory source provenance after a batch prunes its artifacts", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 1, defaultTtlMs: 0 });
    const first = broker.publishBatch([
      { sessionId: "s", kind: "tool_output", payload: "first", sourceId: "first-source", createdAt: 1 },
      { sessionId: "s", kind: "tool_output", payload: "second", sourceId: "second-source", createdAt: 2 },
    ]);
    expect(first).toMatchObject({ published: 2, pruned: 1 });
    expect(broker.sourceSeen("s", "first-source")).toBe(true);
    expect(broker.publishBatch([{ sessionId: "s", kind: "tool_output", payload: "replay", sourceId: "first-source" }])).toMatchObject({ published: 0, duplicateSources: 1 });
  });

  it("caps in-memory source provenance while retaining its newest session tail", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 1, defaultTtlMs: 0 });
    broker.publishBatch(Array.from({ length: MAX_CONTEXT_SOURCES_PER_SESSION + 1 }, (_, index) => ({
      sessionId: "s", kind: "tool_output" as const, payload: `payload-${index}`, sourceId: `source-${index}`, createdAt: index,
    })));

    expect(broker.sourceSeen("s", "source-0")).toBe(false);
    expect(broker.sourceSeen("s", `source-${MAX_CONTEXT_SOURCES_PER_SESSION}`)).toBe(true);
  });

  it("globally caps provenance across many sessions by oldest ingestion", () => {
    const sources = new Map<string, string>();
    for (let index = 0; index <= MAX_CONTEXT_SOURCES_GLOBAL; index += 1) {
      const sessionId = `session-${index % 32}`;
      rememberSource(sources, sessionId, `source-${index}`, `handle-${index}`);
    }

    expect(sources.size).toBe(MAX_CONTEXT_SOURCES_GLOBAL);
    expect(sources.has("session-0\u0000source-0")).toBe(false);
    expect(sources.get(`session-${MAX_CONTEXT_SOURCES_GLOBAL % 32}\u0000source-${MAX_CONTEXT_SOURCES_GLOBAL}`)).toBe(`handle-${MAX_CONTEXT_SOURCES_GLOBAL}`);
  });

  it("does not republish a single source whose artifact was pruned", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 1, defaultTtlMs: 0 });
    const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old", sourceId: "old-source", createdAt: 1 });
    broker.publish({ sessionId: "s", kind: "tool_output", payload: "new", sourceId: "new-source", createdAt: 2 });

    const replay = broker.publish({ sessionId: "s", kind: "tool_output", payload: "must not persist", sourceId: "old-source", createdAt: 3 });

    expect(replay.handle).toBe(first.handle);
    expect(replay.payload).toBe("");
    expect(broker.status().records).toBe(1);
    expect(broker.lookup({ text: "must not persist" })).toEqual([]);
  });

  it("validates a single source ID before mutating in-memory artifacts", () => {
    const broker = createInMemoryContextBroker();

    expect(() => broker.publish({ sessionId: "s", kind: "tool_output", payload: "invalid", sourceId: "bad\0source" })).toThrow(/Invalid context broker sourceId/);
    expect(broker.status().records).toBe(0);
  });

  it("enforces optional global caps across sessions", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 8, globalMaxRecords: 2 });
    const first = broker.publish({ sessionId: "s1", kind: "tool_output", payload: "alpha", summary: "alpha" });
    const second = broker.publish({ sessionId: "s2", kind: "tool_output", payload: "bravo", summary: "bravo" });
    const pinned = broker.publish({ sessionId: "s3", kind: "tool_output", payload: "charlie", summary: "charlie", pinned: true });
    broker.publish({ sessionId: "s1", kind: "tool_output", payload: "delta", summary: "delta" });

    expect(broker.lookup({ handle: first.handle })).toEqual([]);
    expect(broker.lookup({ handle: second.handle })).toEqual([]);
    expect(broker.lookup({ handle: pinned.handle })[0]?.payload).toBe("charlie");
  });
});
