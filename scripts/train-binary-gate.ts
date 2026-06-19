#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import {
  applyCalibration,
  brierScore,
  costWeightedLoss,
  expectedCalibrationError,
  fitPlattCalibration,
  guardSliceRecall,
  selectConstrainedThreshold,
  type BinaryLabel,
  type Calibration,
} from "../packages/advisor/src/binary-gate-eval.js";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "binary-gate.jsonl");
const DEFAULT_MODEL = path.join(process.cwd(), "data", "routing", "binary-gate-model.json");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "routing", "binary-training-report.json");
const LABELS: readonly BinaryLabel[] = ["continue", "escalate"] as const;

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
    model: String(args.model || DEFAULT_MODEL),
    report: String(args.report || DEFAULT_REPORT),
    epochs: num("epochs", 40),
    maxFeatures: num("max-features", 6000),
    minDf: num("min-df", 2),
    fnCost: num("fn-cost", 3),
    fpCost: num("fp-cost", 1),
    thresholdSteps: num("threshold-steps", 101),
    minAccuracy: num("min-accuracy", 0.87),
    maxEscalationRate: num("max-escalation-rate", 0.65),
    minGuardSupport: num("min-guard-support", 5),
    safetyFloor: num("safety-floor", 1.0),
    stuckFloor: num("stuck-floor", 0.9),
    debugFloor: num("debug-floor", 0.9),
  };
}

interface BinaryRow { id: string; text: string; label: BinaryLabel; source: string; sourceLabel?: string; cwd?: string; weight?: number; }
interface Example { text: string; label: BinaryLabel; weight: number; source: string; }
interface ModelArtifact {
  kind: "binary-logreg-v2";
  labels: BinaryLabel[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
  config: {
    epochs: number;
    maxFeatures: number;
    minDf: number;
    learningRate: number;
    l2: number;
    fnCost: number;
    fpCost: number;
    thresholdSteps: number;
    minAccuracy: number;
    maxEscalationRate: number;
    minGuardSupport: number;
    safetyFloor: number;
    stuckFloor: number;
    debugFloor: number;
    thresholdFeasible: boolean;
    bestEpoch: number;
    trainRows: number;
    validationRows: number;
    testRows: number;
    rows: number;
  };
  calibration: Calibration;
  thresholds: { default: number; preflight?: number; review?: number; closeout?: number; };
}

interface Report {
  input: string;
  rows: number;
  weightedRows: number;
  train: number;
  validation: number;
  test: number;
  binaryCounts: Record<BinaryLabel, number>;
  sourceCounts: Record<string, number>;
  majority: { label: BinaryLabel; accuracy: number; correct: number; total: number; };
  logistic: {
    accuracy: number;
    bestEpoch: number;
    escalate: Metrics;
    continue: Metrics;
    confusion: Array<{ actual: BinaryLabel; predicted: Array<[BinaryLabel, number]> }>;
    threshold: {
      default: number;
      preflight: number;
      review: number;
      closeout: number;
    };
    thresholdSelection: {
      feasible: boolean;
      minAccuracy: number;
      maxEscalationRate: number;
      minGuardSupport: number;
      validationAccuracy: number;
      validationEscalationRate: number;
      validationCostWeightedLoss: number;
    };
    costWeightedLoss: number;
  };
  calibration: { method: Calibration["method"]; a: number; b: number; };
  calibrationReport: {
    brier: number;
    ece10: number;
    guardSlices: { slice: string; support: number; escalateRecall: number; passed: boolean; }[];
  };
}

interface Metrics { precision: number; recall: number; f1: number; support: number; }

type SparseVec = { I: number[]; V: number[] };

function extractFeatures(text: string): Map<string, number> {
  return extractBinaryGateFeatureCounts(text);
}

function inc(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) || 0) + by);
}

