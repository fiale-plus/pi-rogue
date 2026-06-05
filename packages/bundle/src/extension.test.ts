import { createInMemoryContextBroker } from "./context-broker.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerBundle } from "./extension.js";

function createPiMock() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const pi: any = new Proxy({
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    getFlag() {
      return undefined;
    },
  }, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      if (typeof prop === "string" && prop.startsWith("__")) return undefined;
      return () => undefined;
    },
  });
  return { pi, handlers, commands };
}

describe("bundle extension defaults", () => {
  const oldEnv = process.env.PI_CONTEXT_BROKER_ENABLED;

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.PI_CONTEXT_BROKER_ENABLED;
    else process.env.PI_CONTEXT_BROKER_ENABLED = oldEnv;
  });

  it("does not register the beta context broker by default", async () => {
    delete process.env.PI_CONTEXT_BROKER_ENABLED;
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect(commands.has("context")).toBe(false);
  });

  it("registers the beta context broker only when explicitly enabled", async () => {
    process.env.PI_CONTEXT_BROKER_ENABLED = "true";
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect(commands.has("context")).toBe(true);
  });
});

describe("bundle context-broker export", () => {
  it("exposes the beta context broker runtime for explicit opt-in", () => {
    const broker = createInMemoryContextBroker({ defaultTtlMs: 0 });
    const artifact = broker.publish({ sessionId: "bundle-test", kind: "memory_note", payload: "hello" });

    expect(artifact.handle).toContain("ctx://session/bundle-test/memory_note/");
    expect(broker.lookup({ handle: artifact.handle })).toEqual([artifact]);
  });

  it("exposes the durable sqlite backend through a bundle subpath", async () => {
    const sqlite = await import("./context-broker-sqlite.js");
    expect(sqlite.createSqliteContextBroker).toBeTypeOf("function");
  });
});
