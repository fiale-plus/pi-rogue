#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = path.join(process.cwd(), ".pi", "fusion", "benchmarks", "hard-tasks");
const DEFAULT_SYNTHESIS_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_SPARK_MODEL = "openai-codex/gpt-5.3-codex-spark";

interface CaseRow {
  id: string;
  title: string;
  prompt: string;
  rubric: string[];
}

interface ScoreRow {
  case_id: string;
  variant: string;
  score: number;
  latency_ms?: number;
  notes?: string;
}

interface BenchmarkVariant {
  id: string;
  model: string;
  fusion: boolean;
}

interface RunMetaRow {
  case_id: string;
  variant: string;
  model: string;
  exit_code: number;
  latency_ms: number;
  output: string;
  stderr: string;
}

const CASES: CaseRow[] = [
  {
    id: "architecture-tradeoff",
    title: "Architecture tradeoff with hidden failure modes",
    prompt: [
      "You are reviewing a proposal to add an LLM orchestration layer to a CLI coding agent.",
      "The proposal adds parallel model calls, a judge pass, and a synthesis pass. It may later add child-agent orchestration.",
      "Give a decision memo: what to ship first, what to defer, what can fail operationally, and what evidence would change the decision.",
      "Be concrete and avoid generic pros/cons.",
    ].join("\n"),
    rubric: [
      "Separates model-only and agentic orchestration scope",
      "Names concrete failure modes: latency, cost, correlated errors, auth, timeout, context leakage",
      "Defines measurable next-step evidence rather than asserting superiority",
      "Avoids sycophantic agreement with the proposal",
    ],
  },
  {
    id: "debug-root-cause",
    title: "Debugging from partial symptoms",
    prompt: [
      "A TypeScript extension registers a custom provider that internally calls other models. Users report intermittent hangs and occasional empty final answers.",
      "Given only this symptom set, propose the most likely root causes, how to instrument them, and a minimal fix plan.",
      "Prioritize hypotheses and include what evidence would falsify each one.",
    ].join("\n"),
    rubric: [
      "Prioritizes cancellation/timeout/stream finalization and empty content handling",
      "Suggests instrumentation at panel, judge, synthesis, trace, and stream layers",
      "Gives falsifiable hypotheses",
      "Keeps fix plan minimal",
    ],
  },
  {
    id: "code-review-risk",
    title: "Risk-focused code review without code execution",
    prompt: [
      "Review this design at a high level: a benchmark harness compares baseline single-model answers to Fusion answers using manually recorded scores.",
      "It writes local JSON/JSONL files and has no remote publishing. Identify blocker-level weaknesses in the benchmark design and how to improve it while keeping scope small.",
    ].join("\n"),
    rubric: [
      "Calls out manual scoring bias and prompt-set overfitting",
      "Recommends fixed cases, blind scoring where possible, and latency capture",
      "Does not demand complex automation before value is proven",
      "Preserves local-only constraint",
    ],
  },
  {
    id: "short-timeout-vs-empty",
    title: "Short triage where timeout and empty-output causes compete",
    prompt: [
      "A custom LLM provider sometimes hangs, and sometimes returns an empty final answer after all upstream calls logged 200 OK.",
      "Give the three most likely root causes and one minimal patch. You must not propose a rewrite or new queue system.",
    ].join("\n"),
    rubric: [
      "Separates hangs from empty final answer causes instead of collapsing them",
      "Names abort/timeout propagation, stream finalization, and response normalization/error swallowing",
      "Gives one minimal patch with instrumentation first",
      "Avoids broad rewrites or queue/orchestrator expansion",
    ],
  },
  {
    id: "short-local-only-benchmark",
    title: "Short benchmark design with local-only constraint",
    prompt: [
      "A maintainer wants to prove a multi-model answer is better than one strong model using only local JSONL files. They are excited and want to publish the win immediately.",
      "Give a small blocker list and a tiny next-step plan. Preserve local-only operation.",
    ].join("\n"),
    rubric: [
      "Flags manual scoring bias, cherry-picking, prompt drift, and missing provenance",
      "Recommends blind paired scoring and raw answer retention",
      "Keeps the next step small and local-only",
      "Pushes back on premature publication without being dismissive",
    ],
  },
  {
    id: "short-fusion-scope-trap",
    title: "Short scope trap: model fusion vs agent orchestration",
    prompt: [
      "A PR adds model Fusion with panel, judge, and synthesis. A reviewer asks to also add subagents that inspect files and edit code in parallel because the primitives exist.",
      "Respond with a decision: what to do now, what to defer, and the smallest useful experiment.",
    ].join("\n"),
    rubric: [
      "Clearly separates model-only Fusion from agentic subagent orchestration",
      "Explains why file-editing agents are deferred: isolation, conflicts, auditability, cost",
      "Suggests a safe parallel experiment that does not change Fusion semantics",
      "Maintains reviewer momentum without accepting scope creep",
    ],
  },
];

