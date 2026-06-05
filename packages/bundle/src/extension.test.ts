import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInMemoryContextBroker } from "./context-broker.js";
import { describe, expect, it } from "vitest";

describe("bundle extension defaults", () => {
  it("does not register the beta context broker by default", () => {
    const source = readFileSync(resolve("packages/bundle/src/extension.ts"), "utf8");

    expect(source).not.toContain("pi-rogue-context-broker");
    expect(source).not.toContain("createInMemoryContextBroker");
  });
});

describe("bundle context-broker export", () => {
  it("exposes the beta context broker runtime for explicit opt-in", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 0 });
    const artifact = broker.publish({ sessionId: "bundle-test", kind: "memory_note", payload: "hello" });

    expect(artifact.handle).toContain("ctx://session/bundle-test/memory_note/");
    expect(broker.lookup({ handle: artifact.handle })).toEqual([artifact]);
  });
});
