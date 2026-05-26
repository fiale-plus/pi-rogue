#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_REPORT = path.join(DEFAULT_DIR, "binary-conflict-ablation-report.json");
const LABELS = ["continue", "escalate"] as const;
type BinaryLabel = typeof LABELS[number];
type IntentLabel = "planning" | "implementation" | "debugging" | "review" | "research" | "ops" | "handoff" | "drop";

const BINARY_LABEL: Record<string, BinaryLabel | undefined> = {
  planning: "escalate",
  debugging: "escalate",
  research: "escalate",
  review: "escalate",
  implementation: "continue",
  ops: "continue",
  handoff: "continue",
};

interface BinaryRow { id: string; text: string; label: BinaryLabel; source: string; sourceLabel?: IntentLabel; cwd?: string; }
interface Example { text: string; label: BinaryLabel; source: string; }
interface Metrics { precision: number; recall: number; f1: number; support: number; }

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i++; }
    else args[key] = true;
  }
  return {
    dir: String(args.dir || DEFAULT_DIR),
    report: String(args.report || DEFAULT_REPORT),
    maxFeatures: Number(args["max-features"] || 6000) || 6000,
    minDf: Number(args["min-df"] || 2) || 2,
    epochs: Number(args.epochs || 24) || 24,
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

function normalize(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, " url ").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): string[] {
  const norm = normalize(text);
  return norm ? norm.split(" ").filter(Boolean) : [];
}

function inc(m: Map<string, number>, k: string, by = 1) { m.set(k, (m.get(k) || 0) + by); }

function extractFeatures(text: string) {
  const counts = new Map<string, number>();
  const toks = tokens(text);
  const lower = normalize(text);
  for (const n of [1, 2]) if (toks.length >= n) for (let i = 0; i <= toks.length - n; i++) inc(counts, `w${n}:${toks.slice(i, i + n).join("_")}`);
  const norm = ` ${lower} `;
  for (const n of [3, 4]) if (norm.length >= n) for (let i = 0; i <= norm.length - n; i++) {
    const gram = norm.slice(i, i + n);
    if (!/^\s+$/.test(gram)) inc(counts, `c${n}:${gram}`);
  }
  if (toks.length > 0) inc(counts, `pref1:${toks[0]}`);
  if (toks.length > 1) inc(counts, `pref2:${toks.slice(0, 2).join("_")}`);
  if (toks.length > 2) inc(counts, `pref3:${toks.slice(0, 3).join("_")}`);
  if (text.includes("?")) inc(counts, "cue:question_mark");
  const cues = ["check", "why", "what", "how", "should", "status", "stats", "log", "logs", "review", "diff", "pr", "build", "run", "test", "deploy", "fix", "debug", "install", "configure", "plan", "continue", "resume", "compact", "research", "update", "patch", "cleanup", "remove"];
  const multi = ["what is", "what's", "safe to use", "pull request", "model family", "how does", "next step", "path forward", "should we", "what should"];
  const ts = new Set(toks);
  for (const cue of cues) if (ts.has(cue)) inc(counts, `cue:${cue}`);
  for (const cue of multi) if (lower.includes(cue)) inc(counts, `cue:${cue.replace(/\s+/g, "_")}`);
  return counts;
}

function vectorize(counts: Map<string, number>, index: Map<string, number>, idf: number[]) {
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

function buildFeatureSpace(rows: Example[], maxFeatures: number, minDf: number) {
  const df = new Map<string, number>();
  const docs = rows.map((row) => {
    const counts = extractFeatures(row.text);
    for (const feature of counts.keys()) inc(df, feature);
    return counts;
  });
  const features = [...df.entries()].filter(([, c]) => c >= minDf).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxFeatures).map(([f]) => f);
  const index = new Map(features.map((feature, i) => [feature, i]));
  const idf = features.map((feature) => Math.log((1 + rows.length) / (1 + (df.get(feature) || 0))) + 1);
  return { index, idf, vectors: docs.map((counts) => vectorize(counts, index, idf)) };
}

function softmax(logits: number[]) {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / sum);
}

function predictProbs(vec: { I: number[]; V: number[] }, weights: number[][], bias: number[]): number[] {
  const scores = bias.slice();
  for (let c = 0; c < weights.length; c++) {
    let score = scores[c];
    const w = weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }
  return softmax(scores);
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

function train(rows: Example[], cfg: { maxFeatures: number; minDf: number; epochs: number }) {
  const { index, idf, vectors } = buildFeatureSpace(rows, cfg.maxFeatures, cfg.minDf);
  const y = rows.map((row) => LABELS.indexOf(row.label));
  const weights = Array.from({ length: LABELS.length }, () => new Array<number>(index.size).fill(0));
  const bias = new Array<number>(LABELS.length).fill(0);
  const order = [...Array(vectors.length).keys()];
  const lr = 0.25;
  const l2 = 0.0001;
  for (let epoch = 1; epoch <= cfg.epochs; epoch++) for (const i of shuffle(order, 2000 + epoch)) {
    const probs = predictProbs(vectors[i], weights, bias);
    for (let c = 0; c < LABELS.length; c++) {
      const err = probs[c] - (c === y[i] ? 1 : 0);
      bias[c] -= lr * err;
      for (let j = 0; j < vectors[i].I.length; j++) weights[c][vectors[i].I[j]] = weights[c][vectors[i].I[j]] * (1 - lr * l2) - lr * err * vectors[i].V[j];
    }
  }
  return { index, idf, weights, bias };
}

function metricsFor(label: BinaryLabel, rows: Example[], pred: BinaryLabel[]): Metrics {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].label === label && pred[i] === label) tp++;
    else if (rows[i].label !== label && pred[i] === label) fp++;
    else if (rows[i].label === label && pred[i] !== label) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, support: rows.filter((row) => row.label === label).length };
}