function parseList(value: string | boolean | undefined): string[] | undefined {
  if (!value || value === true) return undefined;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return {
    init: Boolean(args.init),
    printCases: Boolean(args["print-cases"]),
    report: Boolean(args.report),
    run: Boolean(args.run),
    dryRun: Boolean(args["dry-run"]),
    dir: String(args.dir || DEFAULT_DIR),
    outDir: args.out ? String(args.out) : undefined,
    concurrency: Math.max(1, Number(args.concurrency || 2)),
    timeoutMs: Math.max(1, Number(args.timeoutMs || args["timeout-ms"] || 900_000)),
    cases: parseList(args.case || args.cases),
    variants: parseList(args.variant || args.variants),
    synthesisModel: String(args["synthesis-model"] || process.env.PI_ROGUE_FUSION_BENCH_SYNTHESIS_MODEL || DEFAULT_SYNTHESIS_MODEL),
    sparkModel: String(args["spark-model"] || process.env.PI_ROGUE_FUSION_BENCH_SPARK_MODEL || DEFAULT_SPARK_MODEL),
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

function initPreset(dir: string, synthesisModel: string, sparkModel: string): void {
  const recipes = {
    recipes: [
      {
        schema: "pi-rogue.fusion.recipe.v1",
        kind: "fusion",
        id: "hard-55-spark",
        model: synthesisModel,
        analysis_models: [synthesisModel, sparkModel],
        max_completion_tokens: 2400,
        timeout_ms: 180000,
        per_model_timeout_ms: 120000,
      },
      {
        schema: "pi-rogue.fusion.recipe.v1",
        kind: "fusion",
        id: "hard-55x2-spark",
        model: synthesisModel,
        analysis_models: [synthesisModel, synthesisModel, sparkModel],
        max_completion_tokens: 2400,
        timeout_ms: 240000,
        per_model_timeout_ms: 150000,
      },
    ],
  };

  writeJson(path.join(dir, "recipes.json"), recipes);
  writeJsonl(path.join(dir, "cases.jsonl"), CASES);
  if (!fs.existsSync(path.join(dir, "runs.jsonl"))) fs.writeFileSync(path.join(dir, "runs.jsonl"), "", "utf8");

  console.log(`wrote ${path.join(dir, "recipes.json")}`);
  console.log(`wrote ${path.join(dir, "cases.jsonl")}`);
  console.log(`record manual scores in ${path.join(dir, "runs.jsonl")}`);
  console.log("");
  console.log("Run locally with:");
  console.log(`  PI_ROGUE_FUSION_ENABLED=1 PI_ROGUE_FUSION_RECIPES=${path.join(dir, "recipes.json")} pi`);
  console.log("");
  console.log("Compare variants per case:");
  console.log(`  baseline: ${synthesisModel}`);
  console.log("  fusion:   fusion/hard-55-spark");
  console.log("  fusion:   fusion/hard-55x2-spark");
  console.log("");
  console.log("Run the full matrix locally in parallel:");
  console.log("  npm run fusion:bench -- --run --concurrency 2");
}

function printCases(): void {
  for (const item of CASES) {
    console.log(`## ${item.id}: ${item.title}`);
    console.log(item.prompt);
    console.log("rubric:");
    for (const line of item.rubric) console.log(`- ${line}`);
    console.log("");
  }
}

function readCases(dir: string): CaseRow[] {
  const file = path.join(dir, "cases.jsonl");
  if (!fs.existsSync(file)) return CASES;
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaseRow);
}

function variants(synthesisModel: string): BenchmarkVariant[] {
  return [
    { id: "baseline-55", model: synthesisModel, fusion: false },
    { id: "hard-55-spark", model: "fusion/hard-55-spark", fusion: true },
    { id: "hard-55x2-spark", model: "fusion/hard-55x2-spark", fusion: true },
  ];
}

function readScoreRows(file: string): ScoreRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ScoreRow)
    .filter((row) => typeof row.case_id === "string" && typeof row.variant === "string" && Number.isFinite(row.score));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function report(dir: string): void {
  const rows = readScoreRows(path.join(dir, "runs.jsonl"));
  if (rows.length === 0) {
    console.log(`no score rows found in ${path.join(dir, "runs.jsonl")}`);
    console.log("append rows like:");
    console.log(JSON.stringify({ case_id: "architecture-tradeoff", variant: "baseline-55", score: 3, latency_ms: 42000, notes: "missed timeout risks" }));
    return;
  }

  const variants = [...new Set(rows.map((row) => row.variant))].sort();
  console.log(`rows: ${rows.length}`);
  for (const variant of variants) {
    const subset = rows.filter((row) => row.variant === variant);
    const latency = subset.map((row) => row.latency_ms).filter((value): value is number => Number.isFinite(value));
    console.log(`${variant}: avg_score=${average(subset.map((row) => row.score)).toFixed(2)} n=${subset.length}${latency.length ? ` avg_latency_ms=${Math.round(average(latency))}` : ""}`);
  }

  const caseIds = [...new Set(rows.map((row) => row.case_id))].sort();
  const wins: Record<string, number> = {};
  for (const caseId of caseIds) {
    const byVariant = rows.filter((row) => row.case_id === caseId);
    const bestScore = Math.max(...byVariant.map((row) => row.score));
    const winners = byVariant.filter((row) => row.score === bestScore).map((row) => row.variant);
    for (const winner of winners) wins[winner] = (wins[winner] || 0) + 1 / winners.length;
  }
  console.log("case wins:");
  for (const [variant, count] of Object.entries(wins).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${variant}: ${count.toFixed(1)}`);
  }
}

function commandFor(variant: BenchmarkVariant, prompt: string, dir: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const recipesPath = path.resolve(path.join(dir, "recipes.json"));
  const baseArgs = ["--no-extensions", "--no-tools", "--print", "--model", variant.model, prompt];
  const args = variant.fusion
    ? ["--no-extensions", "--extension", "packages/bundle/src/extension.ts", "--no-tools", "--print", "--model", variant.model, prompt]
    : baseArgs;
  return {
    command: "pi",
    args,
    env: {
      ...process.env,
      PI_ROGUE_FUSION_ENABLED: "1",
      PI_ROGUE_FUSION_RECIPES: recipesPath,
    },
  };
}

async function runProcess(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      stderr += `\nERROR: command timed out after ${options.timeoutMs}ms\n`;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function runMatrix(args: ReturnType<typeof parseArgs>): Promise<void> {
  const recipesPath = path.join(args.dir, "recipes.json");
  if (!fs.existsSync(recipesPath)) throw new Error(`missing ${recipesPath}; run --init first`);

  const selectedCases = readCases(args.dir).filter((row) => !args.cases || args.cases.includes(row.id));
  const selectedVariants = variants(args.synthesisModel).filter((row) => !args.variants || args.variants.includes(row.id));
  if (selectedCases.length === 0) throw new Error("no benchmark cases selected");
  if (selectedVariants.length === 0) throw new Error("no benchmark variants selected");

  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "Z");
  const outDir = path.resolve(args.outDir || path.join(args.dir, "outputs", `run-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });

  const jobs = selectedCases.flatMap((caseRow) => selectedVariants.map((variant) => ({ caseRow, variant })));
  console.log(`${args.dryRun ? "would run" : "running"} ${jobs.length} jobs with concurrency=${args.concurrency}`);
  console.log(`outputs: ${outDir}`);

  if (args.dryRun) {
    for (const job of jobs) console.log(`${job.caseRow.id}/${job.variant.id}: ${job.variant.model}`);
    return;
  }

  const metaPath = path.join(outDir, "run-meta.jsonl");
  await mapLimit(jobs, args.concurrency, async ({ caseRow, variant }) => {
    const promptPath = path.join(outDir, `${caseRow.id}.prompt.txt`);
    if (!fs.existsSync(promptPath)) fs.writeFileSync(promptPath, caseRow.prompt, "utf8");
    const outPath = path.join(outDir, `${caseRow.id}.${variant.id}.out.md`);
    const errPath = path.join(outDir, `${caseRow.id}.${variant.id}.err`);
    const command = commandFor(variant, caseRow.prompt, args.dir);
    const started = Date.now();
    console.log(`start ${caseRow.id}/${variant.id}`);
    const result = await runProcess(command.command, command.args, { cwd: process.cwd(), env: command.env, timeoutMs: args.timeoutMs });
    const latency = Date.now() - started;
    fs.writeFileSync(outPath, result.stdout, "utf8");
    fs.writeFileSync(errPath, result.stderr, "utf8");
    const row: RunMetaRow = {
      case_id: caseRow.id,
      variant: variant.id,
      model: variant.model,
      exit_code: result.code,
      latency_ms: latency,
      output: outPath,
      stderr: errPath,
    };
    appendJsonl(metaPath, row);
    console.log(`done ${caseRow.id}/${variant.id} code=${result.code} latency_ms=${latency}`);
  });

  console.log(`wrote ${metaPath}`);
  console.log(`record manual scores in ${path.join(args.dir, "runs.jsonl")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) return initPreset(args.dir, args.synthesisModel, args.sparkModel);
  if (args.printCases) return printCases();
  if (args.report) return report(args.dir);
  if (args.run) return runMatrix(args);
  console.log("Usage:");
  console.log("  npm run fusion:bench -- --init");
  console.log("  npm run fusion:bench -- --print-cases");
  console.log("  npm run fusion:bench -- --run [--concurrency 2] [--case architecture-tradeoff] [--variant baseline-55] [--dry-run]");
  console.log("  npm run fusion:bench -- --report");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
