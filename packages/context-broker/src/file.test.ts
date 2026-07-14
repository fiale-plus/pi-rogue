import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileContextBroker } from "./file.js";

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

  it("persists TTL pruning through a same-directory atomic snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-file-prune-ttl-"));
    const now = Date.now();
    const broker = createFileContextBroker({ dir, defaultTtlMs: 10 });
    const expired = broker.publish(input("expired synthetic payload", now - 100));
    const retained = broker.publish(input("retained synthetic payload", now));

    broker.prune(now + 1);

    expect(readFileSync(join(dir, "metadata.jsonl"), "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    const restarted = createFileContextBroker({ dir, defaultTtlMs: 10 });
    expect(restarted.lookup({ handle: expired.handle })).toEqual([]);
    expect(restarted.lookup({ handle: retained.handle })).toHaveLength(1);
    expect(readdirSync(dir).some((name) => name.startsWith("metadata.jsonl.tmp-"))).toBe(false);
  });
});
