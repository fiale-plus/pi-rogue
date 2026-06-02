#!/usr/bin/env node
/**
 * session-flow-analyzer.ts
 *
 * Extracts repeated goal, loop, and assistant-output patterns from Pi-Rogue
 * orchestration session state. Intended for quick local diagnosis:
 *
 *   npx tsx scripts/session-flow-analyzer.ts
 *   npx tsx scripts/session-flow-analyzer.ts --session-root ~/.pi/agent/fiale-plus/orchestration --output /tmp/session-report.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

type Args = {
  sessionRoot: string;
  output?: string;
  minRun: number;
};

type Run<T> = {
  value: T;
  count: number;
  firstAt?: string;
  lastAt?: string;
};

type NoveltyGuardAssistantTurn = {
  at?: string;
  text?: string;
};

type SessionReport = {
  generatedAt: string;
  sessionRoot: string;
  thresholds: {
    minRun: number;
  };
  goalHistoryRuns: Array<Run<string>>;
  goalAlternatingRuns: Array<Run<string[]>>;
  autoresearchHistoryRuns: Array<Run<string>>;
  assistantRepetitionRuns: Array<Run<string> & { session: string }>;
};

function usage(): never {
  console.error("Usage: npx tsx scripts/session-flow-analyzer.ts [--session-root <path>] [--output <path>] [--min-run <n>]");
  process.exit(2);
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sessionRoot: join(homedir(), ".pi", "agent", "fiale-plus", "orchestration"),
    minRun: 3,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--session-root" && next) {
      args.sessionRoot = expandHome(next);
      index++;
      continue;
    }
    if (arg === "--output" && next) {
      args.output = expandHome(next);
      index++;
      continue;
    }
    if (arg === "--min-run" && next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 2) usage();
      args.minRun = parsed;
      index++;
      continue;
    }
    usage();
  }

  args.sessionRoot = resolve(args.sessionRoot);
  if (args.output) args.output = resolve(args.output);
  return args;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson<T>(path: string): T | null {
  const raw = readText(path).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseJsonLines(path: string): JsonObject[] {
  return readText(path)
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonObject];
      } catch {
        return [];
      }
    });
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameValue(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function repeatedRuns<T extends { at?: string }>(
  entries: T[],
  valueOf: (entry: T) => string,
  minRun: number,
): Array<Run<string>> {
  const runs: Array<Run<string>> = [];
  let current: Run<string> | null = null;

  for (const entry of entries) {
    const value = valueOf(entry).trim();
    if (!value) continue;

    if (current && sameValue(current.value, value)) {
      current.count++;
      current.lastAt = entry.at ?? current.lastAt;
      continue;
    }

    if (current && current.count >= minRun) runs.push(current);
    current = {
      value,
      count: 1,
      firstAt: entry.at,
      lastAt: entry.at,
    };
  }

  if (current && current.count >= minRun) runs.push(current);
  return runs;
}

function alternatingRuns<T extends { at?: string }>(
  entries: T[],
  valueOf: (entry: T) => string,
  minPairs: number,
): Array<Run<string[]>> {
  const values = entries
    .map((entry) => ({ at: entry.at, value: valueOf(entry).trim() }))
    .filter((entry) => entry.value);
  const runs: Array<Run<string[]>> = [];
  let index = 0;

  while (index + 3 < values.length) {
    const first = values[index];
    const second = values[index + 1];
    if (!first || !second || sameValue(first.value, second.value)) {
      index++;
      continue;
    }

    let length = 2;
    while (index + length < values.length) {
      const expected = length % 2 === 0 ? first.value : second.value;
      const candidate = values[index + length];
      if (!candidate || !sameValue(candidate.value, expected)) break;
      length++;
    }

    if (length >= minPairs * 2) {
      runs.push({
        value: [first.value, second.value],
        count: length,
        firstAt: first.at,
        lastAt: values[index + length - 1]?.at,
      });
      index += length;
      continue;
    }

    index++;
  }

  return runs;
}

function listSessionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function assistantRuns(root: string, minRun: number): Array<Run<string> & { session: string }> {
  const runs: Array<Run<string> & { session: string }> = [];
  for (const dir of listSessionDirs(root)) {
    const state = parseJson<{ recentAssistantTurns?: NoveltyGuardAssistantTurn[] }>(join(dir, "novelty-guard.json"));
    const turns = Array.isArray(state?.recentAssistantTurns) ? state.recentAssistantTurns : [];
    for (const run of repeatedRuns(turns, (turn) => String(turn.text ?? ""), minRun)) {
      runs.push({ ...run, session: dir });
    }
  }
  return runs;
}

function buildReport(args: Args): SessionReport {
  const goalEntries = parseJsonLines(join(args.sessionRoot, "goal-history.jsonl")) as Array<{ at?: string; goal?: string }>;
  const researchEntries = parseJsonLines(join(args.sessionRoot, "autoresearch-history.jsonl")) as Array<{
    at?: string;
    previous?: { instruction?: string; goal?: string };
  }>;

  return {
    generatedAt: new Date().toISOString(),
    sessionRoot: args.sessionRoot,
    thresholds: {
      minRun: args.minRun,
    },
    goalHistoryRuns: repeatedRuns(goalEntries, (entry) => String(entry.goal ?? ""), args.minRun),
    goalAlternatingRuns: alternatingRuns(goalEntries, (entry) => String(entry.goal ?? ""), args.minRun),
    autoresearchHistoryRuns: repeatedRuns(
      researchEntries,
      (entry) => String(entry.previous?.goal ?? entry.previous?.instruction ?? ""),
      args.minRun,
    ),
    assistantRepetitionRuns: assistantRuns(args.sessionRoot, args.minRun),
  };
}

const args = parseArgs(process.argv.slice(2));
const report = buildReport(args);
const output = `${JSON.stringify(report, null, 2)}\n`;

if (args.output) {
  writeFileSync(args.output, output, "utf8");
} else {
  process.stdout.write(output);
}
