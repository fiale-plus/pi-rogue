import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerBundle } from "./extension.js";

function createPiMock() {
  const commands = new Map<string, any>();
  const pi: any = new Proxy({
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  }, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      if (typeof prop === "string" && prop.startsWith("__")) return undefined;
      return () => undefined;
    },
  });
  return { pi, commands };
}

describe("bundle extension", () => {
  it("registers only the retained Advisor command roots", async () => {
    const { pi, commands } = createPiMock();

    await registerBundle(pi);

    expect([...commands.keys()]).toEqual(["pi-rogue", "pi-rogue-advisor"]);
    expect(commands.has("pi-rogue-router")).toBe(false);
    expect(commands.has("pi-rogue-fusion")).toBe(false);
    expect(commands.has("pi-rogue-orchestration")).toBe(false);
    expect(commands.has("pi-rogue-context")).toBe(false);
  });

  it("keeps the root and bundle docs aligned with the registered surface", () => {
    const rootReadme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const bundleReadme = readFileSync(join(process.cwd(), "packages", "bundle", "README.md"), "utf8");
    expect(rootReadme).toContain("/pi-rogue status");
    expect(rootReadme).toContain("/pi-rogue-advisor <question>");
    expect(rootReadme).not.toContain("/pi-rogue-router");
    expect(rootReadme).not.toContain("/pi-rogue-fusion");
    expect(rootReadme).not.toContain("/pi-rogue-orchestration");
    expect(rootReadme).not.toContain("/pi-rogue-context");
    expect(bundleReadme).toContain("## Supported surface");
    expect(bundleReadme).toContain("/pi-rogue-advisor model list");
    expect(bundleReadme).toContain("board watch status|off|shadow|intervene");
    expect(rootReadme).toContain("openrouter/deepseek/deepseek-v4-flash");
    expect(rootReadme).toContain("main Pi model");
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

