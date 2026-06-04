#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

type BinaryLabel = "continue" | "escalate";
interface BinaryRow {
  id: string;
  text: string;
  label: BinaryLabel;
  source?: string;
}

interface ModelArtifact {
  kind: string;
  labels: BinaryLabel[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
  config?: Record<string, unknown>;
}

interface EvalResult {
  input: string;
  model: string;
  rows: number;
  counts: Record<BinaryLabel, number>;
  accuracy: number;
  escalatePrecision: number;
  escalateRecall: number;
  escalateF1: number;
  continuePrecision: number;
  continueRecall: number;
  continueF1: number;
  confusion: Array<{ actual: BinaryLabel; predicted: Array<[BinaryLabel, number]> }>;
  misses: Array<{ text: string; source?: string; actual: BinaryLabel; predicted: BinaryLabel; conf: number }>;
}

interface Metrics { precision: number; recall: number; f1: number; support: number; }

const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "binary-gate.jsonl");
const DEFAULT_MODEL = path.join(homedir(), ".pi", "agent", "fiale-plus", "advisor", "binary-gate-model.json");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "routing", "binary-gate-file-eval-report.json");

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }

  return {
    input: String(args.input || DEFAULT_INPUT),
    model: String(args.model || DEFAULT_MODEL),
    report: String(args.report || DEFAULT_REPORT),
    topMisses: Number(args["top-misses"] || 10) || 10,
  };
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function extractFeatures(text: string): Map<string, number> {
  return extractBinaryGateFeatureCounts(text);
}

function vectorize(counts: Map<string, number>, index: Map<string, number>, idf: number[]) {
  const pairs: Array<[number, number]> = [];
  let norm = 0;

  for (const [feature, tf] of counts) {
    const i = index.get(feature);
    if (i === undefined) continue;
    const value = (1 + Math.log(tf)) * idf[i];
    pairs.push([i, value]);
    norm += value * value;
  }

  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    I: pairs.map(([i]) => i),
    V: pairs.map(([, v]) => v * scale),
  };
}

function softmax(logits: number[]) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
  return exps.map((value) => value / sum);
}

function predict(text: string, model: ModelArtifact) {
  const index = new Map(model.features.map((feature, i) => [feature, i] as const));
  const vec = vectorize(extractFeatures(text), index, model.idf);
  const scores = model.bias.slice();

  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c];
    const w = model.weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }

  const probs = softmax(scores);
  const predIdx = probs[0] >= probs[1] ? 0 : 1;
  return {
    label: model.labels[predIdx],
    confidence: probs[predIdx],
  };
}

function metricsFor(label: BinaryLabel, rows: BinaryRow[], preds: BinaryLabel[]) {
  let tp = 0, fp = 0, fn = 0;

  for (let i = 0; i < rows.length; i++) {
    const actual = rows[i].label;
    const predicted = preds[i];
    if (actual === label && predicted === label) tp++;
    else if (actual !== label && predicted === label) fp++;
    else if (actual === label && predicted !== label) fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, support: rows.filter((r) => r.label === label).length } satisfies Metrics;
}

function buildConfusion(rows: BinaryRow[], preds: BinaryLabel[]) {
  const labels: BinaryLabel[] = ["continue", "escalate"];
  return labels.map((actual) => ({
    actual,
    predicted: labels.map((predicted) => [
      predicted,
      rows.filter((r, i) => r.label === actual && preds[i] === predicted).length,
    ] as [BinaryLabel, number]),
  }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rows = readJsonl<BinaryRow>(args.input);
  const model = JSON.parse(fs.readFileSync(args.model, "utf8")) as ModelArtifact;
  if (!model.labels?.length || model.labels.length !== 2) {
    throw new Error("Model labels missing or unsupported (expected two classes).");
  }

  if (rows.length === 0) {
    throw new Error(`No rows in input: ${args.input}`);
  }

  const preds = rows.map((row) => predict(row.text, model));
  const predLabels = preds.map((p) => p.label);
  const confs = preds.map((p) => p.confidence);

  const actual = rows.map((row) => row.label);
  const correct = predLabels.filter((label, i) => label === actual[i]).length;

  const continueM = metricsFor("continue", rows, predLabels);
  const escalateM = metricsFor("escalate", rows, predLabels);

  const counts = rows.reduce((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, { continue: 0, escalate: 0 } as Record<BinaryLabel, number>);

  const misses: EvalResult["misses"] = [];
  for (let i = 0; i < rows.length; i++) {
    if (predLabels[i] !== actual[i] && misses.length < args.topMisses) {
      misses.push({
        text: rows[i].text,
        source: rows[i].source,
        actual: actual[i],
        predicted: predLabels[i],
        conf: confs[i],
      });
    }
  }

  const report: EvalResult = {
    input: args.input,
    model: args.model,
    rows: rows.length,
    counts,
    accuracy: correct / rows.length,
    escalatePrecision: escalateM.precision,
    escalateRecall: escalateM.recall,
    escalateF1: escalateM.f1,
    continuePrecision: continueM.precision,
    continueRecall: continueM.recall,
    continueF1: continueM.f1,
    confusion: buildConfusion(rows, predLabels),
    misses,
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`accuracy: ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`escalate precision: ${report.escalatePrecision.toFixed(3)} recall: ${report.escalateRecall.toFixed(3)} f1: ${report.escalateF1.toFixed(3)}`);
  console.log(`continue precision: ${report.continuePrecision.toFixed(3)} recall: ${report.continueRecall.toFixed(3)} f1: ${report.continueF1.toFixed(3)}`);
  console.log(`model: ${args.model}`);
  console.log(`report: ${args.report}`);
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; }
