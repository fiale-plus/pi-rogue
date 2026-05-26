#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data", "routing");
const REPORT = path.join(DIR, "binary-conflict-review-report.json");
const MARKDOWN = path.join(DIR, "binary-conflict-review.md");
const LABELS = ["continue", "escalate"] as const;
type Binary = typeof LABELS[number];

type SourceRow = {
  text: string;
  label: string;
  binary: Binary;
  source: "gold" | "pi_examples";
  confidence?: number;
  confidenceSource?: string;
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  messageId?: string;
  cwd?: string;
};
type EvalRow = { text: string; label: Binary; source: string };
type Vec = { I: number[]; V: number[] };

const BINARY: Record<string, Binary | undefined> = {
  planning: "escalate",
  debugging: "escalate",
  research: "escalate",
  review: "escalate",
  implementation: "continue",
  ops: "continue",
  handoff: "continue",
};

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function normalize(text: string) {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, " url ").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function inc(m: Map<string, number>, key: string, by = 1) { m.set(key, (m.get(key) || 0) + by); }
function counts<T>(rows: T[], key: (row: T) => string) { return rows.reduce<Record<string, number>>((acc, row) => { const k = key(row); acc[k] = (acc[k] || 0) + 1; return acc; }, {}); }
function truncate(text: string, n = 140) { const clean = text.replace(/\s+/g, " ").trim(); return clean.length <= n ? clean : `${clean.slice(0, n - 1)}…`; }
function escMd(text: string) { return text.replace(/\|/g, "\\|").replace(/\n/g, " "); }

function sourceRows(): SourceRow[] {
  const out: SourceRow[] = [];
  for (const row of readJsonl<any>(path.join(DIR, "gold.jsonl"))) {
    const binary = BINARY[String(row.label)];
    if (!binary || !row.text) continue;
    out.push({ text: String(row.text), label: String(row.label), binary, source: "gold", confidence: row.modelConfidence, confidenceSource: row.labeler, reason: row.modelReason || row.heuristicReason, sessionFile: row.sessionFile, sessionId: row.sessionId, messageId: row.messageId, cwd: row.cwd });
  }
  for (const row of readJsonl<any>(path.join(DIR, "examples.jsonl"))) {
    const binary = BINARY[String(row.label)];
    if (!binary || !row.text) continue;
    out.push({ text: String(row.text), label: String(row.label), binary, source: "pi_examples", confidence: row.confidence, confidenceSource: row.confidenceSource, reason: row.reason, sessionFile: row.sessionFile, sessionId: row.sessionId, messageId: row.messageId, cwd: row.cwd });
  }
  return out;
}
function conflictGroups(rows: SourceRow[]) {
  const grouped = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const key = normalize(row.text);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return [...grouped.entries()].map(([key, items]) => ({ key, items })).filter((group) => {
    const sources = new Set(group.items.map((row) => row.source));
    const labels = new Set(group.items.map((row) => row.binary));
    return sources.has("gold") && sources.has("pi_examples") && labels.size > 1;
  });
}

