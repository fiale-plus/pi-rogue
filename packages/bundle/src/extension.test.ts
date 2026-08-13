import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      "goal",
      "loop",
      "autoresearch",
      "pi-rogue-orchestration",
      "pi-rogue-context",
    ]);
    expect(["advisor", "router"].some((name) => commands.has(name))).toBe(false);
    expect(typeof (pi as any).__piRogueFeatureStatusCatalog).toBe("function");
    expect((pi as any).__piRogueFeatureStatusCatalog({}).features.map((status: any) => status.feature)).toEqual([
      "advisor", "router", "orchestration", "context-broker",
    ]);
  });

  it("honors canonical durability, store, and backend environment precedence", async () => {
    const envNames = ["HOME", "PI_CONTEXT_BROKER_DURABLE", "PI_CONTEXT_BROKER_STORE_DIR", "PI_CONTEXT_BROKER_BACKEND"] as const;
    const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    const root = mkdtempSync(join(tmpdir(), "pi-rogue-bundle-context-env-"));
    const statusFor = async () => {
      const { pi, commands } = createPiMock();
      await registerBundle(pi);
      const notices: string[] = [];
      await commands.get("pi-rogue-context").handler("status", {
        cwd: root,
        sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getBranch: () => [] },
        ui: { notify(message: string) { notices.push(message); } },
      });
      return notices[0] ?? "";
    };
    try {
      process.env.HOME = join(root, "home-default");
      delete process.env.PI_CONTEXT_BROKER_DURABLE;
      delete process.env.PI_CONTEXT_BROKER_STORE_DIR;
      delete process.env.PI_CONTEXT_BROKER_BACKEND;
      expect(await statusFor()).toContain("backend=sqlite");
      expect(existsSync(join(process.env.HOME, ".pi", "agent", "pi-rogue", "context-broker", "artifacts.sqlite"))).toBe(true);

      const memoryDir = join(root, "memory-must-not-write");
      process.env.PI_CONTEXT_BROKER_DURABLE = "false";
      process.env.PI_CONTEXT_BROKER_STORE_DIR = memoryDir;
      expect(await statusFor()).toContain("backend=memory, path=none");
      expect(existsSync(memoryDir)).toBe(false);

      const sqliteDir = join(root, "custom-sqlite");
      process.env.PI_CONTEXT_BROKER_DURABLE = "true";
      process.env.PI_CONTEXT_BROKER_STORE_DIR = sqliteDir;
      delete process.env.PI_CONTEXT_BROKER_BACKEND;
      expect(await statusFor()).toContain(`backend=sqlite, path=${join(sqliteDir, "artifacts.sqlite")}`);
      expect(existsSync(join(sqliteDir, "artifacts.sqlite"))).toBe(true);

      const jsonlDir = join(root, "custom-jsonl");
      process.env.PI_CONTEXT_BROKER_STORE_DIR = jsonlDir;
      process.env.PI_CONTEXT_BROKER_BACKEND = "jsonl";
      expect(await statusFor()).toContain(`backend=jsonl, path=${jsonlDir}`);
      expect(existsSync(join(jsonlDir, "blobs"))).toBe(true);
    } finally {
      for (const name of envNames) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("keeps an explicit env kill switch for context broker rollout", async () => {
    process.env.PI_CONTEXT_BROKER_ENABLED = "false";
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect(commands.has("pi-rogue-context")).toBe(false);
  });
});

describe("bundle publish metadata", () => {
  it("enforces the committed canonical version and release-note policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-release-policy-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ release: { body: "## Summary\nReady.\n\n## Changes\nCanonical.\n\n## Validation\nGreen." } }));
    const version = JSON.parse(readFileSync(join(process.cwd(), "packages", "bundle", "package.json"), "utf8")).version;
    const script = join(process.cwd(), "scripts", "validate-release-policy.mjs");
    execFileSync(process.execPath, [script], { env: { ...process.env, GITHUB_REF_NAME: `pi-rogue-${version}`, GITHUB_EVENT_PATH: eventPath } });
    const rejected = spawnSync(process.execPath, [script], { env: { ...process.env, GITHUB_REF_NAME: "pi-rogue-9.9.9", GITHUB_EVENT_PATH: eventPath }, encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("must exactly match committed canonical version");
  });

  it("treats already-correct exact legacy deprecations as success", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-deprecation-policy-"));
    const fakeNpm = join(dir, "npm");
    writeFileSync(fakeNpm, `#!/usr/bin/env node
const args = process.argv.slice(2);
const messages = {
  "@fiale-plus/pi-rogue-bundle": "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-rogue-advisor": "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-rogue-orchestration": "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-orchestration": "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\"."
};
const spec = args[1] || "";
const name = Object.keys(messages).find((candidate) => spec.startsWith(candidate));
if (args[0] !== "view" || !name) process.exit(2);
if (args[2] === "versions") console.log(JSON.stringify(["1.0.0"]));
else if (args[2] === "deprecated") console.log(JSON.stringify(messages[name]));
else process.exit(2);
`);
    chmodSync(fakeNpm, 0o755);
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "deprecate-legacy-packages.mjs"), "--verify-only"], {
      env: { ...process.env, NPM_CLI: fakeNpm },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already have the exact deprecation message");
  });

  it("uses fresh verification after a successful write followed by stale reads and E422", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-deprecation-retry-"));
    const fakeNpm = join(dir, "npm");
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ versionReads: 0, deprecatedReads: 0, writes: 0 }));
    writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, "utf8"));
const messages = {
  "@fiale-plus/pi-rogue-bundle": "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-rogue-advisor": "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-rogue-orchestration": "Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\".",
  "@fiale-plus/pi-orchestration": "Deprecated: replaced by @fiale-plus/pi-rogue. Install via \\"pi install npm:@fiale-plus/pi-rogue\\"."
};
const spec = args[1] || "";
const name = Object.keys(messages).find((candidate) => spec.startsWith(candidate));
if (!name) process.exit(2);
if (args[0] === "view" && args[2] === "versions") {
  state.versionReads += 1; fs.writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
  if (state.versionReads === 1) { console.error("transient read"); process.exit(1); }
  console.log(JSON.stringify(["1.0.0"]));
} else if (args[0] === "view" && args[2] === "deprecated") {
  state.deprecatedReads += 1; fs.writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
  console.log(JSON.stringify(state.writes >= 2 ? messages[name] : "stale"));
} else if (args[0] === "deprecate") {
  state.writes += 1; fs.writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
  if (state.writes === 2) { console.error("E422 after prior successful write"); process.exit(1); }
} else process.exit(2);
`);
    chmodSync(fakeNpm, 0o755);
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "deprecate-legacy-packages.mjs")], {
      env: { ...process.env, NPM_CLI: fakeNpm, FAKE_NPM_STATE: statePath, DEPRECATION_RETRY_DELAY_MS: "0" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ versionReads: 5, deprecatedReads: 6, writes: 2 });
    expect(result.stdout).toContain("exact deprecation verified for 1 version(s) after a non-fatal write response");
  });

  it("fails after exhausted registry retries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rogue-deprecation-exhausted-"));
    const fakeNpm = join(dir, "npm");
    writeFileSync(fakeNpm, "#!/usr/bin/env node\nconsole.error('registry unavailable'); process.exit(1);\n");
    chmodSync(fakeNpm, 0o755);
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "deprecate-legacy-packages.mjs")], {
      env: { ...process.env, NPM_CLI: fakeNpm, DEPRECATION_RETRY_DELAY_MS: "0" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version discovery failed after 3 attempts");
  });

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
