import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fsRequire = createRequire(import.meta.url)("node:fs");
import { createFileContextBroker } from "./file.js";
import { MAX_CONTEXT_SOURCES_GLOBAL, MAX_CONTEXT_SOURCES_PER_SESSION } from "./index.js";

const input = (payload: string, createdAt?: number) => ({ sessionId: "jsonl-prune", kind: "tool_output" as const, payload, createdAt });

describe("file context broker durable pruning", () => {
  it("keeps startup bounded and does not let pin resurrect an auto-evicted record", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-startup-cap-"));
    const broker = createFileContextBroker({ dir, maxRecords: 1 });
    const first = broker.publish(input("auto-evicted payload"));
    broker.publish(input("retained payload"));
    expect(broker.status().records).toBe(1);

    const restarted = createFileContextBroker({ dir, maxRecords: 1 });
    expect(restarted.status().records).toBe(1);
    expect(restarted.pin(first.handle, true)).toBeNull();
    expect(restarted.status().records).toBe(1);
  });

  it("atomically persists record caps and removes unreferenced blobs across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-cap-"));
    const broker = createFileContextBroker({ dir, maxRecords: 1 });
    const first = broker.publish(input("first synthetic payload"));
    const second = broker.publish(input("second synthetic payload"));

    broker.prune();

    const lines = readFileSync(join(dir, "metadata.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(readdirSync(join(dir, "blobs")).filter((name) => name.endsWith(".txt"))).toHaveLength(1);
    const restarted = createFileContextBroker({ dir, maxRecords: 1 });
    expect(restarted.lookup({ handle: first.handle })).toEqual([]);
    expect(restarted.lookup({ handle: second.handle })).toHaveLength(1);
  });

  it("prunes a higher-cap checkpoint before serving a lower-cap reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-refresh-cap-"));
    const widerWriter = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 3 });
    const first = widerWriter.publish(input("first checkpoint payload"));
    widerWriter.publish(input("second checkpoint payload"));
    const latest = widerWriter.publish(input("latest checkpoint payload"));

    const constrainedReader = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });

    expect(constrainedReader.status().records).toBe(1);
    expect(constrainedReader.lookup({ handle: first.handle })).toEqual([]);
    expect(constrainedReader.lookup({ handle: latest.handle })).toHaveLength(1);
    expect(constrainedReader.renderBrief({ sessionId: "jsonl-prune" })).not.toContain("first checkpoint payload");
    expect(constrainedReader.renderBrief({ sessionId: "jsonl-prune" })).toContain(latest.handle);
  });

  it("removes single-publish blobs that the committed checkpoint no longer references", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-single-blob-prune-"));
    const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    const first = broker.publish(input("orphaned single-publish payload"));
    const retained = broker.publish(input("retained single-publish payload"));

    expect(readdirSync(join(dir, "blobs")).filter((name) => name.endsWith(".txt"))).toEqual([`${retained.sha256}.txt`]);
    expect(existsSync(join(dir, "blobs", `${first.sha256}.txt`))).toBe(false);
  });

  it("assigns distinct durable identities to concurrent identical publications", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-publish-collision-"));
    const firstBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const secondBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const createdAt = Date.now();
    const first = firstBroker.publish(input("identical concurrent payload", createdAt));
    const second = secondBroker.publish(input("identical concurrent payload", createdAt));

    expect(second.id).not.toBe(first.id);
    expect(second.handle).not.toBe(first.handle);
    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restarted.lookup({ id: first.id })).toHaveLength(1);
    expect(restarted.lookup({ id: second.id })).toHaveLength(1);
  });

  it("deduplicates source IDs within a session but not across sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-source-session-"));
    const broker = createFileContextBroker({ dir, maxRecords: 10 });
    const first = broker.publish({ ...input("session A payload"), sessionId: "session-a", parentIds: ["shared-call"] });
    const replay = broker.publish({ ...input("session A replay"), sessionId: "session-a", parentIds: ["shared-call"] });
    const second = broker.publish({ ...input("session B payload"), sessionId: "session-b", parentIds: ["shared-call"] });

    expect(replay.handle).toBe(first.handle);
    expect(second.handle).not.toBe(first.handle);
    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restarted.lookup({ sessionId: "session-a", text: "session A payload" })).toHaveLength(1);
    expect(restarted.lookup({ sessionId: "session-b", text: "session B payload" })).toHaveLength(1);
  });

  it("retains records appended by another broker instance before compaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-concurrent-"));
    const firstBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const secondBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const first = firstBroker.publish(input("first process payload"));
    const second = secondBroker.publish(input("second process payload"));

    firstBroker.prune();
    firstBroker.prune();

    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restarted.lookup({ handle: first.handle })).toHaveLength(1);
    expect(restarted.lookup({ handle: second.handle })).toHaveLength(1);
    expect(readFileSync(join(dir, "metadata.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("applies explicit purge filters to records appended by another broker instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-purge-concurrent-"));
    const firstBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const secondBroker = createFileContextBroker({ dir, maxRecords: 10 });
    const external = secondBroker.publish(input("external purge payload"));

    firstBroker.purge();

    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restarted.lookup({ handle: external.handle })).toEqual([]);
    expect(readFileSync(join(dir, "metadata.jsonl"), "utf8")).toBe("");
  });

  it("keeps the checkpoint committed when a JSONL compatibility projection fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-projection-failure-"));
    try {
      const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 10 });
      broker.publish({ sessionId: "s", kind: "tool_output", payload: "first", sourceId: "first" });
      rmSync(join(dir, "source-ledger.jsonl"));
      mkdirSync(join(dir, "source-ledger.jsonl"));

      expect(() => broker.publish({ sessionId: "s", kind: "tool_output", payload: "second", sourceId: "second" })).not.toThrow();
      const checkpoint = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
      expect(checkpoint.records).toHaveLength(2);
      expect(checkpoint.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual(["first", "second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes stale instance reads after another instance purges", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-read-refresh-"));
    const staleReader = createFileContextBroker({ dir, maxRecords: 10 });
    const artifact = staleReader.publish(input("purged by a different instance"));
    const purger = createFileContextBroker({ dir, maxRecords: 10 });

    purger.purge({ keepPinned: false });

    expect(staleReader.lookup({ handle: artifact.handle })).toEqual([]);
    expect(staleReader.status().records).toBe(0);
    expect(staleReader.renderBrief({ sessionId: "jsonl-prune" })).not.toContain("purged by a different instance");

    const compactDir = mkdtempSync(join(tmpdir(), "ctx-file-read-compact-refresh-"));
    const staleAfterCompaction = createFileContextBroker({ dir: compactDir, defaultTtlMs: 10, maxRecords: 10 });
    const expired = staleAfterCompaction.publish(input("expired by another compaction", Date.now() - 1_000));
    const compactor = createFileContextBroker({ dir: compactDir, defaultTtlMs: 10, maxRecords: 10 });
    compactor.prune(Date.now());

    expect(staleAfterCompaction.lookup({ handle: expired.handle })).toEqual([]);
    expect(staleAfterCompaction.status().records).toBe(0);
    expect(staleAfterCompaction.renderBrief({ sessionId: "jsonl-prune" })).not.toContain("expired by another compaction");
  });

  it("preserves concurrent pin updates and does not resurrect concurrent purges", () => {
    const pinnedDir = mkdtempSync(join(tmpdir(), "ctx-file-pin-concurrent-"));
    const seed = createFileContextBroker({ dir: pinnedDir, maxRecords: 10 });
    const artifact = seed.publish(input("shared mutable payload"));
    const pinningBroker = createFileContextBroker({ dir: pinnedDir, maxRecords: 10 });
    const compactingBroker = createFileContextBroker({ dir: pinnedDir, maxRecords: 10 });
    pinningBroker.pin(artifact.handle, true);
    compactingBroker.prune();
    expect(createFileContextBroker({ dir: pinnedDir, maxRecords: 10 }).lookup({ handle: artifact.handle })[0]?.pinned).toBe(true);

    const purgeDir = mkdtempSync(join(tmpdir(), "ctx-file-purge-stale-"));
    const purgeSeed = createFileContextBroker({ dir: purgeDir, maxRecords: 10 });
    const purged = purgeSeed.publish(input("must stay purged"));
    const purgingBroker = createFileContextBroker({ dir: purgeDir, maxRecords: 10 });
    const staleBroker = createFileContextBroker({ dir: purgeDir, maxRecords: 10 });
    purgingBroker.purge({ keepPinned: false });
    staleBroker.prune();
    expect(createFileContextBroker({ dir: purgeDir, maxRecords: 10 }).lookup({ handle: purged.handle })).toEqual([]);
  });

  it("pins the correct persisted ID when replayed duplicate IDs swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-id-collision-"));
    const createdAt = Date.now();
    const original = createFileContextBroker({ dir, maxRecords: 10 });
    const first = original.publish(input("duplicate payload", createdAt));
    const second = original.publish(input("duplicate payload", createdAt));
    original.prune();

    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    restarted.pin(first.id, true);
    const afterPin = createFileContextBroker({ dir, maxRecords: 10 });

    expect(afterPin.lookup({ id: first.id })[0]?.pinned).toBe(true);
    expect(afterPin.lookup({ id: second.id })[0]?.pinned).toBe(false);
  });

  it("preserves issued handles across reordered compaction and repeated restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-alias-"));
    const original = createFileContextBroker({ dir, maxRecords: 10 });
    const first = original.publish(input("first alias payload"));
    const second = original.publish(input("second alias payload"));
    original.prune();

    const restarted = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restarted.lookup({ handle: first.handle })).toHaveLength(1);
    expect(restarted.lookup({ handle: first.handle })[0]?.handle).toBe(first.handle);
    expect(restarted.lookup({ id: first.id })[0]?.id).toBe(first.id);
    expect(restarted.renderBrief({ handle: first.handle })).toContain(first.handle);
    expect(restarted.lookup({ handle: second.handle })).toHaveLength(1);
    restarted.prune();
    const visibleHandle = restarted.lookup({ text: "first alias payload" })[0]?.handle;
    expect(visibleHandle).toBe(first.handle);
    restarted.pin(first.id, true);

    const restartedAgain = createFileContextBroker({ dir, maxRecords: 10 });
    expect(restartedAgain.lookup({ handle: first.handle })).toHaveLength(1);
    expect(restartedAgain.lookup({ handle: first.handle })[0]?.pinned).toBe(true);
    expect(restartedAgain.lookup({ handle: second.handle })).toHaveLength(1);
    expect(restartedAgain.status().records).toBe(2);
  });

  it("snapshots exactly the caller's historical prune timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-historical-"));
    const createdAt = Date.now() - 1_000;
    const broker = createFileContextBroker({ dir, defaultTtlMs: 500 });
    const artifact = broker.publish(input("historically retained payload", createdAt));

    const status = broker.prune(createdAt + 100);

    expect(status.records).toBe(1);
    expect(readFileSync(join(dir, "metadata.jsonl"), "utf8")).toContain(artifact.handle);
  });

  it("seeds every legacy JSONL source before its first prune checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-legacy-source-migration-"));
    mkdirSync(join(dir, "blobs"));
    const records = ["old", "new"].map((payload, index) => {
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const handle = `ctx://legacy/${payload}`;
      writeFileSync(join(dir, "blobs", `${sha256}.txt`), payload);
      return {
        version: 1,
        id: `legacy-${payload}`,
        sequence: index + 1,
        handle,
        baseTier: "warm",
        input: { sessionId: "s", kind: "tool_output", parentIds: [`${payload}-source`], createdAt: index + 1, payloadSha256: sha256 },
      };
    });
    writeFileSync(join(dir, "metadata.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    // status refreshes the legacy JSONL replay, which must honor the current
    // cap before exposing it just like a higher-cap checkpoint does.
    expect(broker.status().records).toBe(1);
    broker.prune();

    expect(broker.sourceSeen("s", "old-source")).toBe(true);
    expect(broker.publishBatch([{ sessionId: "s", kind: "tool_output", payload: "must not persist", sourceId: "old-source" }]))
      .toMatchObject({ published: 0, duplicateSources: 1 });
  });

  it("caps JSONL checkpoint provenance while retaining the newest source tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-source-cap-"));
    try {
      const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
      broker.publishBatch(Array.from({ length: MAX_CONTEXT_SOURCES_PER_SESSION + 1 }, (_, index) => ({
        sessionId: "s", kind: "tool_output" as const, payload: `payload-${index}`, sourceId: `source-${index}`, createdAt: index,
      })));
      const reloaded = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
      expect(reloaded.sourceSeen("s", "source-0")).toBe(false);
      expect(reloaded.sourceSeen("s", `source-${MAX_CONTEXT_SOURCES_PER_SESSION}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("globally caps checkpoint provenance across sessions without affecting artifact status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-global-source-cap-"));
    try {
      const sources = Array.from({ length: MAX_CONTEXT_SOURCES_GLOBAL + 1 }, (_, index) => ({
        sessionId: `s-${index % 32}`,
        sourceId: `source-${index}`,
        handle: `ctx://source/${index}`,
      }));
      writeFileSync(join(dir, "checkpoint.json"), `${JSON.stringify({ version: 1, records: [], sources })}\n`);

      const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
      expect(broker.status().records).toBe(0);
      expect(broker.sourceSeen("s-0", "source-0")).toBe(false);
      expect(broker.sourceSeen(`s-${MAX_CONTEXT_SOURCES_GLOBAL % 32}`, `source-${MAX_CONTEXT_SOURCES_GLOBAL}`)).toBe(true);
      broker.prune();

      const checkpoint = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
      expect(checkpoint.records).toHaveLength(0);
      expect(checkpoint.sources).toHaveLength(MAX_CONTEXT_SOURCES_GLOBAL);
      expect(readFileSync(join(dir, "source-ledger.jsonl"), "utf8").trim().split("\n")).toHaveLength(MAX_CONTEXT_SOURCES_GLOBAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("persists an explicit sourceId independently from parentIds in checkpoint snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-explicit-source-"));
    try {
      const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 10 });
      broker.publish({ sessionId: "s", kind: "tool_output", payload: "producer payload", sourceId: "producer-a", parentIds: ["logical-parent"] });
      const checkpoint = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
      expect(checkpoint.records[0].input).toMatchObject({ sourceId: "producer-a", parentIds: ["logical-parent"] });

      const reloaded = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 10 });
      expect(reloaded.sourceSeen("s", "producer-a")).toBe(true);
      expect(reloaded.sourceSeen("s", "logical-parent")).toBe(false);
      expect(reloaded.publishBatch([{
        sessionId: "s", kind: "tool_output", payload: "logical parent payload", sourceId: "logical-parent", parentIds: ["logical-parent"],
      }])).toMatchObject({ published: 1, duplicateSources: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not republish a single source whose JSONL payload was pruned", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-single-source-tombstone-"));
    const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "old", sourceId: "old-source", createdAt: 1 });
    broker.publish({ sessionId: "s", kind: "tool_output", payload: "new", sourceId: "new-source", createdAt: 2 });

    const replay = broker.publish({ sessionId: "s", kind: "tool_output", payload: "must not persist", sourceId: "old-source", createdAt: 3 });

    expect(replay.handle).toBe(first.handle);
    expect(replay.payload).toBe("");
    expect(broker.status().records).toBe(1);
    expect(broker.lookup({ text: "must not persist" })).toEqual([]);
  });

  it("checkpoints source provenance through JSONL compaction after payload pruning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-ledger-"));
    const broker = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    broker.publishBatch([
      { sessionId: "s", kind: "tool_output", payload: "old", sourceId: "old-source", createdAt: 1 },
      { sessionId: "s", kind: "tool_output", payload: "new", sourceId: "new-source", createdAt: 2 },
    ]);
    broker.prune();
    // Records and provenance share the renamed authoritative checkpoint;
    // metadata.jsonl/source-ledger.jsonl remain compatibility projections.
    const checkpoint = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
    expect(checkpoint.records).toHaveLength(1);
    expect(checkpoint.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "s", sourceId: "old-source" }),
      expect.objectContaining({ sessionId: "s", sourceId: "new-source" }),
    ]));
    const reloaded = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    expect(reloaded.sourceSeen("s", "old-source")).toBe(true);
    expect(reloaded.publishBatch([{ sessionId: "s", kind: "tool_output", payload: "old-again", sourceId: "old-source" }])).toMatchObject({ published: 0, duplicateSources: 1 });
  });

  it("reloads provenance under one locked batch after another instance prunes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-multi-ledger-"));
    const first = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    first.publishBatch([
      { sessionId: "s", kind: "tool_output", payload: "old", sourceId: "old", createdAt: 1 },
      { sessionId: "s", kind: "tool_output", payload: "new", sourceId: "new", createdAt: 2 },
    ]);
    const staleSecondInstance = createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 });
    first.prune();
    expect(staleSecondInstance.publishBatch([{ sessionId: "s", kind: "tool_output", payload: "replay", sourceId: "old" }]))
      .toMatchObject({ scanned: 1, published: 0, duplicateSources: 1 });
    expect(createFileContextBroker({ dir, defaultTtlMs: 0, maxRecords: 1 }).sourceSeen("s", "old")).toBe(true);
  });

  it("rejects a malformed source batch before writing any JSONL records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-batch-rollback-"));
    const broker = createFileContextBroker({ dir, defaultTtlMs: 0 });
    expect(() => broker.publishBatch([
      { sessionId: "s", kind: "tool_output", payload: "valid", sourceId: "valid" },
      { sessionId: "s", kind: "tool_output", payload: "invalid", sourceId: "bad\0source" },
    ])).toThrow(/Invalid context broker sourceId/);
    expect(broker.status().records).toBe(0);
    expect(readdirSync(dir)).not.toContain("metadata.jsonl");
  });

  it("persists TTL pruning through a same-directory atomic snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-ttl-"));
    const now = Date.now();
    const broker = createFileContextBroker({ dir, defaultTtlMs: 10_000 });
    const expired = broker.publish(input("expired synthetic payload", now - 20_000));
    const retained = broker.publish(input("retained synthetic payload", now));

    broker.prune(now + 1);

    expect(readFileSync(join(dir, "metadata.jsonl"), "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    const restarted = createFileContextBroker({ dir, defaultTtlMs: 10_000 });
    expect(restarted.lookup({ handle: expired.handle })).toEqual([]);
    expect(restarted.lookup({ handle: retained.handle })).toHaveLength(1);
    expect(readdirSync(dir).some((name) => name.startsWith("metadata.jsonl.tmp-"))).toBe(false);
  });

  it("does not re-read retained JSONL payload blobs on each normal append publish", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-replay-cost-"));
    const broker = createFileContextBroker({
      dir,
      maxRecords: 2_048,
      maxBytes: 64_000_000,
      globalMaxRecords: 2_048,
      globalMaxBytes: 64_000_000,
    });
    for (let index = 0; index < 64; index += 1) {
      broker.publish(input(`${index}-${"x".repeat(16_384)}`));
    }

    const readFileSyncSpy = vi.spyOn(fsRequire, "readFileSync");
    try {
      readFileSyncSpy.mockClear();
      broker.publish(input("extra append record", Date.now()));
      const blobDir = join(dir, "blobs");
      const blobReadCount = readFileSyncSpy.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(blobDir) && path.endsWith(".txt")).length;
      expect(blobReadCount).toBe(0);
    } finally {
      readFileSyncSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-read retained JSONL payload blobs when append hits configured caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-replay-cost-cap-"));
    const broker = createFileContextBroker({
      dir,
      maxRecords: 2_048,
      maxBytes: 16_000_000,
      globalMaxRecords: 2_048,
      globalMaxBytes: 16_000_000,
    });
    const now = Date.now();
    for (let index = 0; index < 2_048; index += 1) {
      broker.publish(input(`pre-${index}`, now + index));
    }

    const readFileSyncSpy = vi.spyOn(fsRequire, "readFileSync");
    try {
      readFileSyncSpy.mockClear();
      broker.publish(input("cap overflow append", Date.now()));
      const blobDir = join(dir, "blobs");
      const blobReadCount = readFileSyncSpy.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(blobDir) && path.endsWith(".txt")).length;
      expect(blobReadCount).toBe(0);
      expect(broker.status().records).toBe(2_048);
    } finally {
      readFileSyncSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
