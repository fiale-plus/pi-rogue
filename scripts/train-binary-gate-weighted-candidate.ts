#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data", "routing");
const INPUT = path.join(DIR, "binary-gate.jsonl");
const REPORT = path.join(DIR, "binary-weighted-candidate-report.json");
const LABELS = ["continue", "escalate"] as const;
type Label = typeof LABELS[number];
type Row = { text: string; label: Label; source: string };
type Vec = { I: number[]; V: number[] };
const BINARY: Record<string, Label | undefined> = { planning: "escalate", debugging: "escalate", research: "escalate", review: "escalate", implementation: "continue", ops: "continue", handoff: "continue" };

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CONFLICT_WEIGHT = Number(arg("conflict-weight", "0.25"));

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function normalize(text: string) { return text.toLowerCase().replace(/https?:\/\/\S+/g, " url ").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim(); }
function inc(m: Map<string, number>, key: string, by = 1) { m.set(key, (m.get(key) || 0) + by); }
function counts<T>(rows: T[], key: (row: T) => string) { return rows.reduce<Record<string, number>>((acc, row) => { const k = key(row); acc[k] = (acc[k] || 0) + 1; return acc; }, {}); }
function shuffle<T>(items: T[], seed: number) {
  let state = seed >>> 0;
  const random = () => { state += 0x6D2B79F5; let r = Math.imul(state ^ (state >>> 15), 1 | state); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function features(text: string) {
  const out = new Map<string, number>();
  const toks = normalize(text).split(" ").filter(Boolean);
  for (const n of [1, 2]) if (toks.length >= n) for (let i = 0; i <= toks.length - n; i++) inc(out, `w${n}:${toks.slice(i, i + n).join("_")}`);
  const padded = ` ${toks.join(" ")} `;
  for (const n of [3, 4]) if (padded.length >= n) for (let i = 0; i <= padded.length - n; i++) { const gram = padded.slice(i, i + n); if (!/^\s+$/.test(gram)) inc(out, `c${n}:${gram}`); }
  if (toks[0]) inc(out, `pref1:${toks[0]}`);
  if (toks[1]) inc(out, `pref2:${toks[0]}_${toks[1]}`);
  if (text.includes("?")) inc(out, "cue:question_mark");
  for (const cue of ["check", "why", "what", "how", "should", "status", "review", "diff", "pr", "build", "run", "test", "fix", "debug", "install", "configure", "plan", "continue", "resume", "research", "update", "cleanup"]) if (toks.includes(cue)) inc(out, `cue:${cue}`);
  return out;
}
function vectorize(f: Map<string, number>, index: Map<string, number>, idf: number[]): Vec {
  const pairs: Array<[number, number]> = [];
  let norm = 0;
  for (const [name, tf] of f) {
    const i = index.get(name);
    if (i === undefined) continue;
    const v = (1 + Math.log(tf)) * idf[i];
    pairs.push([i, v]);
    norm += v * v;
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}
function buildSpace(rows: Row[]) {
  const df = new Map<string, number>();
  const docs = rows.map((row) => { const f = features(row.text); for (const name of f.keys()) inc(df, name); return f; });
  const names = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6000).map(([name]) => name);
  const index = new Map(names.map((name, i) => [name, i]));
  const idf = names.map((name) => Math.log((1 + rows.length) / (1 + (df.get(name) || 0))) + 1);
  return { index, idf, vecs: docs.map((doc) => vectorize(doc, index, idf)) };
}
function probs(vec: Vec, weights: number[][], bias: number[]) {
  const scores = bias.slice();
  for (let c = 0; c < 2; c++) for (let i = 0; i < vec.I.length; i++) scores[c] += weights[c][vec.I[i]] * vec.V[i];
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((x) => x / sum);
}
function train(rows: Row[], weightsForRows: number[]) {
  const space = buildSpace(rows);
  const y = rows.map((row) => LABELS.indexOf(row.label));
  let weights = Array.from({ length: 2 }, () => new Array<number>(space.index.size).fill(0));
  let bias = [0, 0];
  const order = [...Array(rows.length).keys()];
  for (let epoch = 1; epoch <= 32; epoch++) for (const i of shuffle(order, 100 + epoch)) {
    const p = probs(space.vecs[i], weights, bias);
    const sampleWeight = weightsForRows[i] ?? 1;
    for (let c = 0; c < 2; c++) {
      const err = (p[c] - (c === y[i] ? 1 : 0)) * sampleWeight;
      bias[c] -= 0.25 * err;
      for (let j = 0; j < space.vecs[i].I.length; j++) weights[c][space.vecs[i].I[j]] = weights[c][space.vecs[i].I[j]] * (1 - 0.25 * 0.0001) - 0.25 * err * space.vecs[i].V[j];
    }
  }
  return { ...space, weights, bias };
}
function evaluate(trainRows: Row[], testRows: Row[], conflictKeys: Set<string>, weighted: boolean) {
  const model = train(trainRows, trainRows.map((row) => weighted && conflictKeys.has(normalize(row.text)) ? CONFLICT_WEIGHT : 1));
  const pred = testRows.map((row) => {
    const p = probs(vectorize(features(row.text), model.index, model.idf), model.weights, model.bias);
    return LABELS[p[0] >= p[1] ? 0 : 1];
  });
  const per = (label: Label) => {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < testRows.length; i++) {
      if (testRows[i].label === label && pred[i] === label) tp++;
      else if (testRows[i].label !== label && pred[i] === label) fp++;
      else if (testRows[i].label === label && pred[i] !== label) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { precision, recall, f1, support: testRows.filter((row) => row.label === label).length };
  };
  const correct = pred.filter((label, i) => label === testRows[i].label).length;
  const cont = per("continue");
  const esc = per("escalate");
  const conflictIdx = testRows.map((row, i) => conflictKeys.has(normalize(row.text)) ? i : -1).filter((i) => i >= 0);
  const conflictCorrect = conflictIdx.filter((i) => pred[i] === testRows[i].label).length;
  return { train: trainRows.length, test: testRows.length, accuracy: correct / testRows.length, macroF1: (cont.f1 + esc.f1) / 2, continue: cont, escalate: esc, conflictRows: conflictIdx.length, conflictAccuracy: conflictIdx.length ? conflictCorrect / conflictIdx.length : null };
}
function split(rows: Row[]) {
  const trainRows: Row[] = [], testRows: Row[] = [];
  let seed = 11;
  for (const label of LABELS) {
    const part = shuffle(rows.filter((row) => row.label === label), seed++);
    const n = Math.max(1, Math.round(part.length * 0.2));
    testRows.push(...part.slice(0, n));
    trainRows.push(...part.slice(n));
  }
  return { trainRows: shuffle(trainRows, 50), testRows: shuffle(testRows, 60) };
}
function conflictKeys() {
  const grouped = new Map<string, Array<{ label: Label; source: string }>>();
  const add = (text: string, label: Label, source: string) => { const key = normalize(text); if (!key) return; const rows = grouped.get(key) || []; rows.push({ label, source }); grouped.set(key, rows); };
  for (const row of readJsonl<any>(path.join(DIR, "gold.jsonl"))) { const label = BINARY[String(row.label)]; if (label && row.text) add(String(row.text), label, "gold"); }
  for (const row of readJsonl<any>(path.join(DIR, "examples.jsonl"))) { const label = BINARY[String(row.label)]; if (label && row.text) add(String(row.text), label, "pi_examples"); }
  const out = new Set<string>();
  for (const [key, rows] of grouped) if (new Set(rows.map((row) => row.label)).size > 1 && new Set(rows.map((row) => row.source)).size > 1) out.add(key);
  return out;
}
function runPolicy(name: string, rows: Row[], conflicts: Set<string>, weighted: boolean) {
  const random = split(rows);
  const sourceHoldouts = Object.keys(counts(rows, (row) => row.source)).sort().map((source) => {
    const testRows = rows.filter((row) => row.source === source);
    const trainRows = rows.filter((row) => row.source !== source);
    return { source, ...evaluate(trainRows, testRows, conflicts, weighted) };
  });
  return {
    name,
    conflictWeight: weighted ? CONFLICT_WEIGHT : 1,
    random: evaluate(random.trainRows, random.testRows, conflicts, weighted),
    goldHoldout: evaluate(rows.filter((row) => row.source !== "gold"), rows.filter((row) => row.source === "gold"), conflicts, weighted),
    sourceHoldouts,
  };
}
function main() {
  const rows = readJsonl<Row>(INPUT);
  const conflicts = conflictKeys();
  const report = {
    input: INPUT,
    rows: rows.length,
    conflictKeys: conflicts.size,
    conflictRowsInBinary: rows.filter((row) => conflicts.has(normalize(row.text))).length,
    sourceCounts: counts(rows, (row) => row.source),
    labelCounts: counts(rows, (row) => row.label),
    policies: [runPolicy("baseline", rows, conflicts, false), runPolicy("weighted-conflicts", rows, conflicts, true)],
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`rows: ${report.rows}`);
  console.log(`conflict keys: ${report.conflictKeys}`);
  console.log(`conflict rows in binary: ${report.conflictRowsInBinary}`);
  for (const p of report.policies) console.log(`${p.name}: random=${(p.random.accuracy * 100).toFixed(1)} gold=${(p.goldHoldout.accuracy * 100).toFixed(1)} goldF1=${p.goldHoldout.macroF1.toFixed(3)} conflictGold=${p.goldHoldout.conflictAccuracy === null ? "n/a" : (p.goldHoldout.conflictAccuracy * 100).toFixed(1)}`);
  console.log(`report: ${REPORT}`);
}
main();