function features(text: string) {
  const out = new Map<string, number>();
  const toks = normalize(text).split(" ").filter(Boolean);
  for (const n of [1, 2]) if (toks.length >= n) for (let i = 0; i <= toks.length - n; i++) inc(out, `w${n}:${toks.slice(i, i + n).join("_")}`);
  if (toks[0]) inc(out, `pref1:${toks[0]}`);
  if (toks[1]) inc(out, `pref2:${toks[0]}_${toks[1]}`);
  if (text.includes("?")) inc(out, "cue:question_mark");
  for (const cue of ["check", "why", "what", "how", "should", "status", "review", "diff", "pr", "build", "run", "test", "fix", "debug", "install", "configure", "plan", "continue", "research", "update"]) if (toks.includes(cue)) inc(out, `cue:${cue}`);
  return out;
}
function vectorize(f: Map<string, number>, index: Map<string, number>, idf: number[]): Vec {
  const pairs: Array<[number, number]> = [];
  let norm = 0;
  for (const [name, tf] of f) {
    const i = index.get(name);
    if (i === undefined) continue;
    const value = (1 + Math.log(tf)) * idf[i];
    pairs.push([i, value]);
    norm += value * value;
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, value]) => value * scale) };
}
function buildSpace(rows: EvalRow[]) {
  const df = new Map<string, number>();
  const docs = rows.map((row) => { const f = features(row.text); for (const name of f.keys()) inc(df, name); return f; });
  const names = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6000).map(([name]) => name);
  const index = new Map(names.map((name, i) => [name, i]));
  const idf = names.map((name) => Math.log((1 + rows.length) / (1 + (df.get(name) || 0))) + 1);
  return { index, idf, vecs: docs.map((doc) => vectorize(doc, index, idf)) };
}
function shuffle<T>(items: T[], seed: number) {
  let state = seed >>> 0;
  const random = () => { state += 0x6D2B79F5; let r = Math.imul(state ^ (state >>> 15), 1 | state); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function probs(vec: Vec, weights: number[][], bias: number[]) {
  const scores = bias.slice();
  for (let c = 0; c < 2; c++) for (let i = 0; i < vec.I.length; i++) scores[c] += weights[c][vec.I[i]] * vec.V[i];
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((value) => value / sum);
}
function train(rows: EvalRow[]) {
  const space = buildSpace(rows);
  const y = rows.map((row) => LABELS.indexOf(row.label));
  const weights = Array.from({ length: 2 }, () => new Array<number>(space.index.size).fill(0));
  const bias = [0, 0];
  const order = [...Array(rows.length).keys()];
  for (let epoch = 1; epoch <= 24; epoch++) for (const idx of shuffle(order, 500 + epoch)) {
    const p = probs(space.vecs[idx], weights, bias);
    for (let c = 0; c < 2; c++) {
      const err = p[c] - (c === y[idx] ? 1 : 0);
      bias[c] -= 0.25 * err;
      for (let j = 0; j < space.vecs[idx].I.length; j++) weights[c][space.vecs[idx].I[j]] = weights[c][space.vecs[idx].I[j]] * (1 - 0.25 * 0.0001) - 0.25 * err * space.vecs[idx].V[j];
    }
  }
  return { ...space, weights, bias };
}
function evalPredictions(trainRows: EvalRow[], testRows: EvalRow[], conflictByText: Map<string, Binary>) {
  const model = train(trainRows);
  const rows = testRows.map((row) => {
    const p = probs(vectorize(features(row.text), model.index, model.idf), model.weights, model.bias);
    const baseline = LABELS[p[0] >= p[1] ? 0 : 1];
    const sourcePriority = conflictByText.get(normalize(row.text)) || baseline;
    return { row, baseline, sourcePriority, confidence: Math.max(...p), isConflict: conflictByText.has(normalize(row.text)) };
  });
  const summarize = (field: "baseline" | "sourcePriority") => {
    const correct = rows.filter((r) => r[field] === r.row.label).length;
    const conflict = rows.filter((r) => r.isConflict);
    return {
      accuracy: correct / rows.length,
      correct,
      total: rows.length,
      conflictRows: conflict.length,
      conflictAccuracy: conflict.length ? conflict.filter((r) => r[field] === r.row.label).length / conflict.length : null,
    };
  };
  return { baseline: summarize("baseline"), sourcePriority: summarize("sourcePriority"), predictions: rows };
}

function main() {
  const groups = conflictGroups(sourceRows());
  const conflictByText = new Map(groups.map((group) => [group.key, group.items.find((row) => row.source === "gold")!.binary]));
  const binaryRows = readJsonl<any>(path.join(DIR, "binary-gate.jsonl")).map((row) => ({ text: String(row.text), label: row.label as Binary, source: String(row.source) }));
  const gold = binaryRows.filter((row) => row.source === "gold");
  const nonGold = binaryRows.filter((row) => row.source !== "gold");
  const evaluation = evalPredictions(nonGold, gold, conflictByText);
  const conflicts = groups.map((group) => {
    const goldRow = group.items.find((row) => row.source === "gold")!;
    const heuristic = group.items.find((row) => row.source === "pi_examples")!;
    const pred = evaluation.predictions.find((item) => normalize(item.row.text) === group.key);
    return {
      id: hash(group.key),
      text: goldRow.text,
      recommendedBinary: goldRow.binary,
      recommendedSource: "gold_priority_review",
      gold: goldRow,
      heuristic,
      baselinePrediction: pred?.baseline,
      baselineConfidence: pred?.confidence,
      sourcePriorityPrediction: pred?.sourcePriority,
      baselineCorrect: pred ? pred.baseline === goldRow.binary : null,
      sourcePriorityCorrect: pred ? pred.sourcePriority === goldRow.binary : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const report = {
    input: path.join(DIR, "binary-gate.jsonl"),
    rows: binaryRows.length,
    conflictCount: conflicts.length,
    conflictLabelPairs: counts(conflicts, (c) => `${c.gold.label}->${c.heuristic.label}`),
    sourceCounts: counts(binaryRows, (row) => row.source),
    goldHoldout: { baseline: evaluation.baseline, sourcePriorityReview: evaluation.sourcePriority },
    conflicts,
    implication: "Eval-only source-priority overlay tests the upper bound of resolving exact conflicts to curated gold labels. It does not mutate gold data or train/runtime assets.",
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");
  const md = [
    "# Binary gate conflict review",
    "",
    `- Binary rows: ${binaryRows.length}`,
    `- Exact gold-vs-heuristic conflicts: ${conflicts.length}`,
    `- Baseline gold holdout: ${(evaluation.baseline.accuracy * 100).toFixed(1)}%`,
    `- Source-priority review overlay: ${(evaluation.sourcePriority.accuracy * 100).toFixed(1)}%`,
    `- Baseline conflict accuracy: ${evaluation.baseline.conflictAccuracy == null ? "n/a" : `${(evaluation.baseline.conflictAccuracy * 100).toFixed(1)}%`}`,
    `- Source-priority conflict accuracy: ${evaluation.sourcePriority.conflictAccuracy == null ? "n/a" : `${(evaluation.sourcePriority.conflictAccuracy * 100).toFixed(1)}%`}`,
    "",
    "| ID | Gold | Heuristic | Baseline | Text |",
    "|---|---|---|---|---|",
    ...conflicts.slice(0, 80).map((c) => `| ${c.id} | ${c.gold.binary}/${c.gold.label} | ${c.heuristic.binary}/${c.heuristic.label} | ${c.baselinePrediction || "n/a"} | ${escMd(truncate(c.text))} |`),
    "",
  ].join("\n");
  fs.writeFileSync(MARKDOWN, md, "utf8");
  console.log(`rows: ${binaryRows.length}`);
  console.log(`conflicts: ${conflicts.length}`);
  console.log(`baseline gold holdout: ${(evaluation.baseline.accuracy * 100).toFixed(1)}%`);
  console.log(`source-priority overlay: ${(evaluation.sourcePriority.accuracy * 100).toFixed(1)}%`);
  console.log(`baseline conflict accuracy: ${evaluation.baseline.conflictAccuracy == null ? "n/a" : (evaluation.baseline.conflictAccuracy * 100).toFixed(1) + "%"}`);
  console.log(`source-priority conflict accuracy: ${evaluation.sourcePriority.conflictAccuracy == null ? "n/a" : (evaluation.sourcePriority.conflictAccuracy * 100).toFixed(1) + "%"}`);
  console.log(`report: ${REPORT}`);
  console.log(`markdown: ${MARKDOWN}`);
}

main();
