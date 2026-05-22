#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { LABELS, type Label } from "./routing-heuristics.js";

const DEFAULT_MODEL = path.join(process.cwd(), "data", "routing", "routing-model.json");
const DEFAULT_INPUT = path.join(process.cwd(), "data", "routing", "unlabeled.jsonl");
const DEFAULT_OUTPUT = path.join(process.cwd(), "data", "routing", "active-learning-queue.jsonl");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "routing", "active-learning-report.json");

interface ModelArtifact {
  kind: string;
  labels: string[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
  config?: Record<string, unknown>;
  provenance?: string;
}

interface Row {
  id?: string;
  text: string;
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
  turnIndex?: number;
  messageId?: string;
  createdAt?: string;
}

interface ScoredRow extends Row {
  predictedLabel: string;
  confidence: number;
  margin: number;
  entropy: number;
  needsReview: boolean;
  top: Array<[string, number]>;
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
    model: String(args.model || DEFAULT_MODEL),
    input: String(args.input || DEFAULT_INPUT),
    output: String(args.output || DEFAULT_OUTPUT),
    report: String(args.report || DEFAULT_REPORT),
    limit: Math.max(0, Number(args.limit || 200) || 200),
    reviewThreshold: Math.max(0, Math.min(1, Number(args["review-threshold"] || 0.6) || 0.6)),
    marginThreshold: Math.max(0, Math.min(1, Number(args["margin-threshold"] || 0.15) || 0.15)),
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
  return String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  const norm = normalize(text);
  return norm ? norm.split(" ").filter(Boolean) : [];
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) || 0) + by);
}

function extractFeatureCounts(text: string, wordNgrams: number[], charNgrams: number[]): Map<string, number> {
  const counts = new Map<string, number>();
  const toks = tokens(text);
  const lower = normalize(text);
  for (const n of wordNgrams) {
    if (n <= 0 || toks.length < n) continue;
    for (let i = 0; i <= toks.length - n; i++) {
      inc(counts, `w${n}:${toks.slice(i, i + n).join("_")}`);
    }
  }
  const norm = ` ${lower} `;
  for (const n of charNgrams) {
    if (n <= 0 || norm.length < n) continue;
    for (let i = 0; i <= norm.length - n; i++) {
      const gram = norm.slice(i, i + n);
      if (/^\s+$/.test(gram)) continue;
      inc(counts, `c${n}:${gram}`);
    }
  }

  if (toks.length > 0) inc(counts, `pref1:${toks[0]}`);
  if (toks.length > 1) inc(counts, `pref2:${toks.slice(0, 2).join('_')}`);
  if (toks.length > 2) inc(counts, `pref3:${toks.slice(0, 3).join('_')}`);
  if (text.includes("?")) inc(counts, "cue:question_mark");

  const singleCues = ["check", "why", "what", "how", "should", "status", "stats", "log", "logs", "review", "diff", "pr", "build", "run", "test", "deploy", "fix", "debug", "install", "configure", "plan", "continue", "resume", "compact", "research", "update", "patch", "cleanup", "remove"];
  const multiCues = ["what is", "what's", "safe to use", "pull request", "model family", "how does", "next step", "path forward", "should we", "what should"];
  const tokenSet = new Set(toks);
  for (const cue of singleCues) if (tokenSet.has(cue)) inc(counts, `cue:${cue}`);
  for (const cue of multiCues) if (lower.includes(cue)) inc(counts, `cue:${cue.replace(/\s+/g, '_')}`);
  return counts;
}

function toVector(counts: Map<string, number>, index: Map<string, number>, idf: number[]) {
  const indices: number[] = [];
  const values: number[] = [];
  let norm = 0;
  for (const [feature, tf] of counts.entries()) {
    const idx = index.get(feature);
    if (idx === undefined) continue;
    const value = (1 + Math.log(tf)) * idf[idx];
    indices.push(idx);
    values.push(value);
    norm += value * value;
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  for (let i = 0; i < values.length; i++) values[i] *= scale;
  return { indices, values };
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / sum);
}

function predict(vec: { indices: number[]; values: number[] }, model: ModelArtifact) {
  const scores = model.bias.slice();
  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c];
    const w = model.weights[c];
    for (let i = 0; i < vec.indices.length; i++) {
      score += w[vec.indices[i]] * vec.values[i];
    }
    scores[c] = score;
  }
  const probs = softmax(scores);
  const ranked = probs.map((p, i) => [model.labels[i], p] as [string, number]).sort((a, b) => b[1] - a[1]);
  return {
    predictedLabel: ranked[0]?.[0] || model.labels[0] || LABELS[0],
    confidence: ranked[0]?.[1] || 0,
    margin: (ranked[0]?.[1] || 0) - (ranked[1]?.[1] || 0),
    entropy: -probs.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0),
    top: ranked.slice(0, 3),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = JSON.parse(fs.readFileSync(args.model, "utf8")) as ModelArtifact;
  if (model.kind !== "routing-logreg-v1") throw new Error(`Unexpected model kind: ${model.kind}`);
  const rows = readJsonl<Row>(args.input).filter((row) => typeof row.text === "string" && row.text.trim().length > 0);
  const index = new Map(model.features.map((feature, i) => [feature, i]));
  const wordNgrams = Array.isArray(model.config?.wordNgrams) ? (model.config!.wordNgrams as number[]) : [1, 2];
  const charNgrams = Array.isArray(model.config?.charNgrams) ? (model.config!.charNgrams as number[]) : [3, 4];

  const scored: ScoredRow[] = rows.map((row) => {
    const vec = toVector(extractFeatureCounts(row.text, wordNgrams, charNgrams), index, model.idf);
    const pred = predict(vec, model);
    return {
      ...row,
      predictedLabel: pred.predictedLabel,
      confidence: pred.confidence,
      margin: pred.margin,
      entropy: pred.entropy,
      needsReview: pred.confidence < args.reviewThreshold || pred.margin < args.marginThreshold,
      top: pred.top,
    };
  });

  scored.sort((a, b) => a.confidence - b.confidence || a.margin - b.margin || b.entropy - a.entropy);
  const queue = scored.slice(0, args.limit);
  const counts = queue.reduce<Record<string, number>>((acc, row) => {
    acc[row.predictedLabel] = (acc[row.predictedLabel] || 0) + 1;
    return acc;
  }, {});
  const reviewCount = queue.filter((row) => row.needsReview).length;
  const top = queue.slice(0, 25).map((row) => ({ id: row.id, predictedLabel: row.predictedLabel, confidence: row.confidence, margin: row.margin, entropy: row.entropy, needsReview: row.needsReview, text: row.text.slice(0, 220) }));

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, queue.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  fs.writeFileSync(args.report, `${JSON.stringify({ model: args.model, input: args.input, rows: rows.length, queued: queue.length, reviewCount, counts, top, thresholds: { reviewThreshold: args.reviewThreshold, marginThreshold: args.marginThreshold } }, null, 2)}\n`, "utf8");

  console.log(`rows: ${rows.length}`);
  console.log(`queued: ${queue.length}`);
  console.log(`needs review: ${reviewCount}`);
  console.log(`predicted counts: ${JSON.stringify(counts)}`);
  console.log(`queue: ${args.output}`);
  console.log(`report: ${args.report}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