function counts(rows: Example[], key: (row: Example) => string): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const k = key(row);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function evaluate(trainRows: Example[], testRows: Example[], cfg: { maxFeatures: number; minDf: number; epochs: number }) {
  const model = train(trainRows, cfg);
  const pred = testRows.map((row) => {
    const vec = vectorize(extractFeatures(row.text), model.index, model.idf);
    const probs = predictProbs(vec, model.weights, model.bias);
    return LABELS[probs[0] >= probs[1] ? 0 : 1];
  });
  const correct = pred.filter((label, i) => label === testRows[i].label).length;
  const continueMetrics = metricsFor("continue", testRows, pred);
  const escalateMetrics = metricsFor("escalate", testRows, pred);
  return { accuracy: correct / testRows.length, macroF1: (continueMetrics.f1 + escalateMetrics.f1) / 2, continue: continueMetrics, escalate: escalateMetrics };
}

function conflictKeys(dir: string): Set<string> {
  const rows: Array<{ text: string; binary: BinaryLabel; source: string }> = [];
  for (const row of readJsonl<any>(path.join(dir, "gold.jsonl"))) {
    const binary = BINARY_LABEL[String(row.label)];
    if (binary && row.text) rows.push({ text: String(row.text), binary, source: "gold" });
  }
  for (const row of readJsonl<any>(path.join(dir, "examples.jsonl"))) {
    const binary = BINARY_LABEL[String(row.label)];
    if (binary && row.text) rows.push({ text: String(row.text), binary, source: "pi_examples" });
  }
  const grouped = new Map<string, Array<{ binary: BinaryLabel; source: string }>>();
  for (const row of rows) {
    const key = normalize(row.text);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }
  const conflicts = new Set<string>();
  for (const [key, group] of grouped) {
    const labels = new Set(group.map((row) => row.binary));
    const sources = new Set(group.map((row) => row.source));
    if (labels.size > 1 && sources.has("gold") && sources.has("pi_examples")) conflicts.add(key);
  }
  return conflicts;
}

function sourceHoldouts(rows: Example[], cfg: { maxFeatures: number; minDf: number; epochs: number }) {
  const out = [];
  for (const source of Object.keys(counts(rows, (row) => row.source)).sort()) {
    const test = rows.filter((row) => row.source === source);
    const trainRows = rows.filter((row) => row.source !== source);
    if (test.length < 20 || Object.keys(counts(test, (row) => row.label)).length < 2 || trainRows.length < 20) continue;
    out.push({ source, train: trainRows.length, test: test.length, logistic: evaluate(trainRows, test, cfg) });
  }
  return out;
}

function goldHoldout(rows: Example[], cfg: { maxFeatures: number; minDf: number; epochs: number }) {
  const trainRows = rows.filter((row) => row.source !== "gold");
  const test = rows.filter((row) => row.source === "gold");
  return { train: trainRows.length, test: test.length, logistic: evaluate(trainRows, test, cfg) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const binaryRows = readJsonl<BinaryRow>(path.join(args.dir, "binary-gate.jsonl"));
  const rows = binaryRows.map((row) => ({ text: row.text, label: row.label, source: row.source } satisfies Example));
  const conflicts = conflictKeys(args.dir);
  const kept = rows.filter((row) => !conflicts.has(normalize(row.text)));
  const removed = rows.filter((row) => conflicts.has(normalize(row.text)));
  const cfg = { maxFeatures: args.maxFeatures, minDf: args.minDf, epochs: args.epochs };
  const report = {
    input: path.join(args.dir, "binary-gate.jsonl"),
    conflictKeys: conflicts.size,
    full: { rows: rows.length, sourceCounts: counts(rows, (row) => row.source), labelCounts: counts(rows, (row) => row.label), goldHoldout: goldHoldout(rows, cfg), sourceHoldouts: sourceHoldouts(rows, cfg) },
    ablated: { rows: kept.length, removed: removed.length, sourceCounts: counts(kept, (row) => row.source), labelCounts: counts(kept, (row) => row.label), removedCounts: counts(removed, (row) => `${row.source}:${row.label}`), goldHoldout: goldHoldout(kept, cfg), sourceHoldouts: sourceHoldouts(kept, cfg) },
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`conflict keys: ${conflicts.size}`);
  console.log(`removed rows: ${removed.length}`);
  console.log(`full gold holdout: ${(report.full.goldHoldout.logistic.accuracy * 100).toFixed(1)}% macroF1=${report.full.goldHoldout.logistic.macroF1.toFixed(3)}`);
  console.log(`ablated gold holdout: ${(report.ablated.goldHoldout.logistic.accuracy * 100).toFixed(1)}% macroF1=${report.ablated.goldHoldout.logistic.macroF1.toFixed(3)}`);
  for (const ev of report.ablated.sourceHoldouts) console.log(`ablated ${ev.source}: ${(ev.logistic.accuracy * 100).toFixed(1)}% macroF1=${ev.logistic.macroF1.toFixed(3)}`);
  console.log(`report: ${args.report}`);
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; }
