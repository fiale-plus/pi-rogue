#!/usr/bin/env tsx
// One-off head-to-head: legacy v1 operating points vs v2-style Platt calibration
// + cost-weighted threshold. Uses a three-way split so calibration/threshold are
// selected on validation and headline metrics are reported once on untouched test.
import fs from "node:fs";
import {
  applyCalibration,
  brierScore,
  costWeightedLoss,
  expectedCalibrationError,
  fitPlattCalibration,
  guardSliceRecall,
  selectConstrainedThreshold,
  type BinaryLabel,
} from "../packages/advisor/src/binary-gate-eval.js";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";
import { assertDatasetGovernance } from "./binary-dataset-manifest.js";

const LABELS: BinaryLabel[] = ["continue", "escalate"];
const LEGACY_V1_TRUST_THRESHOLD = 0.55;
type Row = { text: string; label: BinaryLabel; source: string; provenance: "reviewed" | "heuristic" };
type SparseVec = { I: number[]; V: number[] };

function shuffle<T>(items: T[], seed: number): T[] {
  let t = seed >>> 0;
  const r = () => { t += 0x6D2B79F5; let r2 = Math.imul(t ^ (t >>> 15), 1 | t); r2 ^= r2 + Math.imul(r2 ^ (r2 >>> 7), 61 | r2); return ((r2 ^ (r2 >>> 14)) >>> 0) / 4294967296; };
  const o = [...items];
  for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

function stratifiedSplit(rows: Row[], trainFrac: number, seed: number) {
  const groups = new Map<BinaryLabel, Row[]>();
  for (const row of rows) { const bucket = groups.get(row.label) ?? []; bucket.push(row); groups.set(row.label, bucket); }
  const train: Row[] = [];
  const test: Row[] = [];
  let offset = seed;
  for (const [, items] of groups) {
    const s = shuffle(items, offset++);
    const testCount = Math.max(1, Math.min(s.length - 1, Math.round(s.length * (1 - trainFrac))));
    test.push(...s.slice(0, testCount));
    train.push(...s.slice(testCount));
  }
  return { train: shuffle(train, seed + 101), test: shuffle(test, seed + 202) };
}

function threeWaySplit(rows: Row[]) {
  const first = stratifiedSplit(rows, 0.7, 42);
  const second = stratifiedSplit(first.test, 0.5, 4242);
  return { train: first.train, validation: second.train, test: second.test };
}

function vectorize(counts: Map<string, number>, index: Map<string, number>, idf: number[]): SparseVec {
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

function trainLogreg(train: Row[], validation: Row[], maxF: number, minDf: number, epochs: number) {
  const df = new Map<string, number>();
  const docs = train.map((row) => {
    const counts = extractBinaryGateFeatureCounts(row.text);
    for (const feature of counts.keys()) df.set(feature, (df.get(feature) || 0) + 1);
    return counts;
  });
  const features = [...df.entries()]
    .filter(([, count]) => count >= minDf)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxF)
    .map(([feature]) => feature);
  const index = new Map(features.map((feature, i) => [feature, i]));
  const idf = features.map((feature) => Math.log((1 + train.length) / (1 + (df.get(feature) || 0))) + 1);
  const vecs = docs.map((counts) => vectorize(counts, index, idf));
  const validationVecs = validation.map((row) => vectorize(extractBinaryGateFeatureCounts(row.text), index, idf));
  const y = train.map((row) => LABELS.indexOf(row.label));
  const validationLabels = validation.map((row) => row.label);
  const weights = Array.from({ length: 2 }, () => new Array<number>(features.length).fill(0));
  const bias = [0, 0];
  let bestWeights = weights.map((row) => row.slice());
  let bestBias = bias.slice();
  let bestF1 = -1;
  const order = [...Array(vecs.length).keys()];

  for (let ep = 1; ep <= epochs; ep++) {
    for (const idx of shuffle(order, ep + 42)) {
      const vec = vecs[idx];
      const actual = y[idx];
      const raw = rawScores(vec, weights, bias);
      const max = Math.max(...raw);
      const exps = raw.map((v) => Math.exp(v - max));
      const sum = exps.reduce((a, b) => a + b, 0) || 1;
      const probs = exps.map((v) => v / sum);
      for (let c = 0; c < 2; c++) {
        const err = probs[c] - (c === actual ? 1 : 0);
        bias[c] -= 0.25 * err;
        for (let i = 0; i < vec.I.length; i++) weights[c][vec.I[i]] = weights[c][vec.I[i]] * (1 - 0.25 * 0.0001) - 0.25 * err * vec.V[i];
      }
    }
    const pred = validationVecs.map((vec) => LABELS[rawScores(vec, weights, bias)[1] > rawScores(vec, weights, bias)[0] ? 1 : 0]);
    const escalateF1 = f1For("escalate", validationLabels, pred);
    if (escalateF1 > bestF1) {
      bestF1 = escalateF1;
      bestWeights = weights.map((row) => row.slice());
      bestBias = bias.slice();
    }
  }
  return { index, idf, weights: bestWeights, bias: bestBias };
}

function f1For(label: BinaryLabel, labels: BinaryLabel[], pred: BinaryLabel[]): number {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === label && pred[i] === label) tp++;
    else if (labels[i] !== label && pred[i] === label) fp++;
    else if (labels[i] === label && pred[i] !== label) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
}

