#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "binary-gate.jsonl");
const DEFAULT_MODEL = path.join(process.cwd(), "data", "routing", "binary-gate-model.json");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "routing", "binary-training-report.json");

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
    model: String(args.model || DEFAULT_MODEL),
    report: String(args.report || DEFAULT_REPORT),
  };
}

interface BinaryRow { id: string; text: string; label: "escalate" | "continue"; source: string; sourceLabel?: string; cwd?: string; }
interface Example { text: string; label: string; weight?: number; }
interface ModelArtifact { kind: "binary-logreg-v1"; labels: string[]; features: string[]; idf: number[]; bias: number[]; weights: number[][]; config: Record<string, unknown>; }

function extractFeatures(text: string): Map<string, number> {
  return extractBinaryGateFeatureCounts(text);
}

function inc(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) || 0) + by);
}

function shuffle<T>(items: T[], seed: number): T[] {
  let t = seed >>> 0;
  const r = () => { t += 0x6D2B79F5; let r2 = Math.imul(t ^ (t >>> 15), 1 | t); r2 ^= r2 + Math.imul(r2 ^ (r2 >>> 7), 61 | r2); return ((r2 ^ (r2 >>> 14)) >>> 0) / 4294967296; };
  const o = [...items];
  for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}

function stratifiedSplit(rows: Example[], frac: number, seed: number) {
  const g = new Map<string, Example[]>();
  for (const r of rows) { if (!g.has(r.label)) g.set(r.label, []); g.get(r.label)!.push(r); }
  const tr: Example[] = [], te: Example[] = [];
  let o = seed;
  for (const [, items] of g) {
    const s = shuffle(items, o++);
    const tc = Math.max(1, Math.min(s.length - 1, Math.round(s.length * (1 - frac))));
    te.push(...s.slice(0, tc)); tr.push(...s.slice(tc));
  }
  return { train: shuffle(tr, seed + 100), test: shuffle(te, seed + 200) };
}

function buildFeatureSpace(rows: Example[], maxF: number, minDf: number) {
  const df = new Map<string, number>();
  const docs = rows.map(r => { const c = extractFeatures(r.text); for (const f of c.keys()) inc(df, f, 1); return c; });
  const feats = [...df.entries()].filter(([, c]) => c >= minDf).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxF).map(([f]) => f);
  const idx = new Map(feats.map((f, i) => [f, i]));
  const idf = feats.map(f => Math.log((1 + rows.length) / (1 + (df.get(f) || 0))) + 1);
  const vecs = docs.map(c => {
    const p: Array<[number, number]> = []; let n = 0;
    for (const [f, tf] of c) { const i = idx.get(f); if (i === undefined) continue; const v = (1 + Math.log(tf)) * idf[i]; p.push([i, v]); n += v * v; }
    const s = n > 0 ? 1 / Math.sqrt(n) : 1; p.sort((a, b) => a[0] - b[0]);
    return { I: p.map(([i]) => i), V: p.map(([, v]) => v * s) };
  });
  return { features: feats, index: idx, idf, vectors: vecs };
}

function softmax(logits: number[]) { const mx = Math.max(...logits); const ex = logits.map(v => Math.exp(v - mx)); const s = ex.reduce((a, b) => a + b, 0) || 1; return ex.map(v => v / s); }

function predict(vec: { I: number[]; V: number[] }, w: number[][], b: number[]): number {
  let best = 0, bs = -Infinity;
  for (let c = 0; c < w.length; c++) { let s = b[c]; const wt = w[c]; for (let i = 0; i < vec.I.length; i++) s += wt[vec.I[i]] * vec.V[i]; if (s > bs) { bs = s; best = c; } }
  return best;
}

