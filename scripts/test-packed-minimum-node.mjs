#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM_NODE = [22, 19, 0];
const EXPECTED_PI = "0.80.6";
const nodeVersion = process.versions.node.split(".").map(Number);
for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
  if (nodeVersion[index] !== MINIMUM_NODE[index]) {
    if (nodeVersion[index] > MINIMUM_NODE[index]) break;
    throw new Error(`minimum-node smoke requires Node >=22.19.0; got ${process.version}`);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "pi-rogue-packed-min-node-"));
const stage = join(temp, "stage");
const packDir = join(temp, "pack");
const consumer = join(temp, "consumer");
const home = join(temp, "home");
mkdirSync(join(stage, "node_modules", "@fiale-plus"), { recursive: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(consumer, { recursive: true });
mkdirSync(home, { recursive: true });
cpSync(join(root, "packages", "bundle"), stage, { recursive: true });
for (const [source, target] of [
  ["core", "pi-core"],
  ["advisor", "pi-rogue-advisor"],
]) cpSync(join(root, "packages", source), join(stage, "node_modules", "@fiale-plus", target), { recursive: true });

execFileSync(process.execPath, [join(root, "scripts", "prepare-bundle-publish.mjs"), stage], { stdio: "inherit" });
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: stage, encoding: "utf8" }));
const tarball = join(packDir, packed[0].filename);
if (!existsSync(tarball)) throw new Error("npm pack did not create the canonical tarball");
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "pi-rogue-packed-consumer", private: true, type: "module" }));
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${EXPECTED_PI}`, tarball], { cwd: consumer, stdio: "inherit" });

const packageDir = join(consumer, "node_modules", "@fiale-plus", "pi-rogue");
const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
if (installed.name !== "@fiale-plus/pi-rogue") throw new Error(`installed unexpected package ${installed.name}`);
if (installed.engines?.node !== ">=22.19.0") throw new Error(`canonical package has unexpected Node engine ${installed.engines?.node}`);
const installedPi = JSON.parse(readFileSync(join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
if (installedPi.version !== EXPECTED_PI) throw new Error(`expected Pi ${EXPECTED_PI}; got ${installedPi.version}`);
const bundled = ["pi-core", "pi-rogue-advisor"];
for (const name of bundled) {
  if (!existsSync(join(packageDir, "node_modules", "@fiale-plus", name, "package.json"))) {
    throw new Error(`canonical tarball omitted bundled dependency @fiale-plus/${name}`);
  }
}
const extensionPath = join(packageDir, installed.pi.extensions[0]);
const piBin = join(consumer, "node_modules", ".bin", "pi");
execFileSync(piBin, ["--offline", "--no-extensions", "-e", extensionPath, "--list-models"], {
  cwd: consumer,
  env: { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1" },
  stdio: "ignore",
});

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path, entry.name);
  }
}
let testSource;
walk(packageDir, (path, name) => {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) testSource ||= path;
});
if (testSource) throw new Error(`canonical tarball included test source ${testSource}`);
console.log(`packed minimum-node smoke passed: Node ${process.version}, Pi ${installedPi.version}; Advisor and core bundled and loaded through Pi`);
