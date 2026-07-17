#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_VERSION = "0.80.6";
const INTERNAL_PACKAGES = [
  "pi-core",
  "pi-rogue-advisor",
  "pi-rogue-context-broker",
  "pi-rogue-orchestration",
  "pi-rogue-router",
];
const EXPECTED_EXPORTS = [".", "./context-broker", "./context-broker/file", "./context-broker/sqlite"];
const spec = process.argv[2];
if (!spec) throw new Error("usage: smoke-canonical-package.mjs <tarball-or-package-spec>");

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path, entry.name);
  }
}

const temp = mkdtempSync(join(tmpdir(), "pi-rogue-canonical-smoke-"));
const consumer = join(temp, "consumer");
const home = join(temp, "home");
const cache = join(temp, "npm-cache");
mkdirSync(consumer, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(cache, { recursive: true });
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "pi-rogue-canonical-smoke", private: true, type: "module" }));
const installEnv = { ...process.env, npm_config_cache: cache };
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", `@earendil-works/pi-coding-agent@${PI_VERSION}`, spec], {
  cwd: consumer,
  env: installEnv,
  stdio: "inherit",
});

const packageDir = join(consumer, "node_modules", "@fiale-plus", "pi-rogue");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
if (pkg.name !== "@fiale-plus/pi-rogue") throw new Error(`installed unexpected package ${pkg.name}`);
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const name of INTERNAL_PACKAGES.map((item) => `@fiale-plus/${item}`)) {
    if (pkg[field]?.[name]) throw new Error(`canonical package still declares internal dependency ${name} in ${field}`);
  }
}
if (JSON.stringify(Object.keys(pkg.exports || {}).sort()) !== JSON.stringify(EXPECTED_EXPORTS.sort())) {
  throw new Error(`canonical exports changed: ${JSON.stringify(Object.keys(pkg.exports || {}))}`);
}
for (const target of Object.values(pkg.exports || {})) {
  if (typeof target !== "string" || !existsSync(join(packageDir, target))) throw new Error(`missing export target ${String(target)}`);
}
if (!existsSync(join(packageDir, "LICENSE"))) throw new Error("canonical tarball omitted LICENSE");
for (const name of INTERNAL_PACKAGES) {
  const leaf = join(packageDir, "node_modules", "@fiale-plus", name, "package.json");
  if (!existsSync(leaf)) throw new Error(`canonical tarball omitted bundled dependency @fiale-plus/${name}`);
}
if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length !== 1) throw new Error("canonical package must expose exactly one Pi extension entrypoint");
if (!Array.isArray(pkg.pi?.skills) || pkg.pi.skills.length !== 2) throw new Error("canonical package must expose advisor and orchestration skills");
for (const skillPath of pkg.pi.skills) {
  if (!existsSync(join(packageDir, skillPath))) throw new Error(`canonical tarball omitted skill path ${skillPath}`);
}
let testSource;
walk(packageDir, (path, name) => {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) testSource ||= path;
});
if (testSource) throw new Error(`canonical tarball included test source ${testSource}`);

const extensionPath = join(packageDir, pkg.pi.extensions[0]);
const piBin = join(consumer, "node_modules", ".bin", "pi");
execFileSync(piBin, ["--offline", "--no-extensions", "-e", extensionPath, "--list-models"], {
  cwd: consumer,
  env: { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1" },
  encoding: "utf8",
});
console.log(`canonical package smoke passed: ${pkg.name}@${pkg.version}; Pi ${PI_VERSION}; bundled leaves; skills and exports present`);
