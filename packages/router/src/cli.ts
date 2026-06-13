#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { decideRoute, readCheckpointJsonl, selectCheckpoint } from "./decision.js";
import { writeSessionCheckpointsJsonl } from "./checkpoints.js";
import { appendRouteEvent, buildRouteEvent } from "./ledger.js";
import { writeCapabilityCards, writeShadowEval, writeTeacherPromptRequests, writeTeacherReflection } from "./learning.js";
import { writeTrainingRows } from "./dataset.js";
import { writeEnrichedOutcomes, writeInferredOutcomes } from "./outcomes.js";
import { runTeacherLabeling } from "./teacher-runner.js";

interface Args {
  command?: string;
  sessions: string[];
  sessionDir?: string;
  output?: string;
  checkpointFile?: string;
  checkpointId?: string;
  ledger?: string;
  events?: string;
  labels?: string;
  reflection?: string;
  teacher?: string;
  teacherOutput?: string;
  teacherPrompts?: string;
  requests?: string;
  decisionsOutput?: string;
  outcomes?: string;
  includeLocalRuleLabels?: boolean;
  workspaceDiff?: boolean;
  dryRun?: boolean;
  pretty: boolean;
}

function usage(): never {
  console.error(`Usage:
  npm run router:rebuild -- --session <session.jsonl> [--session <session2.jsonl>] [--output <path>] [--workspace-diff] [--pretty]
  npm run router:rebuild -- --session-dir <dir> [--output <path>] [--workspace-diff] [--pretty]
  npm run router:decide -- --checkpoint-file <checkpoints.jsonl> [--checkpoint-id <id>] [--ledger <events.jsonl>] [--pretty]
  npm run router:cards -- --events <events.jsonl> --output <model-cards.jsonl> [--outcomes <outcomes.jsonl>] [--pretty]
  npm run router:outcomes -- --checkpoint-file <checkpoints.jsonl> --events <events.jsonl> --output <outcomes.jsonl> [--pretty]
  npm run router:outcome-enrich -- --outcomes <outcomes.jsonl> --output <enriched-outcomes.jsonl> [--checkpoint-file <checkpoints.jsonl>] [--events <events.jsonl>] [--pretty]
  npm run router:teacher-requests -- --checkpoint-file <checkpoints.jsonl> --output <requests.jsonl> [--teacher openai-codex/gpt-5.5] [--pretty]
  npm run router:teacher-label -- --requests <requests.jsonl> --teacher-output <decisions.jsonl> --labels <labels.jsonl> [--teacher openai-codex/gpt-5.5] [--dry-run] [--pretty]
  npm run router:reflect -- --checkpoint-file <checkpoints.jsonl> --labels <labels.jsonl> --reflection <reflection.md> [--teacher local-rule] [--teacher-output <decisions.jsonl>] [--teacher-prompts <requests.jsonl>] [--pretty]
  npm run router:dataset -- --checkpoint-file <checkpoints.jsonl> --output <training.jsonl> [--events <events.jsonl>] [--outcomes <outcomes.jsonl>] [--labels <labels.jsonl>] [--include-local-rule-labels] [--pretty]
  npm run router:shadow -- --checkpoint-file <checkpoints.jsonl> --output <report.json> [--ledger <events.jsonl>] [--pretty]

Commands:
  rebuild    Rebuild derived router checkpoints from raw Pi session JSONL files.
  decide     Emit a strict JSON route decision for a checkpoint and optionally append a route event.
  cards      Generate local observed model capability cards from route events and optional outcomes.
  outcomes   Infer conservative outcome skeletons that can be manually enriched.
  outcome-enrich Enrich outcome records from checkpoints and route events.
  teacher-requests Generate local JSONL prompt requests for explicit teacher labeling.
  teacher-label Run explicit teacher model labeling over request JSONL.
  reflect    Generate command-triggered soft routing labels and a reflection artifact.
  dataset    Export trainable rows for a conservative continue-vs-intervene gate.
  shadow     Shadow-evaluate the current rule policy over historical checkpoints.
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
    if (arg === "--checkpoint-file" && next) {
      args.checkpointFile = next;
      index++;
      continue;
    }
    if (arg === "--checkpoint-id" && next) {
      args.checkpointId = next;
      index++;
      continue;
    }
    if (arg === "--ledger" && next) {
      args.ledger = next;
      index++;
      continue;
    }
    if (arg === "--events" && next) {
      args.events = next;
      index++;
      continue;
    }
    if (arg === "--labels" && next) {
      args.labels = next;
      index++;
      continue;
    }
    if (arg === "--reflection" && next) {
      args.reflection = next;
      index++;
      continue;
    }
    if (arg === "--teacher" && next) {
      args.teacher = next;
      index++;
      continue;
    }
    if (arg === "--teacher-output" && next) {
      args.teacherOutput = next;
      index++;
      continue;
    }
    if (arg === "--teacher-prompts" && next) {
      args.teacherPrompts = next;
      index++;
      continue;
    }
    if (arg === "--requests" && next) {
      args.requests = next;
      index++;
      continue;
    }
    if (arg === "--decisions-output" && next) {
      args.decisionsOutput = next;
      index++;
      continue;
    }
    if (arg === "--outcomes" && next) {
      args.outcomes = next;
      index++;
      continue;
    }
    if (arg === "--include-local-rule-labels") {
      args.includeLocalRuleLabels = true;
      continue;
    }
    if (arg === "--workspace-diff") {
      args.workspaceDiff = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
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

async function rebuild(args: Args): Promise<unknown> {
  const sessions = resolveSessions(args);
  if (sessions.length === 0) usage();
  const output = args.output ?? defaultOutput();
  const result = await writeSessionCheckpointsJsonl(sessions, output, { workspaceDiff: args.workspaceDiff });
  return {
    schema: "pi-router.rebuild-summary.v1",
    sessions: result.sessions,
    output: result.output,
    checkpoints: result.checkpoints,
    firstCheckpointId: result.firstCheckpointId,
    lastCheckpointId: result.lastCheckpointId,
  };
}

function decide(args: Args): unknown {
  if (!args.checkpointFile) usage();
  const checkpoints = readCheckpointJsonl(args.checkpointFile);
  const checkpoint = selectCheckpoint(checkpoints, args.checkpointId);
  const decision = decideRoute(checkpoint);
  if (args.ledger) appendRouteEvent(args.ledger, buildRouteEvent(checkpoint, decision));
  return decision;
}

function cards(args: Args): unknown {
  if (!args.events || !args.output) usage();
  const cards = writeCapabilityCards(args.events, args.output, args.outcomes);
  return { schema: "pi-router.cards-summary.v1", output: resolve(args.output), cards: cards.length };
}

function outcomes(args: Args): unknown {
  if (!args.checkpointFile || !args.events || !args.output) usage();
  return writeInferredOutcomes({ checkpointPath: args.checkpointFile, eventsPath: args.events, outputPath: args.output });
}

function outcomeEnrich(args: Args): unknown {
  if (!args.outcomes || !args.output) usage();
  return writeEnrichedOutcomes({ outcomesPath: args.outcomes, outputPath: args.output, checkpointPath: args.checkpointFile, eventsPath: args.events });
}

function teacherRequests(args: Args): unknown {
  if (!args.checkpointFile || !args.output) usage();
  const requests = writeTeacherPromptRequests(args.checkpointFile, args.output, args.teacher ?? "openai-codex/gpt-5.5");
  return { schema: "pi-router.teacher-requests-summary.v1", output: resolve(args.output), requests: requests.length, teacher: args.teacher ?? "openai-codex/gpt-5.5" };
}

async function teacherLabel(args: Args): Promise<unknown> {
  if (!args.requests || !args.teacherOutput || !args.labels) usage();
  return runTeacherLabeling({
    requestsPath: args.requests,
    decisionsOutputPath: args.teacherOutput,
    labelsOutputPath: args.labels,
    teacher: args.teacher,
    dryRun: args.dryRun,
  });
}

function reflect(args: Args): unknown {
  if (!args.checkpointFile || !args.labels || !args.reflection) usage();
  const result = writeTeacherReflection({
    checkpointPath: args.checkpointFile,
    labelsPath: args.labels,
    reflectionPath: args.reflection,
    teacher: args.teacher ?? "local-rule",
    teacherOutputPath: args.teacherOutput,
    teacherPromptPath: args.teacherPrompts,
  });
  return {
    schema: "pi-router.reflect-summary.v1",
    labels: resolve(args.labels),
    reflection: resolve(args.reflection),
    labelCount: result.labels.length,
    teacher: args.teacher ?? "local-rule",
  };
}

function dataset(args: Args): unknown {
  if (!args.checkpointFile || !args.output) usage();
  return writeTrainingRows({
    checkpointPath: args.checkpointFile,
    outputPath: args.output,
    eventsPath: args.events,
    outcomesPath: args.outcomes,
    labelsPath: args.labels,
    includeLocalRuleLabels: args.includeLocalRuleLabels,
  });
}

function shadow(args: Args): unknown {
  if (!args.checkpointFile || !args.output) usage();
  return writeShadowEval(args.checkpointFile, args.output, args.ledger);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = args.command === "rebuild"
    ? await rebuild(args)
    : args.command === "decide"
      ? decide(args)
      : args.command === "cards"
        ? cards(args)
        : args.command === "outcomes"
          ? outcomes(args)
          : args.command === "outcome-enrich"
            ? outcomeEnrich(args)
            : args.command === "teacher-requests"
            ? teacherRequests(args)
            : args.command === "teacher-label"
                ? await teacherLabel(args)
                : args.command === "reflect"
                  ? reflect(args)
                  : args.command === "dataset"
                    ? dataset(args)
                    : args.command === "shadow"
                      ? shadow(args)
                      : usage();
  console.log(args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
