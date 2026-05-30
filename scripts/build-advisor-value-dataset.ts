#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SummaryRow {
  mode?: string;
  name?: string;
  accuracy?: number;
  score?: number;
  total?: number;
  total_cost?: number;
  rows?: TaskRow[];
}

interface TaskRow {
  task?: string;
  ok?: boolean;
  expected?: string;
  response?: string;
  cost?: number;
}

interface ValueRow {
  id: string;
  text: string;
  label: "continue" | "escalate";
  source: string;
  sourceLabel: string;
  task: string;
  sparkOk: boolean;
  frontierOk?: boolean;
  assistedOk?: boolean;
}

const DEFAULT_SUMMARIES = [
  "/tmp/bench-hard/summary.json",
  "/tmp/bench-guided/summary.json",
  "/tmp/bench-guided2/summary.json",
  "/tmp/bench-modes/summary.json",
  "/tmp/bench-modes-v2/summary.json",
];

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function inputSummaries() {
  const raw = parseArg("summaries");
  if (!raw) return DEFAULT_SUMMARIES;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : DEFAULT_SUMMARIES;
}

function outPath(name: string, fallback: string) {
  return parseArg(name) ?? fallback;
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function modeName(row: SummaryRow): string | undefined {
  return row.mode ?? row.name;
}

function loadSummary(path: string): SummaryRow[] | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed as SummaryRow[] : null;
  } catch {
    return null;
  }
}

function findMode(rows: SummaryRow[], names: string[]) {
  return rows.find((row) => {
    const m = modeName(row);
    return Boolean(m && names.includes(m));
  });
}

function taskMap(row: SummaryRow | undefined) {
  const m = new Map<string, TaskRow>();
  for (const r of row?.rows ?? []) {
    if (typeof r.task === "string") m.set(r.task, r);
  }
  return m;
}

function firstUserTextFromSession(file: string): string | undefined {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown[] } };
      if (row.type !== "message" || row.message?.role !== "user") continue;
      const parts: string[] = [];
      for (const item of row.message.content ?? []) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") {
          parts.push((item as { text: string }).text);
        }
      }
      const text = parts.join("\n").trim();
      if (text) return text;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function promptFor(summaryFile: string, mode: string, task: string, fallback: TaskRow): string {
  const root = dirname(summaryFile);
  const candidates = [
    join(root, mode),
  ];

  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const taskPrefix = task.replace(/[^a-z0-9_-]/gi, "");
    const entries = readdirSync(base, { withFileTypes: true });
    const taskDir = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(`_${taskPrefix}`));
    if (!taskDir) continue;
    const dir = join(base, taskDir.name);
    const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
    if (files.length) {
      const text = firstUserTextFromSession(join(dir, files[files.length - 1]));
      if (text) return text;
    }
    const solveDir = join(dir, "solve");
    if (existsSync(solveDir)) {
      const solveFiles = readdirSync(solveDir).filter((n) => n.endsWith(".jsonl")).sort();
      if (solveFiles.length) {
        const text = firstUserTextFromSession(join(solveDir, solveFiles[solveFiles.length - 1]));
        if (text) return text;
      }
    }
  }

  const expected = fallback.expected ? ` Expected: ${fallback.expected}.` : "";
  const response = fallback.response ? ` Spark response: ${fallback.response}.` : "";
  return `Benchmark task ${task}.${expected}${response}`;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sourceLabel(sparkOk: boolean, frontierOk?: boolean, assistedOk?: boolean): string {
  if (!sparkOk && assistedOk) return "advisor_helps";
  if (!sparkOk && frontierOk) return "frontier_helps";
  if (sparkOk && assistedOk === false) return "advisor_harm";
  if (!sparkOk && frontierOk === false && assistedOk === false) return "all_fail";
  return "no_advisor_needed";
}

function shouldEscalate(sparkOk: boolean, frontierOk?: boolean, assistedOk?: boolean): boolean {
  if (sparkOk) return false;
  return Boolean(assistedOk || frontierOk);
}

function averageCost(row: SummaryRow | undefined): number | undefined {
  if (!row || typeof row.total_cost !== "number" || typeof row.total !== "number" || row.total <= 0) return undefined;
  return row.total_cost / row.total;
}

