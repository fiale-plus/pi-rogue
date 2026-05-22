#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { LABELS, classifyRoutingText, majorityLabel } from "./routing-heuristics.js";

const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "examples.jsonl");
const DEFAULT_OUTPUT = path.join(process.cwd(), "data", "routing", "baseline-report.json");

interface Row {
  text: string;
  label: string;
  confidence?: number;
  confidenceSource?: string;
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
  turnIndex?: number;
  messageId?: string;
  createdAt?: string;
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
  return {
    input: String(args.input || DEFAULT_INPUT),
    output: String(args.output || DEFAULT_OUTPUT),
    split: Math.max(0.1, Math.min(0.9, Number(args.split || 0.8) || 0.8)),
    quiet: Boolean(args.quiet),
  };
}

function readRows(file: string): Row[] {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row)
    .filter((row) => typeof row.text === "string" && typeof row.label === "string");
}

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const at = Number(a.createdAt || 0) || 0;
    const bt = Number(b.createdAt || 0) || 0;
    if (at !== bt) return at - bt;
    const af = String(a.sessionFile || "");
    const bf = String(b.sessionFile || "");
    if (af !== bf) return af.localeCompare(bf);
    return Number(a.turnIndex || 0) - Number(b.turnIndex || 0);
  });
}

function accuracy(items: Array<{ actual: string; predicted: string }>): number {
  if (items.length === 0) return 0;
  const correct = items.filter((row) => row.actual === row.predicted).length;
  return correct / items.length;
}

function confusion(items: Array<{ actual: string; predicted: string }>) {
  const matrix = new Map<string, Map<string, number>>();
  for (const row of items) {
    if (!matrix.has(row.actual)) matrix.set(row.actual, new Map());
    const inner = matrix.get(row.actual)!;
    inner.set(row.predicted, (inner.get(row.predicted) || 0) + 1);
  }
  return matrix;
}

function printMatrix(matrix: Map<string, Map<string, number>>) {
  const rows = [...matrix.keys()].sort();
  for (const actual of rows) {
    const inner = matrix.get(actual)!;
    const parts = LABELS.map((label) => `${label}:${inner.get(label) || 0}`).filter((part) => !part.endsWith(":0"));
    console.log(`  ${actual}: ${parts.join(", ") || "(none)"}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = sortRows(readRows(args.input));
  if (rows.length === 0) {
    throw new Error(`No routing rows found in ${args.input}`);
  }

  const splitIndex = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * args.split)));
  const train = rows.slice(0, splitIndex);
  const test = rows.slice(splitIndex);

  const trainLabel = majorityLabel(train) || "(none)";
  const majorityPredictions = test.map((row) => ({ actual: row.label, predicted: trainLabel }));
  const heuristicPredictions = test.map((row) => ({
    actual: row.label,
    predicted: classifyRoutingText(row.text, row.cwd).label || "(none)",
  }));

  const report = {
    input: args.input,
    total: rows.length,
    split: args.split,
    train: train.length,
    test: test.length,
    trainLabel,
    labels: LABELS.reduce<Record<string, number>>((acc, label) => {
      acc[label] = rows.filter((row) => row.label === label).length;
      return acc;
    }, {}),
    majority: {
      accuracy: accuracy(majorityPredictions),
      correct: majorityPredictions.filter((row) => row.actual === row.predicted).length,
      total: majorityPredictions.length,
    },
    heuristic: {
      accuracy: accuracy(heuristicPredictions),
      correct: heuristicPredictions.filter((row) => row.actual === row.predicted).length,
      total: heuristicPredictions.length,
      confusion: [...confusion(heuristicPredictions).entries()].map(([actual, inner]) => ({
        actual,
        predicted: [...inner.entries()].sort((a, b) => b[1] - a[1]),
      })),
    },
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!args.quiet) {
    console.log(`rows: ${report.total}`);
    console.log(`train/test: ${report.train}/${report.test} (split ${args.split})`);
    console.log(`train majority: ${report.trainLabel}`);
    console.log(`majority acc: ${(report.majority.accuracy * 100).toFixed(1)}% (${report.majority.correct}/${report.majority.total})`);
    console.log(`heuristic acc: ${(report.heuristic.accuracy * 100).toFixed(1)}% (${report.heuristic.correct}/${report.heuristic.total})`);
    console.log(`report: ${args.output}`);
    console.log("label counts:");
    for (const label of LABELS) {
      console.log(`  ${label}: ${report.labels[label] || 0}`);
    }
    console.log("heuristic confusion:");
    printMatrix(confusion(heuristicPredictions));
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