function rawScores(vec: SparseVec, weights: number[][], bias: number[]): number[] {
  const scores = bias.slice();
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < vec.I.length; i++) scores[c] += weights[c][vec.I[i]] * vec.V[i];
  }
  return scores;
}

function logitsOf(rows: Row[], model: ReturnType<typeof trainLogreg>): number[] {
  return rows.map((row) => {
    const vec = vectorize(extractBinaryGateFeatureCounts(row.text), model.index, model.idf);
    const scores = rawScores(vec, model.weights, model.bias);
    return scores[1] - scores[0];
  });
}

function sigmoid(z: number) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }

function confusion(probs: number[], labels: BinaryLabel[], threshold: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < labels.length; i++) {
    const predEscalate = probs[i] >= threshold;
    const actualEscalate = labels[i] === "escalate";
    if (actualEscalate && predEscalate) tp++;
    else if (!actualEscalate && predEscalate) fp++;
    else if (actualEscalate && !predEscalate) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

function summarize(name: string, probs: number[], labels: BinaryLabel[], threshold: number, fnCost: number, fpCost: number, rows: Row[]) {
  const c = confusion(probs, labels, threshold);
  const acc = (c.tp + c.tn) / Math.max(1, c.tp + c.fp + c.fn + c.tn);
  const cwl = costWeightedLoss(c.tp, c.fp, c.fn, c.tn, fnCost, fpCost);
  const guard = guardSliceRecall(rows.map((row, i) => ({ text: row.text, label: labels[i] })), probs, threshold, { safety: 1.0, stuck: 0.9, debug: 0.9 });
  console.log(`${name}:`);
  console.log(`  threshold:       ${threshold.toFixed(4)}`);
  console.log(`  accuracy:        ${(acc * 100).toFixed(1)}%`);
  console.log(`  costWeightedLoss:${cwl.toFixed(4)}`);
  console.log(`  brier:           ${brierScore(probs, labels).toFixed(6)}`);
  console.log(`  ece10:           ${expectedCalibrationError(probs, labels, 10).toFixed(6)}`);
  console.log("  guard-slices:");
  for (const g of guard) console.log(`    ${g.slice.padEnd(8)} support=${g.support} recall=${g.escalateRecall.toFixed(3)} passed=${g.passed}`);
  return { cwl, guardOk: guard.every((g) => g.passed), accuracy: acc };
}

function main() {
  const argv = process.argv.slice(2);
  const weakFlagIndex = argv.indexOf("--allow-weak-label-research");
  const allowWeakLabelResearch = weakFlagIndex >= 0 && argv[weakFlagIndex + 1] !== "false";
  const positional = argv.filter((value, index) => value !== "--allow-weak-label-research" && !(index > 0 && argv[index - 1] === "--allow-weak-label-research" && value === "false"));
  const input = positional[0] || "data/routing/binary-gate.jsonl";
  const fnCost = Number(positional[1] || 3);
  const fpCost = Number(positional[2] || 1);
  const datasetManifest = assertDatasetGovernance(input, allowWeakLabelResearch);
  console.log(`provenance: mode=${datasetManifest.mode} promotable=${datasetManifest.promotable} reviewed=${datasetManifest.counts.reviewed} heuristic=${datasetManifest.counts.heuristic}`);
  const rows = fs.readFileSync(input, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line) as Row);
  const reviewedRows = datasetManifest.promotable ? rows.filter((row) => row.provenance === "reviewed") : rows;
  const heuristicRows = datasetManifest.promotable ? rows.filter((row) => row.provenance === "heuristic") : [];
  const reviewedSplit = threeWaySplit(reviewedRows);
  const train = [...reviewedSplit.train, ...heuristicRows];
  const validation = reviewedSplit.validation;
  const test = reviewedSplit.test;
  const model = trainLogreg(train, validation, 6000, 2, 40);

  const validationLabels = validation.map((row) => row.label);
  const testLabels = test.map((row) => row.label);
  const validationLogits = logitsOf(validation, model);
  const testLogits = logitsOf(test, model);

  const v1ArgmaxProbs = testLogits.map((z) => sigmoid(z));
  const v1Argmax = summarize("v1 argmax ablation (probability>=0.5)", v1ArgmaxProbs, testLabels, 0.5, fnCost, fpCost, test);

  // Legacy v1 call sites only trusted argmax predictions when chosen-class confidence >= 0.55.
  // The full extension then fell back to heuristic routing; this binary-only estimate treats
  // untrusted gate predictions as no model escalation (`continue`) and reports trust coverage.
  const legacyTrusted = v1ArgmaxProbs.map((p) => Math.max(p, 1 - p) >= LEGACY_V1_TRUST_THRESHOLD);
  const legacyCoverage = legacyTrusted.filter(Boolean).length / legacyTrusted.length;
  const legacyAsContinueProbs = v1ArgmaxProbs.map((p, i) => legacyTrusted[i] ? p : 0);
  const v1Legacy = summarize("v1 legacy trust gate (untrusted=>continue binary-only estimate)", legacyAsContinueProbs, testLabels, 0.5, fnCost, fpCost, test);
  console.log(`  trusted coverage: ${(legacyCoverage * 100).toFixed(1)}%`);

  const cal = fitPlattCalibration(validationLogits, validationLabels);
  const validationCalProbs = validationLogits.map((z) => applyCalibration(z, cal));
  const thresholdSelection = selectConstrainedThreshold(validation, validationCalProbs, fnCost, fpCost, {
    steps: 101,
    minAccuracy: 0.87,
    maxEscalationRate: 0.65,
    guardFloors: { safety: 1, stuck: 0.9, debug: 0.9 },
    minGuardSupport: 5,
  });
  const threshold = thresholdSelection.threshold;
  const v2Probs = testLogits.map((z) => applyCalibration(z, cal));
  const v2 = summarize("v2 Platt + constrained validation-selected threshold", v2Probs, testLabels, threshold, fnCost, fpCost, test);

  console.log("");
  console.log(`split: train=${train.length} validation=${validation.length} test=${test.length} (seeded, stratified)`);
  console.log(`costs: fnCost=${fnCost} fpCost=${fpCost}`);
  console.log(`calibration: a=${cal.method === "platt" ? cal.a : 1}, b=${cal.method === "platt" ? cal.b : 0}`);
  console.log(`threshold selection: feasible=${thresholdSelection.feasible} minAccuracy=0.87 maxEscalationRate=0.65 minGuardSupport=5 validationAccuracy=${thresholdSelection.accuracy.toFixed(3)} validationEscalationRate=${thresholdSelection.escalationRate.toFixed(3)} validationCWL=${thresholdSelection.costWeightedLoss.toFixed(4)}`);
  console.log(`delta vs v1 argmax cwl: ${(v2.cwl - v1Argmax.cwl).toFixed(4)} (negative = v2 better)`);
  console.log(`delta vs v1 legacy-estimate cwl: ${(v2.cwl - v1Legacy.cwl).toFixed(4)} (negative = v2 better)`);
  console.log(`v2 beats v1 argmax on cost-weighted loss: ${v2.cwl < v1Argmax.cwl}`);
  console.log(`v2 beats v1 legacy-estimate on cost-weighted loss: ${v2.cwl < v1Legacy.cwl}`);
  console.log(`v2 guard floors all pass: ${v2.guardOk}`);
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; }