function shuffle<T>(items: T[], seed: number): T[] {
  let t = seed >>> 0;
  const r = () => {
    t += 0x6D2B79F5;
    let r2 = Math.imul(t ^ (t >>> 15), 1 | t);
    r2 ^= r2 + Math.imul(r2 ^ (r2 >>> 7), 61 | r2);
    return ((r2 ^ (r2 >>> 14)) >>> 0) / 4294967296;
  };
  const o = [...items];
  for (let i = o.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
}

function stratifiedSplit(rows: Example[], frac: number, seed: number) {
  const g = new Map<BinaryLabel, Example[]>();
  for (const r of rows) {
    const bucket = g.get(r.label) ?? [];
    bucket.push(r);
    g.set(r.label, bucket);
  }
  const train: Example[] = [];
  const test: Example[] = [];
  let o = seed;
  for (const [, items] of g) {
    const s = shuffle(items, o++);
    // `frac` is the TRAIN fraction; the remainder (1 - frac) is held out for test.
    const testCount = Math.max(1, Math.min(s.length - 1, Math.round(s.length * (1 - frac))));
    test.push(...s.slice(0, testCount));
    train.push(...s.slice(testCount));
  }
  return { train: shuffle(train, seed + 101), test: shuffle(test, seed + 202) };
}

function buildFeatureSpace(rows: Example[], maxF: number, minDf: number) {
  const df = new Map<string, number>();
  const docs = rows.map((r) => {
    const c = extractFeatures(r.text);
    for (const f of c.keys()) inc(df, f, 1);
    return c;
  });
  const features = [...df.entries()]
    .filter(([, c]) => c >= minDf)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxF)
    .map(([f]) => f);
  const index = new Map(features.map((f, i) => [f, i]));
  const idf = features.map((f) => Math.log((1 + rows.length) / (1 + (df.get(f) || 0))) + 1);
  const vectors = docs.map((counts) => vectorizeWith(counts, index, idf));
  return { features, index, idf, vectors };
}

function vectorizeWith(counts: Map<string, number>, index: Map<string, number>, idf: number[]): SparseVec {
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
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}


function predictRawScores(vec: SparseVec, w: number[][], b: number[]): number[] {
  const scores = b.slice();
  for (let c = 0; c < w.length; c++) {
    let score = scores[c];
    const wt = w[c];
    for (let i = 0; i < vec.I.length; i++) score += wt[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }
  return scores;
}

function escalateLogit(vec: SparseVec, w: number[][], b: number[]): number {
  const scores = predictRawScores(vec, w, b);
  // labels: [continue, escalate]
  return scores[1] - scores[0];
}

function predict(vec: SparseVec, w: number[][], b: number[]): 0 | 1 {
  const scores = predictRawScores(vec, w, b);
  return scores[0] >= scores[1] ? 0 : 1;
}

function normalizeWeight(weight: unknown): number {
  const value = Number(weight ?? 1);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(value, 20);
}

function metricsFor(label: BinaryLabel, rows: BinaryLabel[], pred: BinaryLabel[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === label && pred[i] === label) tp++;
    else if (rows[i] !== label && pred[i] === label) fp++;
    else if (rows[i] === label && pred[i] !== label) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, support: rows.filter((l) => l === label).length };
}


