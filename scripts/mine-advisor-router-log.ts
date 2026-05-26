#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const FALLBACK_INPUT = path.join(DEFAULT_HOME, ".pi", "agent", "fiale-plus", "advisor", "evals", "advisor-router.jsonl");
const DEFAULT_DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_OUTPUT = path.join(DEFAULT_DIR, "advisor-router-examples.jsonl");
const DEFAULT_REPORT = path.join(DEFAULT_DIR, "advisor-router-report.json");

interface RouterRow {
  at?: string;
  version?: number;
  phase?: string;
  label?: string;
  confidence?: number;
  reason?: string;
  source?: string;
  safety?: boolean;
  escalate?: boolean;
  preflight?: string;
  review?: string;
  promptHash?: string;
  prompt?: string;
  brief?: string;
  sourceFile?: string;
}

interface AdvisorExample {
  id: string;
  at?: string;
  phase: string;
  label: string;
  target: string;
  confidence?: number;
  reason?: string;
  source?: string;
  safety?: boolean;
  escalate?: boolean;
  preflight?: string;
  review?: string;
  prompt?: string;
  brief?: string;
  sourceFile?: string;
  text: string;
  trainable: boolean;
  diagnosticOnly: boolean;
  issue?: string;
}

function discoverDefaultInputs(): string[] {
  const agentRoot = path.join(DEFAULT_HOME, ".pi", "agent");
  if (!fs.existsSync(agentRoot)) return fs.existsSync(FALLBACK_INPUT) ? [FALLBACK_INPUT] : [];
  const found = fs.readdirSync(agentRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentRoot, entry.name, "advisor", "evals", "advisor-router.jsonl"))
    .filter((file) => fs.existsSync(file));
  return Array.from(new Set(found)).sort();
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  const inputs = typeof args.input === "string"
    ? args.input.split(",").map((file) => file.trim()).filter(Boolean)
    : discoverDefaultInputs();
  return {
    inputs,
    output: String(args.output || DEFAULT_OUTPUT),
    report: String(args.report || DEFAULT_REPORT),
  };
}

function readJsonl(file: string): RouterRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return { ...(JSON.parse(line) as RouterRow), sourceFile: file }; } catch { return null; }
    })
    .filter((row): row is RouterRow => Boolean(row));
}

function squish(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countBy<T>(rows: T[], fn: (row: T) => string | undefined): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = fn(row) || "missing";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function toExample(row: RouterRow): AdvisorExample {
  const phase = String(row.phase || "unknown");
  const label = String(row.label || "unknown");
  const prompt = squish(row.prompt);
  const brief = squish(row.brief);
  const text = [prompt && prompt !== "(none)" ? `Prompt: ${prompt}` : "", brief ? `Brief: ${brief}` : ""].filter(Boolean).join("\n");
  const failure = /turn reported failure/i.test(String(row.reason || ""));
  const emptyText = text.trim().length === 0;
  const abstain = label === "abstain";
  const diagnosticOnly = failure || emptyText;
  const trainable = !diagnosticOnly && !abstain && phase !== "unknown" && label !== "unknown";
  const issue = failure
    ? "failed-turn-closeout"
    : emptyText
      ? "empty-prompt-and-brief"
      : abstain
        ? "abstain-not-actionable-gold"
        : undefined;

  return {
    id: row.promptHash || `${phase}:${label}:${row.at || "unknown"}`,
    at: row.at,
    phase,
    label,
    target: `${phase}:${label}`,
    confidence: row.confidence,
    reason: row.reason,
    source: row.source,
    safety: row.safety,
    escalate: row.escalate,
    preflight: row.preflight,
    review: row.review,
    prompt: prompt || undefined,
    brief: brief || undefined,
    sourceFile: row.sourceFile,
    text,
    trainable,
    diagnosticOnly,
    issue,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = args.inputs.flatMap((input) => readJsonl(input));
  const examples = rows.map(toExample);
  const trainable = examples.filter((row) => row.trainable);
  const diagnostics = examples.filter((row) => row.diagnosticOnly || row.issue);
  const failureRows = examples.filter((row) => row.issue === "failed-turn-closeout");

  const report = {
    inputFiles: args.inputs,
    rows: rows.length,
    output: args.output,
    trainable: trainable.length,
    diagnostics: diagnostics.length,
    byPhase: countBy(examples, (row) => row.phase),
    byTarget: countBy(examples, (row) => row.target),
    byIssue: countBy(examples.filter((row) => row.issue), (row) => row.issue),
    failedTurnCloseouts: {
      count: failureRows.length,
      sample: failureRows.slice(-10).map((row) => ({ at: row.at, target: row.target, reason: row.reason, brief: row.brief?.slice(0, 220) })),
    },
    recommendation: {
      addToIntentTraining: false,
      addToAdvisorPhaseTraining: trainable.length >= 50,
      note: "Advisor-router log labels are phase-specific (preflight/review/closeout), not task-intent labels. Use them for advisor router evaluation/training, not the task-intent classifier. Failed-turn closeouts are diagnostic rows and should not be mixed into intent training.",
    },
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, examples.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`input files: ${args.inputs.length}`);
  for (const input of args.inputs) console.log(`- ${input}`);
  console.log(`router rows: ${rows.length}`);
  console.log(`trainable advisor examples: ${trainable.length}`);
  console.log(`diagnostic/issue rows: ${diagnostics.length}`);
  console.log(`failed-turn closeouts: ${failureRows.length}`);
  console.log(`targets: ${JSON.stringify(report.byTarget)}`);
  console.log(`examples file: ${args.output}`);
  console.log(`report file: ${args.report}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
