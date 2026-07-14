import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("registers the context broker by default", async () => {
    delete process.env.PI_CONTEXT_BROKER_ENABLED;
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect(commands.has("pi-rogue-context")).toBe(true);
    expect(commands.has("pi-rogue")).toBe(true);
    expect(commands.has("pi-rogue-advisor")).toBe(true);
    expect(commands.has("pi-rogue-router")).toBe(true);
    expect(commands.has("pi-rogue-fusion")).toBe(true);
    expect(commands.has("pi-rogue-orchestration")).toBe(true);
    expect(commands.has("goal")).toBe(true);
    expect(commands.has("loop")).toBe(true);
    expect(commands.has("autoresearch")).toBe(true);
    expect(commands.has("autoresearch-lab")).toBe(false);
    expect([...commands.keys()]).toEqual([
      "pi-rogue",
      "cfg",
      "pi-rogue-advisor",
      "pi-rogue-router",
      "pi-rogue-fusion",
      "goal",
      "loop",
      "autoresearch",
      "pi-rogue-orchestration",
      "pi-rogue-context",
    ]);
    expect(["advisor", "router", "fusion"].some((name) => commands.has(name))).toBe(false);
  });

  it("keeps an explicit env kill switch for context broker rollout", async () => {
    process.env.PI_CONTEXT_BROKER_ENABLED = "false";
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect(commands.has("pi-rogue-context")).toBe(false);
  });
});

describe("bundle publish metadata", () => {
  it("rewrites bundled internal leaves to local file specs for clean npm installs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-bundle-prep-"));
    const bundle = join(dir, "bundle");
    mkdirSync(join(bundle, "src"), { recursive: true });
    mkdirSync(join(bundle, "node_modules", "@fiale-plus", "pi-core", "src"), { recursive: true });
    writeFileSync(join(bundle, "package.json"), JSON.stringify({
      name: "@fiale-plus/pi-rogue",
      version: "9.9.9",
      dependencies: { "@fiale-plus/pi-core": "^0.1.0", typebox: "^1.0.0" },
      bundledDependencies: ["@fiale-plus/pi-core"],
    }, null, 2));
    writeFileSync(join(bundle, "src", "extension.test.ts"), "throw new Error('must not publish');\n");
    writeFileSync(join(bundle, "node_modules", "@fiale-plus", "pi-core", "src", "index.spec.ts"), "throw new Error('must not publish');\n");
    writeFileSync(join(bundle, "node_modules", "@fiale-plus", "pi-core", "package.json"), JSON.stringify({
      name: "@fiale-plus/pi-core",
      version: "0.1.0",
      private: true,
      exports: { ".": "./src/index.ts" },
      dependencies: { "@fiale-plus/pi-core": "^0.1.0", typebox: "^1.0.0" },
    }, null, 2));

    execFileSync(process.execPath, [join(process.cwd(), "scripts", "prepare-bundle-publish.mjs"), bundle]);

    const prepared = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
    const leaf = JSON.parse(readFileSync(join(bundle, "node_modules", "@fiale-plus", "pi-core", "package.json"), "utf8"));
    expect(prepared.dependencies).toEqual({ "@fiale-plus/pi-core": "npm:@fiale-plus/pi-rogue@9.9.9", typebox: "^1.0.0" });
    expect(leaf.name).toBe("@fiale-plus/pi-rogue");
    expect(leaf.version).toBe("9.9.9");
    expect(leaf["x-pi-rogue-internal-name"]).toBe("@fiale-plus/pi-core");
    expect(leaf.dependencies).toEqual({ "@fiale-plus/pi-core": "npm:@fiale-plus/pi-rogue@9.9.9", typebox: "^1.0.0" });
    expect(leaf.private).toBeUndefined();
    expect(existsSync(join(bundle, "src", "extension.test.ts"))).toBe(false);
    expect(existsSync(join(bundle, "node_modules", "@fiale-plus", "pi-core", "src", "index.spec.ts"))).toBe(false);
  });
});

describe("bundle context-broker export", () => {
  it("exposes the context broker runtime through a bundle subpath", () => {
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
