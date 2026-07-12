#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyCalibration,
  brierScore,
  costWeightedLoss,
  expectedCalibrationError,
  fitPlattCalibration,
  sweepThreshold,
  type BinaryLabel,
  type Calibration,
} from "../packages/advisor/src/binary-gate-eval.js";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "binary-gate.jsonl");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "routing", "binary-source-eval-report.json");
const LABELS: BinaryLabel[] = ["continue", "escalate"];

interface BinaryRow {
  id: string;
  text: string;
  label: BinaryLabel;
  source: string;
  sourceLabel?: string;
  cwd?: string;
}

export interface Example {
  text: string;
  label: BinaryLabel;
  source: string;
}

export interface EvalResult {
  trainSources: string[];
  testSource: string;
  train: number;
  test: number;
  threshold: number;
  thresholdSelection: { source: "training-validation" | "fixed-fallback"; fit: number; validation: number };
  testCounts: Record<BinaryLabel, number>;
  majority: { label: BinaryLabel; accuracy: number };
  logistic: {
    accuracy: number;
    macroF1: number;
    costWeightedLoss: number;
    brier: number;
    ece10: number;
    continue: Metrics;
    escalate: Metrics;
    confusion: Array<{ actual: BinaryLabel; predicted: Array<[BinaryLabel, number]> }>;
    calibration: Calibration;
    threshold: number;
  };
}

interface Metrics { precision: number; recall: number; f1: number; support: number; }

interface TrainModel {
  index: Map<string, number>;
  idf: number[];
  weights: number[][];
  bias: number[];
}

export type Config = { maxFeatures: number; minDf: number; epochs: number; fnCost: number; fpCost: number; thresholdSteps: number; };
type SparseVec = { I: number[]; V: number[] };

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

  const num = (key: string, fallback: number) => {
    const v = Number(args[key]);
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    input: String(args.input || DEFAULT_INPUT),
    report: String(args.report || DEFAULT_REPORT),
    maxFeatures: num("max-features", 6000),
    minDf: num("min-df", 2),
    epochs: num("epochs", 24),
    fnCost: num("fn-cost", 3),
    fpCost: num("fp-cost", 1),
    thresholdSteps: num("threshold-steps", 101),
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

function inc(m: Map<string, number>, k: string, b = 1): void {
  m.set(k, (m.get(k) || 0) + b);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function extractFeatures(text: string): Map<string, number> {
  return extractBinaryGateFeatureCounts(text);
}

function buildFeatureSpace(rows: Example[], maxFeatures: number, minDf: number) {
  const df = new Map<string, number>();
  const docs = rows.map((row) => {
    const counts = extractFeatures(row.text);
    for (const feature of counts.keys()) inc(df, feature);
    return counts;
  });
  const features = [...df.entries()]
    .filter(([, count]) => count >= minDf)
    .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
    .slice(0, maxFeatures)
    .map(([feature]) => feature);
  const index = new Map(features.map((feature, i) => [feature, i]));
  const idf = features.map((feature) => Math.log((1 + rows.length) / (1 + (df.get(feature) || 0))) + 1);
  const vectors = docs.map((counts) => vectorizeWith(counts, index, idf));
  return { features, index, idf, vectors };
}

function vectorizeWith(counts: Map<string, number>, index: Map<string, number>, idf: number[]): SparseVec {
  const pairs: Array<[number, number]> = [];
  let norm = 0;
  for (const [feature, tf] of counts) {
    const idx = index.get(feature);
    if (idx === undefined) continue;
    const value = (1 + Math.log(tf)) * idf[idx];
    pairs.push([idx, value]);
    norm += value * value;
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}

function softmax(logits: number[]) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((value) => value / sum);
}

function scores(vec: SparseVec, weights: number[][], bias: number[]): number[] {
  const s = bias.slice();
  for (let c = 0; c < weights.length; c++) {
    let v = s[c];
    const w = weights[c];
    for (let i = 0; i < vec.I.length; i++) v += w[vec.I[i]] * vec.V[i];
    s[c] = v;
  }
  return s;
}

function escalateLogit(vec: SparseVec, weights: number[][], bias: number[]): number {
  const s = scores(vec, weights, bias);
  return s[1] - s[0];
}

function train(train: Example[], cfg: Config): TrainModel {
  const { index, idf, vectors } = buildFeatureSpace(train, cfg.maxFeatures, cfg.minDf);
  const y = train.map((row) => LABELS.indexOf(row.label));
  const featureCount = index.size;
  const weights = Array.from({ length: LABELS.length }, () => new Array<number>(featureCount).fill(0));
  const bias = new Array<number>(LABELS.length).fill(0);
  const order = [...Array(vectors.length).keys()];
  const lr = 0.25;
  const l2 = 0.0001;

  for (let epoch = 1; epoch <= cfg.epochs; epoch++) {
    for (const idx of shuffle(order, 100 + epoch)) {
      const vec = vectors[idx];
      const actual = y[idx];
      const probs = (() => {
        const raw = scores(vec, weights, bias);
        const ex = softmax(raw);
        return ex;
      })();
      for (let c = 0; c < LABELS.length; c++) {
        const err = probs[c] - (c === actual ? 1 : 0);
        bias[c] -= lr * err;
        for (let i = 0; i < vec.I.length; i++) weights[c][vec.I[i]] = weights[c][vec.I[i]] * (1 - lr * l2) - lr * err * vec.V[i];
      }
    }
  }

  return { index, idf, weights, bias };
}

function shuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function metricsFor(label: BinaryLabel, rows: Example[], pred: BinaryLabel[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].label === label && pred[i] === label) tp++;
    else if (rows[i].label !== label && pred[i] === label) fp++;
    else if (rows[i].label === label && pred[i] !== label) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, support: rows.filter((r) => r.label === label).length };
}