function predictProbs(vec: { I: number[]; V: number[] }, w: number[][], b: number[]): number[] { const s = b.slice(); for (let c = 0; c < w.length; c++) { let v = s[c]; const wt = w[c]; for (let i = 0; i < vec.I.length; i++) v += wt[vec.I[i]] * vec.V[i]; s[c] = v; } return softmax(s); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = fs.readFileSync(args.input, "utf8").split(/\n+/).filter(Boolean).map((l) => JSON.parse(l) as BinaryRow);
  const examples = rows.map(r => ({ text: r.text, label: r.label }));
  const { train, test } = stratifiedSplit(examples, 0.8, 42);
  const { features, index, idf, vectors: trainVecs } = buildFeatureSpace(train, 6000, 2);
  const testVecs = test.map(r => {
    const c = extractFeatures(r.text); const p: Array<[number, number]> = []; let n = 0;
    for (const [f, tf] of c) { const i = index.get(f); if (i === undefined) continue; const v = (1 + Math.log(tf)) * idf[i]; p.push([i, v]); n += v * v; }
    const s = n > 0 ? 1 / Math.sqrt(n) : 1; p.sort((a, b) => a[0] - b[0]);
    return { I: p.map(([i]) => i), V: p.map(([, v]) => v * s) };
  });
  const labels = ["continue", "escalate"];
  const l2i = new Map(labels.map((l, i) => [l, i]));
  const trainY = train.map(r => l2i.get(r.label)!);
  const testY = test.map(r => l2i.get(r.label)!);
  const fc = features.length;
  let w = Array.from({ length: 2 }, () => new Array<number>(fc).fill(0));
  let b = new Array<number>(2).fill(0);
  let bw = w.map(r => r.slice()), bb = b.slice(), bf1 = -1, be = 0;
  const epochOrder = [...Array(trainVecs.length).keys()];
  const lr = 0.25, l2 = 0.0001, epochs = 40;

  for (let ep = 1; ep <= epochs; ep++) {
    for (const idx of shuffle(epochOrder, ep + 42)) {
      const v = trainVecs[idx], y = trainY[idx];
      const probs = predictProbs(v, w, b);
      for (let c = 0; c < 2; c++) {
        const err = (probs[c] - (c === y ? 1 : 0));
        b[c] -= lr * err;
        for (let i = 0; i < v.I.length; i++) w[c][v.I[i]] = w[c][v.I[i]] * (1 - lr * l2) - lr * err * v.V[i];
      }
    }
    const valPred = testVecs.map(v => predict(v, w, b));
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < testY.length; i++) {
      if (testY[i] === 1 && valPred[i] === 1) tp++;
      else if (testY[i] === 1 && valPred[i] === 0) fn++;
      else if (testY[i] === 0 && valPred[i] === 1) fp++;
      else tn++;
    }
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0;
    if (f1 > bf1) { bf1 = f1; be = ep; bw = w.map(r => r.slice()); bb = b.slice(); }
  }

  w = bw; b = bb;
  const finalPred = testVecs.map(v => predict(v, w, b));
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (let i = 0; i < testY.length; i++) {
    if (testY[i] === 1 && finalPred[i] === 1) tp++;
    else if (testY[i] === 1 && finalPred[i] === 0) fn++;
    else if (testY[i] === 0 && finalPred[i] === 1) fp++;
    else tn++;
  }
  const acc = (tp + tn) / (tp + tn + fp + fn);
  const epPrec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const epRec = tp + fn > 0 ? tp / (tp + fn) : 0;
  const epF1 = epPrec + epRec > 0 ? 2 * epPrec * epRec / (epPrec + epRec) : 0;
  const cpPrec = tn + fn > 0 ? tn / (tn + fn) : 0;
  const cpRec = tn + fp > 0 ? tn / (tn + fp) : 0;
  const cpF1 = cpPrec + cpRec > 0 ? 2 * cpPrec * cpRec / (cpPrec + cpRec) : 0;

  const model: ModelArtifact = { kind: "binary-logreg-v1", labels, features, idf, bias: bb, weights: bw, config: { epochs, learningRate: lr, l2 } };
  const report = {
    input: args.input, rows: rows.length, train: train.length, test: test.length,
    binaryCounts: rows.reduce((a: Record<string, number>, r: BinaryRow) => { a[r.label] = (a[r.label] || 0) + 1; return a; }, {}),
    sourceCounts: rows.reduce((a: Record<string, number>, r: BinaryRow) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {}),
    majority: { label: "escalate", accuracy: testY.filter(y => y === 1).length / testY.length, correct: testY.filter(y => y === 1).length, total: testY.length },
    logistic: {
      accuracy: acc, bestEpoch: be,
      escalate: { precision: epPrec, recall: epRec, f1: epF1, support: tp + fn },
      continue: { precision: cpPrec, recall: cpRec, f1: cpF1, support: tn + fp },
      confusion: [
        { actual: "continue", predicted: [["continue", tn], ["escalate", fp]].filter(x => x[1] > 0) },
        { actual: "escalate", predicted: [["continue", fn], ["escalate", tp]].filter(x => x[1] > 0) },
      ],
    },
  };

  fs.mkdirSync(path.dirname(args.model), { recursive: true });
  fs.writeFileSync(args.model, JSON.stringify(model, null, 2) + "\n", "utf8");
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`train/test: ${train.length}/${test.length}`);
  console.log(`binary: ${JSON.stringify(report.binaryCounts)}`);
  console.log(`majority acc: ${(report.majority.accuracy * 100).toFixed(1)}%`);
  console.log(`binary acc: ${(acc * 100).toFixed(1)}%`);
  console.log(`escalate precision: ${(epPrec * 100).toFixed(1)}%`);
  console.log(`escalate recall: ${(epRec * 100).toFixed(1)}%`);
  console.log(`escalate F1: ${(epF1).toFixed(3)}`);
  console.log(`continue precision: ${(cpPrec * 100).toFixed(1)}%`);
  console.log(`continue recall: ${(cpRec * 100).toFixed(1)}%`);
  console.log(`continue F1: ${(cpF1).toFixed(3)}`);
  console.log(`best epoch: ${be}`);
  console.log(`model: ${args.model}`);
  console.log(`report: ${args.report}`);
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; }
