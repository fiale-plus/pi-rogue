import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryContextBroker } from "./context-broker.js";

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

  it("renders a bounded prompt brief with lookup instructions", () => {
    const broker = createInMemoryContextBroker({ briefBytes: 180 });
    broker.publish({
      sessionId: "s",
      kind: "tool_output",
      payload: "x".repeat(500),
      summary: "large command output passed with no failures",
      tags: ["test"],
      paths: ["packages/core"],
    });

    const brief = broker.renderBrief();

    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(180);
    expect(brief).toContain("Context Broker");
    expect(brief).toContain("ctx://session/s/tool_output/");
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
});
