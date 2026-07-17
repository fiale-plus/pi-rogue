#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE = "v22.19.0";
const EXPECTED_PI = "0.80.6";
if (process.version !== EXPECTED_NODE) throw new Error(`minimum-node smoke requires ${EXPECTED_NODE}; got ${process.version}`);
if (process.platform !== "linux") throw new Error(`minimum-node smoke is the required Linux CI gate; got ${process.platform}`);

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
  ["context-broker", "pi-rogue-context-broker"],
  ["orchestration", "pi-rogue-orchestration"],
  ["router", "pi-rogue-router"],
]) cpSync(join(root, "packages", source), join(stage, "node_modules", "@fiale-plus", target), { recursive: true });

execFileSync(process.execPath, [join(root, "scripts", "prepare-bundle-publish.mjs"), stage], { stdio: "inherit" });
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: stage, encoding: "utf8" }));
const tarball = join(packDir, packed[0].filename);
if (!existsSync(tarball)) throw new Error("npm pack did not create the canonical tarball");
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "pi-rogue-packed-consumer", private: true, type: "module" }));
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${EXPECTED_PI}`, tarball], { cwd: consumer, stdio: "inherit" });

const installedPi = JSON.parse(readFileSync(join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
if (installedPi.version !== EXPECTED_PI) throw new Error(`expected Pi ${EXPECTED_PI}; got ${installedPi.version}`);
const extensionPath = join(consumer, "node_modules", "@fiale-plus", "pi-rogue", "src", "extension.ts");
const brokerExtensionPath = join(consumer, "node_modules", "@fiale-plus", "pi-rogue", "src", "context-broker-default.ts");
const piBin = join(consumer, "node_modules", ".bin", "pi");
const isolatedEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1", PI_CONTEXT_BROKER_ENABLED: "true" };
for (const name of ["PI_CONTEXT_BROKER_BACKEND", "PI_CONTEXT_BROKER_DURABLE", "PI_CONTEXT_BROKER_STORE_DIR"]) delete isolatedEnv[name];
execFileSync(piBin, ["--offline", "--no-extensions", "-e", extensionPath, "--list-models"], { cwd: consumer, env: isolatedEnv, encoding: "utf8" });

const sentinel = `packed-min-node-${Date.now()}`;
const smokePath = join(consumer, "durability-smoke.mjs");
const jitiPath = join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.mjs");
writeFileSync(smokePath, `
import { pathToFileURL } from "node:url";
const mode = process.argv[2];
const extensionPath = process.argv[3];
const sentinel = process.argv[4];
const { createJiti } = await import(pathToFileURL(process.argv[5]).href);
const handle = process.argv[6];
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const pi = new Proxy({
  on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  getFlag() { return undefined; },
}, { get(target, key) { if (key in target) return target[key]; if (typeof key === "string" && key.startsWith("__")) return undefined; return () => undefined; } });
const jiti = createJiti(import.meta.url, { interopDefault: true });
const loaded = await jiti.import(extensionPath);
await loaded.registerDefaultContextBroker(pi);
const ctx = {
  cwd: process.cwd(),
  ui: { notify() {}, setStatus() {} },
  sessionManager: { getSessionFile() { return process.env.PI_ROGUE_SMOKE_SESSION; }, getBranch() { return []; } },
};
if (mode === "write") {
  const event = { type: "tool_result", toolCallId: "packed-call", toolName: "bash", input: { command: "packed durability smoke" }, content: [{ type: "text", text: sentinel.repeat(700) }], isError: false };
  for (const handler of handlers.get("tool_result") || []) await handler(event, ctx);
} else {
  const result = await tools.get("context_lookup").execute("packed-lookup", { handle }, undefined, undefined, ctx);
  const serialized = JSON.stringify(result);
  if (!serialized.includes(handle) || !serialized.includes("packed durability smoke")) throw new Error("fresh process could not reload the durable artifact");
}
`);
const sessionFile = join(temp, "session.jsonl");
writeFileSync(sessionFile, "");
const storeDir = join(home, ".pi", "agent", "pi-rogue", "context-broker");
const smokeEnv = {
  ...isolatedEnv,
  PI_ROGUE_SMOKE_SESSION: sessionFile,
  NODE_PATH: join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules"),
};
execFileSync(process.execPath, [smokePath, "write", brokerExtensionPath, sentinel, jitiPath, ""], { cwd: consumer, env: smokeEnv, stdio: "inherit" });

const dbPath = join(storeDir, "artifacts.sqlite");
if (!existsSync(dbPath)) throw new Error("canonical bundle did not select the SQLite durable backend");
const db = new DatabaseSync(dbPath, { readOnly: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => String(row.name)));
if (!tables.has("artifacts") || !tables.has("artifact_fts") || !tables.has("meta")) throw new Error("durable SQLite schema is incomplete");
const stored = db.prepare("SELECT handle FROM artifacts WHERE payload LIKE ? LIMIT 1").get(`%${sentinel}%`);
db.close();
if (!stored?.handle) throw new Error("known smoke artifact was not persisted in SQLite");
execFileSync(process.execPath, [smokePath, "read", brokerExtensionPath, sentinel, jitiPath, String(stored.handle)], { cwd: consumer, env: smokeEnv, stdio: "inherit" });
console.log(`packed minimum-runtime durability: Node ${process.version}, Pi ${installedPi.version}, sqlite artifact reloaded across processes`);