function buildRows(summaryFile: string, summary: SummaryRow[]): { rows: ValueRow[]; metrics: Record<string, unknown> } {
  const spark = findMode(summary, ["5.3_spark_no_advisor", "5.3_clean"]);
  if (!spark) return { rows: [], metrics: { skipped: "no spark/clean mode" } };
  const sparkMode = modeName(spark)!;
  const frontier = findMode(summary, ["5.5_no_advisor", "5.5_clean"]);
  const assisted = findMode(summary, ["5.3_spark_advised_by_5.5", "5.3_guided_by_5.5"]);

  const sparkTasks = taskMap(spark);
  const frontierTasks = taskMap(frontier);
  const assistedTasks = taskMap(assisted);

  const out: ValueRow[] = [];
  let sparkCorrect = 0;
  let frontierCorrect = 0;
  let assistedCorrect = 0;
  let oracleCorrect = 0;
  let escalateCount = 0;
  let comparable = 0;

  for (const [task, sparkRow] of sparkTasks) {
    const sparkOk = Boolean(sparkRow.ok);
    const frontierOk = bool(frontierTasks.get(task)?.ok);
    const assistedOk = bool(assistedTasks.get(task)?.ok);
    const label = shouldEscalate(sparkOk, frontierOk, assistedOk) ? "escalate" : "continue";
    if (label === "escalate") escalateCount += 1;

    const text = promptFor(summaryFile, sparkMode, task, sparkRow);
    const labelDetail = sourceLabel(sparkOk, frontierOk, assistedOk);
    const row: ValueRow = {
      id: hash(`${summaryFile}:${task}:${text}`),
      text,
      label,
      source: `advisor-value:${summaryFile}`,
      sourceLabel: labelDetail,
      task,
      sparkOk,
      frontierOk,
      assistedOk,
    };
    out.push(row);

    comparable += 1;
    if (sparkOk) sparkCorrect += 1;
    if (frontierOk) frontierCorrect += 1;
    if (assistedOk) assistedCorrect += 1;
    const chosenOk = label === "escalate" ? Boolean(assistedOk ?? frontierOk) : sparkOk;
    if (chosenOk) oracleCorrect += 1;
  }

  const sparkCost = averageCost(spark) ?? 0;
  const frontierCost = averageCost(frontier) ?? 0;
  const assistedCost = averageCost(assisted) ?? 0;

  return {
    rows: out,
    metrics: {
      summaryFile,
      sparkMode,
      frontierMode: frontier ? modeName(frontier) : null,
      assistedMode: assisted ? modeName(assisted) : null,
      rows: comparable,
      labelCounts: {
        continue: comparable - escalateCount,
        escalate: escalateCount,
      },
      accuracies: {
        spark: comparable ? sparkCorrect / comparable : 0,
        frontier: comparable ? frontierCorrect / comparable : null,
        assisted: comparable ? assistedCorrect / comparable : null,
        oracleValueGate: comparable ? oracleCorrect / comparable : 0,
      },
      costsPerTask: {
        spark: sparkCost || null,
        frontier: frontierCost || null,
        assisted: assistedCost || null,
        oracleSparseAdvisor: sparkCost + (frontierCost * (escalateCount / Math.max(1, comparable))),
      },
      advisorCallRate: comparable ? escalateCount / comparable : 0,
    },
  };
}

function main(): number {
  const summaries = inputSummaries();
  const output = outPath("output", "data/routing/advisor-value-benchmark.jsonl");
  const balancedOutput = outPath("balanced-output", "data/routing/advisor-value-train-balanced.jsonl");
  const report = outPath("report", "data/routing/advisor-value-benchmark-report.json");

  const rows: ValueRow[] = [];
  const reports: Record<string, unknown>[] = [];

  for (const summaryFile of summaries) {
    const summary = loadSummary(summaryFile);
    if (!summary) {
      reports.push({ summaryFile, skipped: "not found or invalid" });
      continue;
    }
    const built = buildRows(summaryFile, summary);
    rows.push(...built.rows);
    reports.push(built.metrics);
  }

  const deduped = new Map<string, ValueRow>();
  for (const row of rows) {
    deduped.set(row.id, row);
  }
  const finalRows = [...deduped.values()];

  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(output, finalRows.map((row) => JSON.stringify(row)).join("\n") + (finalRows.length ? "\n" : ""));

  const positives = finalRows.filter((row) => row.label === "escalate");
  const negatives = finalRows.filter((row) => row.label === "continue");
  const balancedRows = [...finalRows];
  if (positives.length > 0 && positives.length < negatives.length) {
    for (let i = 0; balancedRows.filter((row) => row.label === "escalate").length < negatives.length; i++) {
      const src = positives[i % positives.length];
      balancedRows.push({ ...src, id: `${src.id}-dup-${i}` });
    }
  }
  writeFileSync(balancedOutput, balancedRows.map((row) => JSON.stringify(row)).join("\n") + (balancedRows.length ? "\n" : ""));

  const labelCounts = finalRows.reduce((acc: Record<string, number>, row) => {
    acc[row.label] = (acc[row.label] ?? 0) + 1;
    return acc;
  }, {});

  const sourceLabels = finalRows.reduce((acc: Record<string, number>, row) => {
    acc[row.sourceLabel] = (acc[row.sourceLabel] ?? 0) + 1;
    return acc;
  }, {});

  const balancedLabelCounts = balancedRows.reduce((acc: Record<string, number>, row) => {
    acc[row.label] = (acc[row.label] ?? 0) + 1;
    return acc;
  }, {});

  const payload = {
    generatedAt: new Date().toISOString(),
    output,
    balancedOutput,
    rows: finalRows.length,
    balancedRows: balancedRows.length,
    labelCounts,
    balancedLabelCounts,
    sourceLabels,
    summaries: reports,
    interpretation: {
      continue: "Use 5.3 Spark directly; observed 5.3 already succeeds or advisor can hurt.",
      escalate: "Call 5.5 advisor/teacher; observed 5.3 missed while 5.5 or guided path succeeded.",
    },
  };

  writeFileSync(report, JSON.stringify(payload, null, 2) + "\n");

  console.log(`rows: ${finalRows.length}`);
  console.log(`labels: ${JSON.stringify(labelCounts)}`);
  console.log(`source labels: ${JSON.stringify(sourceLabels)}`);
  console.log(`output: ${output}`);
  console.log(`balanced output: ${balancedOutput}`);
  console.log(`balanced labels: ${JSON.stringify(balancedLabelCounts)}`);
  console.log(`report: ${report}`);
  return finalRows.length > 0 ? 0 : 1;
}

process.exit(main());