function counts(rows: Example[], key: (row: Example) => string): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const k = key(row);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function stableRowKey(row: Example): string {
  return `${row.label}\u0000${row.source}\u0000${row.text}`;
}

export function splitThresholdValidation(rows: Example[]): { fit: Example[]; validation: Example[] } {
  const fit: Example[] = [];
  const validation: Example[] = [];
  for (const label of LABELS) {
    const group = rows.filter((row) => row.label === label).sort((a, b) => compareCodeUnits(stableRowKey(a), stableRowKey(b)));
    const validationCount = group.length >= 2 ? Math.min(group.length - 1, Math.max(1, Math.floor(group.length * 0.2))) : 0;
    validation.push(...group.slice(0, validationCount));
    fit.push(...group.slice(validationCount));
  }
  return { fit, validation };
}

function probabilities(rows: Example[], model: TrainModel, calibration: Calibration): number[] {
  return rows.map((row) => {
    const vec = vectorizeWith(extractFeatures(row.text), model.index, model.idf);
    return applyCalibration(escalateLogit(vec, model.weights, model.bias), calibration);
  });
}

export function evaluateSourceHoldout(trainRows: Example[], testRows: Example[], cfg: Config, testSource: string): EvalResult {
  const canonicalTrain = [...trainRows].sort((a, b) => compareCodeUnits(stableRowKey(a), stableRowKey(b)));
  const canonicalTest = [...testRows].sort((a, b) => compareCodeUnits(stableRowKey(a), stableRowKey(b)));
  const { fit, validation } = splitThresholdValidation(canonicalTrain);
  const selectionRows = fit.length ? fit : trainRows;
  const selectionModel = train(selectionRows, cfg);
  const selectionLogits = selectionRows.map((row) => {
    const vec = vectorizeWith(extractFeatures(row.text), selectionModel.index, selectionModel.idf);
    return escalateLogit(vec, selectionModel.weights, selectionModel.bias);
  });
  const selectionCalibration = fitPlattCalibration(selectionLogits, selectionRows.map((row) => row.label));
  const validationLabels = new Set(validation.map((row) => row.label));
  const validationUsable = validationLabels.size === LABELS.length;
  const threshold = validationUsable
    ? sweepThreshold(probabilities(validation, selectionModel, selectionCalibration), validation.map((row) => row.label), cfg.fnCost, cfg.fpCost, { steps: Math.trunc(cfg.thresholdSteps) }).threshold
    : 0.5;

  // Keep the fitted model/calibration paired with the threshold selected for its probability scale.
  const model = selectionModel;
  const calibration = selectionCalibration;
  const testProbs = probabilities(canonicalTest, model, calibration);
  const labels = canonicalTest.map((row) => row.label);
  const pred = testProbs.map((p) => (p >= threshold ? "escalate" : "continue") as BinaryLabel);

  const continueMetrics = metricsFor("continue", canonicalTest, pred);
  const escalateMetrics = metricsFor("escalate", canonicalTest, pred);
  const correct = pred.filter((p, i) => p === labels[i]).length;
  const confusion = LABELS.map((actual) => ({
    actual,
    predicted: LABELS.map((predictedLabel) => [
      predictedLabel,
      canonicalTest.filter((row, i) => row.label === actual && pred[i] === predictedLabel).length,
    ] as [BinaryLabel, number]),
  }));

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i] === "escalate";
    const p = pred[i] === "escalate";
    if (a && p) tp++;
    else if (!a && p) fp++;
    else if (a && !p) fn++;
    else tn++;
  }

  const brier = brierScore(testProbs, labels);
  const ece10 = expectedCalibrationError(testProbs, labels, 10);
  const cwl = costWeightedLoss(tp, fp, fn, tn, cfg.fnCost, cfg.fpCost);
  const trainCounts = counts(canonicalTrain, (row) => row.label);
  const majorityLabel: BinaryLabel = (trainCounts.escalate || 0) > (trainCounts.continue || 0) ? "escalate" : "continue";
  const majorityCorrect = canonicalTest.filter((row) => row.label === majorityLabel).length;

  return {
    trainSources: Array.from(new Set(canonicalTrain.map((row) => row.source))).sort(),
    testSource,
    train: canonicalTrain.length,
    test: canonicalTest.length,
    threshold,
    thresholdSelection: {
      source: validationUsable ? "training-validation" : "fixed-fallback",
      fit: selectionRows.length,
      validation: validation.length,
    },
    testCounts: {
      continue: canonicalTest.filter((row) => row.label === "continue").length,
      escalate: canonicalTest.filter((row) => row.label === "escalate").length,
    },
    majority: { label: majorityLabel, accuracy: majorityCorrect / Math.max(1, canonicalTest.length) },
    logistic: {
      accuracy: correct / testRows.length,
      macroF1: (continueMetrics.f1 + escalateMetrics.f1) / 2,
      costWeightedLoss: cwl,
      brier,
      ece10,
      continue: continueMetrics,
      escalate: escalateMetrics,
      confusion,
      calibration,
      threshold,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readJsonl<BinaryRow>(args.input).map((row) => ({ text: row.text, label: row.label, source: row.source } satisfies Example));
  const unsortedSourceCounts = counts(rows, (row) => row.source);
  const sourceCounts = Object.fromEntries(Object.keys(unsortedSourceCounts).sort().map((source) => [source, unsortedSourceCounts[source]]));
  const evaluations: EvalResult[] = [];
  for (const source of Object.keys(sourceCounts).sort()) {
    const test = rows.filter((row) => row.source === source);
    const trainRows = rows.filter((row) => row.source !== source);
    if (test.length < 20 || trainRows.length < 20) continue;
    evaluations.push(evaluateSourceHoldout(trainRows, test, args, source));
  }

  const report = {
    input: args.input,
    rows: rows.length,
    sourceCounts,
    config: {
      maxFeatures: args.maxFeatures,
      minDf: args.minDf,
      epochs: args.epochs,
      fnCost: args.fnCost,
      fpCost: args.fpCost,
      thresholdSteps: args.thresholdSteps,
    },
    evaluations,
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`sources: ${JSON.stringify(sourceCounts)}`);
  for (const ev of evaluations) {
    console.log(`${ev.testSource}: n=${ev.test} majority=${(ev.majority.accuracy * 100).toFixed(1)}% logistic=${(ev.logistic.accuracy * 100).toFixed(1)}% macroF1=${ev.logistic.macroF1.toFixed(3)} threshold=${ev.logistic.threshold.toFixed(4)} brier=${ev.logistic.brier.toFixed(6)} ece=${ev.logistic.ece10.toFixed(6)} cwl=${ev.logistic.costWeightedLoss.toFixed(4)}`);
  }
  console.log(`report: ${args.report}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; }
}
