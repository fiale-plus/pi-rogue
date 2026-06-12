#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeSessionCheckpointsJsonl } from "./checkpoints.js";

interface Args {
  command?: string;
  sessions: string[];
  sessionDir?: string;
  output?: string;
  pretty: boolean;
}

function usage(): never {
  console.error(`Usage:
  npm run router:rebuild -- --session <session.jsonl> [--session <session2.jsonl>] [--output <path>] [--pretty]
  npm run router:rebuild -- --session-dir <dir> [--output <path>] [--pretty]

Commands:
  rebuild    Rebuild derived router checkpoints from raw Pi session JSONL files.
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0], sessions: [], pretty: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--session" && next) {
      args.sessions.push(next);
      index++;
      continue;
    }
    if (arg === "--session-dir" && next) {
      args.sessionDir = next;
      index++;
      continue;
    }
    if (arg === "--output" && next) {
      args.output = next;
      index++;
      continue;
    }
    if (arg === "--pretty") {
      args.pretty = true;
      continue;
    }
    usage();
  }
  return args;
}

function defaultOutput(): string {
  return join(process.cwd(), ".pi", "router", "checkpoints.jsonl");
}

function sessionFilesFromDir(dir: string): string[] {
  const resolved = resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`--session-dir is not a directory: ${dir}`);
  }
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (stat.isFile() && path.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(resolved);
  return files.sort();
}

function resolveSessions(args: Args): string[] {
  const sessions = [...args.sessions];
  if (args.sessionDir) sessions.push(...sessionFilesFromDir(args.sessionDir));
  return [...new Set(sessions.map((session) => resolve(session)))];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessions = resolveSessions(args);
  if (args.command !== "rebuild" || sessions.length === 0) usage();

  const output = args.output ?? defaultOutput();
  const result = await writeSessionCheckpointsJsonl(sessions, output);

  const summary = {
    schema: "pi-router.rebuild-summary.v1",
    sessions: result.sessions,
    output: result.output,
    checkpoints: result.checkpoints,
    firstCheckpointId: result.firstCheckpointId,
    lastCheckpointId: result.lastCheckpointId,
  };
  console.log(args.pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