function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = fs.readFileSync(args.input, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line) as BinaryRow);
  const examples: Example[] = rows.map((r) => ({ text: r.text, label: r.label, weight: normalizeWeight(r.weight), source: r.source }));
  // Three-way split: train fits logreg weights; validation fits calibration + threshold;
  // test is untouched until final reporting. This avoids threshold selection on test.
  const firstSplit = stratifiedSplit(examples, 0.7, 42);
  const secondSplit = stratifiedSplit(firstSplit.test, 0.5, 4242);
  const train = firstSplit.train;
  const validation = secondSplit.train;
  const test = secondSplit.test;

  const { features, index, idf, vectors: trainVecs } = buildFeatureSpace(train, args.maxFeatures, args.minDf);
  const validationVecs = validation.map((r) => vectorizeWith(extractFeatures(r.text), index, idf));
  const testVecs = test.map((r) => vectorizeWith(extractFeatures(r.text), index, idf));

  const trainY = train.map((r) => LABELS.indexOf(r.label));
  const validationY = validation.map((r) => LABELS.indexOf(r.label));
  const testY = test.map((r) => LABELS.indexOf(r.label));

  const fc = features.length;
  let w = Array.from({ length: LABELS.length }, () => new Array<number>(fc).fill(0));
  let b = new Array<number>(LABELS.length).fill(0);
  let bw = w.map((row) => row.slice());
  let bb = b.slice();
  let be = 0;
  let bf1 = -1;

  const lr = 0.25;
  const l2 = 0.0001;
  const epochOrder = [...Array(trainVecs.length).keys()];

  for (let ep = 1; ep <= args.epochs; ep++) {
    for (const idx of shuffle(epochOrder, ep + 42)) {
      const vec = trainVecs[idx];
      const y = trainY[idx];
      const weight = train[idx]?.weight ?? 1;
      const probs = (() => {
        const raw = predictRawScores(vec, w, b);
        const max = Math.max(...raw);
        const exps = raw.map((v) => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0) || 1;
        return exps.map((v) => v / sum);
      })();
      for (let c = 0; c < LABELS.length; c++) {
        const err = (probs[c] - (c === y ? 1 : 0)) * weight;
        b[c] -= lr * err;
        for (let i = 0; i < vec.I.length; i++) w[c][vec.I[i]] = w[c][vec.I[i]] * (1 - lr * l2) - lr * err * vec.V[i];
      }
    }

    const valPred = validationVecs.map((v) => predict(v, w, b));
    const valActual = validationY.map((y) => LABELS[y]);
    const valPredLabel = valPred.map((p) => LABELS[p]);
    const escalateMetrics = metricsFor("escalate", valActual, valPredLabel);
    if (escalateMetrics.f1 > bf1) {
      bf1 = escalateMetrics.f1;
      be = ep;
      bw = w.map((row) => row.slice());
      bb = b.slice();
    }
  }

  w = bw; b = bb;
  const validationLabels = validationY.map((y) => LABELS[y]);
  const testLabels = testY.map((y) => LABELS[y]);

  const validationLogits = validationVecs.map((v) => escalateLogit(v, w, b));
  const calibration = fitPlattCalibration(validationLogits, validationLabels);
  const validationCalProbs = validationLogits.map((logit) => applyCalibration(logit, calibration));
  const thresholdSelection = selectConstrainedThreshold(
    validation.map((row, i) => ({ text: row.text, label: validationLabels[i] })),
    validationCalProbs,
    args.fnCost,
    args.fpCost,
    {
      steps: Math.trunc(args.thresholdSteps),
      minAccuracy: args.minAccuracy,
      maxEscalationRate: args.maxEscalationRate,
      guardFloors: { safety: args.safetyFloor, stuck: args.stuckFloor, debug: args.debugFloor },
      minGuardSupport: args.minGuardSupport,
    },
  );
  const threshold = thresholdSelection.threshold;

  const testLogits = testVecs.map((v) => escalateLogit(v, w, b));
  const testCalProbs = testLogits.map((logit) => applyCalibration(logit, calibration));
  // Review-phase routing is more safety-sensitive than the default/preflight gate,
  // so keep it slightly more recall-biased than the global threshold. This also
  // preserves the advisor loop-convergence smoke tests without making preflight spammy.
  const reviewThreshold = Math.min(threshold, 0.05);

  const testPredByThreshold = testCalProbs.map((p) => (p >= threshold ? "escalate" : "continue"));
  const testContinue = metricsFor("continue", testLabels, testPredByThreshold);
  const testEsc = metricsFor("escalate", testLabels, testPredByThreshold);
  const confusion = LABELS.map((actual) => ({
    actual,
    predicted: LABELS.map((label) => [label, testLabels.filter((l, i) => l === actual && testPredByThreshold[i] === label).length] as [BinaryLabel, number]).filter(([, count]) => count > 0),
  }));

  const cp = confusion.find((row) => row.actual === "continue");
  const ep = confusion.find((row) => row.actual === "escalate");
  const tn = cp?.predicted.find((item) => item[0] === "continue")?.[1] ?? 0;
  const fp = cp?.predicted.find((item) => item[0] === "escalate")?.[1] ?? 0;
  const tp = ep?.predicted.find((item) => item[0] === "escalate")?.[1] ?? 0;
  const fn = ep?.predicted.find((item) => item[0] === "continue")?.[1] ?? 0;

  const guard = guardSliceRecall(
    test.map((row, i) => ({ text: row.text, label: testLabels[i] })),
    testCalProbs,
    threshold,
    { safety: args.safetyFloor },
  );

  const weightedRows = examples.reduce((sum, row) => sum + row.weight, 0);
  const acc = (tp + tn) / (tp + fp + fn + tn || 1);
  const brier = brierScore(testCalProbs, testLabels);
  const ece10 = expectedCalibrationError(testCalProbs, testLabels, 10);
  const cwl = costWeightedLoss(tp, fp, fn, tn, args.fnCost, args.fpCost);

  const sourceCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  const model: ModelArtifact = {
    kind: "binary-logreg-v2",
    labels: [...LABELS],
    features,
    idf,
    bias: bb,
    weights: bw,
    config: {
      epochs: args.epochs,
      maxFeatures: args.maxFeatures,
      minDf: args.minDf,
      learningRate: lr,
      l2,
      fnCost: args.fnCost,
      fpCost: args.fpCost,
      thresholdSteps: args.thresholdSteps,
      minAccuracy: args.minAccuracy,
      maxEscalationRate: args.maxEscalationRate,
      minGuardSupport: args.minGuardSupport,
      safetyFloor: args.safetyFloor,
      stuckFloor: args.stuckFloor,
      debugFloor: args.debugFloor,
      thresholdFeasible: thresholdSelection.feasible,
      bestEpoch: be,
      trainRows: train.length,
      validationRows: validation.length,
      testRows: test.length,
      rows: rows.length,
    },
    calibration,
    thresholds: {
      default: threshold,
      preflight: threshold,
      review: reviewThreshold,
      closeout: threshold,
    },
  };

  const majority = rows.reduce((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, {} as Record<BinaryLabel, number>);

  const majorityLabel = (majority.escalate || 0) > (majority.continue || 0) ? "escalate" : "continue";
  const majorityAccuracy = (testY.filter((y) => LABELS[y] === majorityLabel).length) / Math.max(1, testY.length);

  const report: Report = {
    input: args.input,
    rows: rows.length,
    weightedRows,
    train: train.length,
    validation: validation.length,
    test: test.length,
    binaryCounts: { continue: majority.continue || 0, escalate: majority.escalate || 0 },
    sourceCounts,
    majority: {
      label: majorityLabel,
      accuracy: majorityAccuracy,
      correct: testY.filter((y) => LABELS[y] === majorityLabel).length,
      total: testY.length,
    },
    logistic: {
      accuracy: acc,
      bestEpoch: be,
      escalate: testEsc,
      continue: testContinue,
      confusion,
      threshold: { default: threshold, preflight: threshold, review: reviewThreshold, closeout: threshold },
      thresholdSelection: {
        feasible: thresholdSelection.feasible,
        minAccuracy: args.minAccuracy,
        maxEscalationRate: args.maxEscalationRate,
        minGuardSupport: args.minGuardSupport,
        validationAccuracy: thresholdSelection.accuracy,
        validationEscalationRate: thresholdSelection.escalationRate,
        validationCostWeightedLoss: thresholdSelection.costWeightedLoss,
      },
      costWeightedLoss: cwl,
    },
    calibration: {
      method: calibration.method,
      a: calibration.method === "platt" ? calibration.a : 1,
      b: calibration.method === "platt" ? calibration.b : 0,
    },
    calibrationReport: {
      brier,
      ece10,
      guardSlices: guard.map((item) => ({ ...item, slice: item.slice })),
    },
  };

  fs.mkdirSync(path.dirname(args.model), { recursive: true });
  fs.writeFileSync(args.model, JSON.stringify(model, null, 2) + "\n", "utf8");
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`train/validation/test: ${train.length}/${validation.length}/${test.length}`);
  console.log(`binary: ${JSON.stringify(report.binaryCounts)}`);
  console.log(`majority acc: ${(majorityAccuracy * 100).toFixed(1)}%`);
  console.log(`binary acc: ${(acc * 100).toFixed(1)}%`);
  console.log(`escalate precision: ${(testEsc.precision * 100).toFixed(1)}%`);
  console.log(`escalate recall: ${(testEsc.recall * 100).toFixed(1)}%`);
  console.log(`escalate F1: ${(testEsc.f1).toFixed(3)}`);
  console.log(`continue precision: ${(testContinue.precision * 100).toFixed(1)}%`);
  console.log(`continue recall: ${(testContinue.recall * 100).toFixed(1)}%`);
  console.log(`continue F1: ${(testContinue.f1).toFixed(3)}`);
  console.log(`best epoch: ${be}`);
  console.log(`validation-selected threshold: ${threshold.toFixed(4)} (review=${reviewThreshold.toFixed(4)}, feasible=${thresholdSelection.feasible}) (fnCost=${args.fnCost}, fpCost=${args.fpCost})`);
  console.log(`model: ${args.model}`);
  console.log(`report: ${args.report}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
}
