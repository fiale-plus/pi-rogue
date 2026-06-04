import { describe, expect, it } from "vitest";
import { createInMemoryContextBroker } from "./context-broker.js";

describe("createInMemoryContextBroker", () => {
  it("publishes stable handles and looks up artifacts by handle", () => {
    const broker = createInMemoryContextBroker();
    const artifact = broker.publish({
      sessionId: "session-a",
      kind: "tool_output",
      payload: "npm test passed",
      summary: "tests passed",
      tags: ["test"],
      paths: ["packages/core"],
    });

    expect(artifact.handle).toMatch(/^ctx:\/\/session\/session-a\/tool_output\//);
    expect(broker.lookup({ handle: artifact.handle })).toEqual([artifact]);
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

  it("enforces byte caps by pruning oldest unpinned artifacts", () => {
    const broker = createInMemoryContextBroker({ maxBytes: 6, defaultTtlMs: 0 });
    const first = broker.publish({ sessionId: "s", kind: "tool_output", payload: "12345", createdAt: 1 });
    const second = broker.publish({ sessionId: "s", kind: "tool_output", payload: "abcde", createdAt: 2 });

    expect(broker.lookup({ id: first.id })).toEqual([]);
    expect(broker.lookup({ id: second.id })).toEqual([second]);
    expect(broker.status().bytes).toBe(5);
  });

  it("keeps pinned artifacts visible while pruning unpinned records", () => {
    const broker = createInMemoryContextBroker({ maxRecords: 1, defaultTtlMs: 0 });
    const pinned = broker.publish({ sessionId: "s", kind: "diff", payload: "important", pinned: true, createdAt: 1 });
    const newer = broker.publish({ sessionId: "s", kind: "diff", payload: "temporary", createdAt: 2 });

    expect(broker.lookup({ id: pinned.id })).toEqual([pinned]);
    expect(broker.lookup({ id: newer.id })).toEqual([]);
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

    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(182);
    expect(brief).toContain("Context Broker");
    expect(brief).toContain("ctx://session/s/tool_output/");
  });
});
