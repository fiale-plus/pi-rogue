#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  applyCalibration,
  brierScore,
  costWeightedLoss,
  expectedCalibrationError,
  type BinaryLabel,
  type Calibration,
} from "../packages/advisor/src/binary-gate-eval.js";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

interface BinaryRow {
  id: string;
  text: string;
  label: BinaryLabel;
  source?: string;
}

interface ModelArtifact {
  kind: "binary-logreg-v1" | "binary-logreg-v2";
  labels: BinaryLabel[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
  config?: Record<string, unknown>;
  calibration?: Calibration;
  thresholds?: { default: number; preflight?: number; review?: number; closeout?: number; };
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
  threshold: number;
  brier: number;
  ece10: number;
  costWeightedLoss: number;
  confusion: Array<{ actual: BinaryLabel; predicted: Array<[BinaryLabel, number]> }>;
  misses: Array<{ text: string; source?: string; actual: BinaryLabel; predicted: BinaryLabel; conf: number }>;
}

interface Metrics { precision: number; recall: number; f1: number; support: number; }

const LABELS: BinaryLabel[] = ["continue", "escalate"];

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

  const num = (key: string, fallback: number) => {
    const value = Number(args[key]);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    input: String(args.input || DEFAULT_INPUT),
    model: String(args.model || DEFAULT_MODEL),
    report: String(args.report || DEFAULT_REPORT),
    topMisses: num("top-misses", 10),
    fnCost: num("fn-cost", 3),
    fpCost: num("fp-cost", 1),
  };
}

type SparseVec = { I: number[]; V: number[] };

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

function thresholdFor(model: ModelArtifact): number {
  return model.thresholds?.default ?? 0.5;
}

function predict(vec: SparseVec, model: ModelArtifact) {
  const index = new Map(model.features.map((feature, i) => [feature, i] as const));
  const scores = model.bias.slice();

  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c];
    const w = model.weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }

  const escalateLogit = scores[1] - scores[0];
  const conf = applyCalibration(escalateLogit, model.calibration);
  const threshold = thresholdFor(model);
  const label = (conf >= threshold ? LABELS[1] : LABELS[0]);
  return {
    label,
    confidence: Math.max(conf, 1 - conf),
    probabilityEscalate: conf,
  };
}

function metricsFor(label: BinaryLabel, rows: BinaryRow[], preds: BinaryLabel[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;

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
  return LABELS.map((actual) => ({
    actual,
    predicted: LABELS.map((predicted) => [
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

  const index = new Map(model.features.map((feature, i) => [feature, i] as const));
  const predictions = rows.map((row) => {
    const vec = vectorize(extractFeatures(row.text), index, model.idf);
    return predict(vec, model);
  });
  const predLabels = predictions.map((p) => p.label);
  const escalateProbs = predictions.map((p) => p.probabilityEscalate);

  const continueM = metricsFor("continue", rows, predLabels);
  const escalateM = metricsFor("escalate", rows, predLabels);

  const counts = rows.reduce((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, { continue: 0, escalate: 0 } as Record<BinaryLabel, number>);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < rows.length; i++) {
    const actualEscalate = rows[i].label === "escalate";
    const predEscalate = predLabels[i] === "escalate";
    if (actualEscalate && predEscalate) tp++;
    else if (!actualEscalate && predEscalate) fp++;
    else if (actualEscalate && !predEscalate) fn++;
    else tn++;
  }

  const threshold = thresholdFor(model);
  const cwl = costWeightedLoss(tp, fp, fn, tn, args.fnCost, args.fpCost);
  const brier = brierScore(escalateProbs, rows.map((row) => row.label));
  const ece10 = expectedCalibrationError(escalateProbs, rows.map((row) => row.label), 10);

  const misses: EvalResult["misses"] = [];
  for (let i = 0; i < rows.length && misses.length < args.topMisses; i++) {
    if (predLabels[i] !== rows[i].label) {
      misses.push({
        text: rows[i].text,
        source: rows[i].source,
        actual: rows[i].label,
        predicted: predLabels[i],
        conf: predictions[i].confidence,
      });
    }
  }

  const correct = predLabels.filter((label, i) => label === rows[i].label).length;
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
    threshold,
    brier,
    ece10,
    costWeightedLoss: cwl,
    confusion: buildConfusion(rows, predLabels),
    misses,
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`accuracy: ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`threshold: ${threshold.toFixed(4)} (fnCost=${args.fnCost}, fpCost=${args.fpCost})`);
  console.log(`escalate precision: ${report.escalatePrecision.toFixed(3)} recall: ${report.escalateRecall.toFixed(3)} f1: ${report.escalateF1.toFixed(3)}`);
  console.log(`continue precision: ${report.continuePrecision.toFixed(3)} recall: ${report.continueRecall.toFixed(3)} f1: ${report.continueF1.toFixed(3)}`);
  console.log(`brier: ${report.brier.toFixed(6)} ece10: ${report.ece10.toFixed(6)} costWeightedLoss: ${report.costWeightedLoss.toFixed(4)}`);
  console.log(`model: ${args.model}`);
  console.log(`report: ${args.report}`);
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; }
