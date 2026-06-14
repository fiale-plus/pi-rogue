#!/usr/bin/env node
/**
 * Persist router sharpening learnings in a stable, upgrade-safe location.
 *
 * Usage:
 *   npm run router:sharpen:auto -- [--workspace <path>] [--events <path>] [--outcomes <path>] [--cards <path>] [--force]
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeSharpeningHints, type RouterSharpeningArtifact } from "../packages/router/src/sharpening.js";

interface Args {
  workspace: string;
  events: string;
  outcomes?: string;
  cards?: string;
  output?: string;
  force: boolean;
  maxHistory: number;
  disableHistory: boolean;
  scope: "repo" | "shared";
  sharedCorpus?: string;
}

interface InputFingerprint {
  path: string;
  hash: string;
  size: number;
  modifiedAt: string;
}

interface InputManifest {
  events: InputFingerprint;
  outcomes?: InputFingerprint;
  cards?: InputFingerprint;
}

interface LearnedManifest {
  schema: "pi-router.sharpening-shim-manifest.v1";
  generatedAt: string;
  workspace: string;
  workspaceName: string;
  scope: "repo" | "shared";
  repoKey: string;
  sharedCorpus?: string;
  latest: {
    path: string;
    hash: string;
  };
  policy: RouterSharpeningArtifact["learningPolicy"];
  inputs: InputManifest;
  totals: RouterSharpeningArtifact["totals"];
  summary: {
    hints: number;
    autoEligible: number;
  };
  history: {
    enabled: boolean;
    path: string;
    maxEntries: number;
    kept: number;
  };
  migratedFromLegacy: boolean;
}

function expandHome(raw: string): string {
  return raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

function usage(): never {
  console.error(`Usage: npx tsx scripts/router-auto-sharpen.ts`);
  console.error(`       [--workspace <repo-root>]`);
  console.error(`       [--events <events.jsonl>] [--outcomes <outcomes.jsonl>] [--cards <model-cards.jsonl>]`);
  console.error(`       [--scope repo|shared] [--corpus <name>] [--output <latest.json>]`);
  console.error(`       [--force] [--max-history <n>] [--disable-history]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workspace: expandHome(process.cwd()),
    events: "",
    force: false,
    maxHistory: 24,
    disableHistory: false,
    scope: "repo",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage();

    if (arg === "--workspace" && next) {
      args.workspace = resolve(expandHome(next));
      index++;
      continue;
    }

    if (arg === "--events" && next) {
      args.events = resolve(expandHome(next));
      index++;
      continue;
    }

    if (arg === "--outcomes" && next) {
      args.outcomes = resolve(expandHome(next));
      index++;
      continue;
    }

    if (arg === "--cards" && next) {
      args.cards = resolve(expandHome(next));
      index++;
      continue;
    }

    if (arg === "--output" && next) {
      args.output = resolve(expandHome(next));
      index++;
      continue;
    }

    if (arg === "--force") {
      args.force = true;
      continue;
    }

    if (arg === "--max-history" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 1) usage();
      args.maxHistory = parsed;
      index++;
      continue;
    }

    if (arg === "--disable-history") {
      args.disableHistory = true;
      continue;
    }

    if (arg === "--scope" && next) {
      if (next !== "repo" && next !== "shared") usage();
      args.scope = next;
      index++;
      continue;
    }

    if (arg === "--corpus" && next) {
      args.sharedCorpus = next;
      index++;
      continue;
    }

    usage();
  }

  args.workspace = resolve(expandHome(args.workspace));
  args.events ||= resolve(join(args.workspace, ".pi", "router", "events.jsonl"));
  if (args.output) args.output = resolve(args.output);
  if (args.events) args.events = resolve(args.events);
  if (args.outcomes) args.outcomes = resolve(args.outcomes);
  if (args.cards) args.cards = resolve(args.cards);
  if (args.scope === "shared" && !args.sharedCorpus && args.workspace) {
    args.sharedCorpus = basename(args.workspace);
  }
  return args;
}

function safeCorpusId(raw: string): string {
  return String(raw).trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fileFingerprint(path: string): InputFingerprint {
  const stat = statSync(path);
  return {
    path,
    hash: sha256(path),
    size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

function fileExists(path: string | undefined): path is string {
  return typeof path === "string" && path.length > 0 && existsSync(path);
}

function stableRepoKey(workspace: string): string {
  const pkgName = readPackageName(workspace);
  const digest = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
  return `${pkgName}-${digest}`;
}

function readPackageName(workspace: string): string {
  try {
    const raw = readFileSync(join(workspace, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg?.name) return String(pkg.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    // ignore and fallback
  }
  return basename(workspace) || "pi-rogue-router";
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "pi-rogue-router");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "pi-rogue-router");
  return join(homedir(), ".local", "share", "pi-rogue-router");
}

function legacyShaken(space: string): { path: string; exists: boolean } {
  const legacy = join(space, ".pi", "router", "sharpening-hints.json");
  return { path: legacy, exists: existsSync(legacy) };
}

function sameFingerprint(a?: InputFingerprint, b?: InputFingerprint): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size;
}

function pruneHistory(historyDir: string, maxEntries: number): number {
  const existing = readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();

  if (existing.length <= maxEntries) return existing.length;
  const toDelete = existing.slice(maxEntries);
  for (const file of toDelete) {
    unlinkSync(join(historyDir, file));
  }
  return maxEntries;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.events)) {
    console.error(`events file not found: ${args.events}`);
    process.exit(1);
  }

  const key = stableRepoKey(args.workspace);
  const baseDir = args.scope === "shared"
    ? join(dataRoot(), "learning", "shared", safeCorpusId(args.sharedCorpus ?? "global"))
    : join(dataRoot(), "learning", key);
  const latestPath = args.output ?? resolve(baseDir, "latest.json");
  const historyDir = join(baseDir, "history");
  const manifestPath = join(baseDir, "manifest.json");

  const outcomes = fileExists(args.outcomes) ? args.outcomes : undefined;
  const cards = fileExists(args.cards) ? args.cards : undefined;

  const currentInputs: InputManifest = {
    events: fileFingerprint(args.events),
    ...(outcomes ? { outcomes: fileFingerprint(outcomes) } : {}),
    ...(cards ? { cards: fileFingerprint(cards) } : {}),
  };

  const previous = readJson<LearnedManifest>(manifestPath);
  const unchanged = Boolean(previous) &&
    sameFingerprint(previous!.inputs.events, currentInputs.events) &&
    sameFingerprint(previous!.inputs.outcomes, currentInputs.outcomes) &&
    sameFingerprint(previous!.inputs.cards, currentInputs.cards);

  const legacy = args.scope === "repo" ? legacyShaken(args.workspace) : { path: "", exists: false };
  const migratedFromLegacy = !existsSync(latestPath) && legacy.exists;
  if (migratedFromLegacy) {
    mkdirSync(dirname(latestPath), { recursive: true });
    copyFileSync(legacy.path, latestPath);
  }

  if (unchanged && !args.force && !migratedFromLegacy) {
    const status = previous ? `unchanged; last generated ${previous.generatedAt}` : "no previous manifest";
    console.log(`[router:auto-sharpen] ${status}. Use --force to re-run.`);
    return;
  }

  const artifact = writeSharpeningHints({
    eventsPath: args.events,
    outputPath: latestPath,
    outcomesPath: outcomes,
    cardsPath: cards,
  });

  const latestText = JSON.stringify(artifact, null, 2) + "\n";
  const latestHash = createHash("sha256").update(latestText).digest("hex");

  if (!args.disableHistory) {
    mkdirSync(historyDir, { recursive: true });
    const ts = artifact.generatedAt.replace(/[:.]/g, "-");
    writeJson(join(historyDir, `${ts}.json`), artifact);
    const kept = pruneHistory(historyDir, args.maxHistory);
    const manifest: LearnedManifest = {
      schema: "pi-router.sharpening-shim-manifest.v1",
      generatedAt: new Date().toISOString(),
      workspace: args.workspace,
      workspaceName: readPackageName(args.workspace),
      scope: args.scope,
      repoKey: key,
      sharedCorpus: args.scope === "shared" ? safeCorpusId(args.sharedCorpus ?? "global") : undefined,
      latest: { path: latestPath, hash: latestHash },
      policy: artifact.learningPolicy,
      inputs: currentInputs,
      totals: artifact.totals,
      summary: {
        hints: artifact.hints.length,
        autoEligible: artifact.hints.filter((hint) => hint.guardrails.autoUse.eligible).length,
      },
      history: {
        enabled: true,
        path: historyDir,
        maxEntries: args.maxHistory,
        kept,
      },
      migratedFromLegacy,
    };
    writeJson(manifestPath, manifest);
    console.log(`[router:auto-sharpen] wrote ${artifact.hints.length} hints to ${latestPath} (${kept}/${args.maxHistory} history entries, latest hash ${latestHash.slice(0, 10)})`);
    return;
  }

  const manifest: LearnedManifest = {
    schema: "pi-router.sharpening-shim-manifest.v1",
    generatedAt: new Date().toISOString(),
    workspace: args.workspace,
    workspaceName: readPackageName(args.workspace),
    scope: args.scope,
    repoKey: key,
    sharedCorpus: args.scope === "shared" ? safeCorpusId(args.sharedCorpus ?? "global") : undefined,
    latest: { path: latestPath, hash: latestHash },
    policy: artifact.learningPolicy,
    inputs: currentInputs,
    totals: artifact.totals,
    summary: {
      hints: artifact.hints.length,
      autoEligible: artifact.hints.filter((hint) => hint.guardrails.autoUse.eligible).length,
    },
    history: {
      enabled: false,
      path: historyDir,
      maxEntries: 0,
      kept: 0,
    },
    migratedFromLegacy,
  };

  writeJson(manifestPath, manifest);

  console.log(`[router:auto-sharpen] wrote ${artifact.hints.length} hints to ${latestPath} (history disabled)`);
}

main();
