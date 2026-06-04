#!/usr/bin/env tsx
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractBinaryGateFeatureCounts } from "../packages/advisor/src/binary-gate-features.js";

const DEFAULT_MODEL_PATH = join(homedir(), ".pi", "agent", "fiale-plus", "advisor", "binary-gate-model.json");
const MODEL_PATH = process.env.BINARY_GATE_MODEL_PATH || DEFAULT_MODEL_PATH;

interface ModelArtifact {
  kind: string;
  labels: string[];
  features: string[];
  idf: number[];
  bias: number[];
  weights: number[][];
}

const SAMPLES = [
  "fix typo in readme",
  "refactor the architecture and design the database schema",
  "check stats on the server",
  "review this PR please",
  "continue after compact",
  "what is the current market regime",
  "investigate why the tests are failing",
  "set up ollama with qwen model",
  "plan the next sprint work",
  "implement the user authentication flow",
  "debug the connection timeout error",
  "compare gemma and qwen model performance",
  "update the dependencies and run the build",
  "ssh to the server and check disk space",
  "create a new API endpoint for users",
  "why does the model not support thinking anymore",
  "check if the deployment pipeline is healthy",
  "migrate the database schema",
  "write unit tests for the router module",
  "compact session to save tokens",
];

if (!existsSync(MODEL_PATH)) {
  console.error(`Model not found at ${MODEL_PATH}`);
  process.exit(1);
}

// Cold load timing
const coldStart = performance.now();
const raw = readFileSync(MODEL_PATH, "utf8");
const model = JSON.parse(raw) as ModelArtifact;
const coldLoadMs = performance.now() - coldStart;
const modelSizeKb = (raw.length / 1024).toFixed(0);
console.log(`Model file: ${modelSizeKb}KB, features: ${model.features.length}, labels: ${model.labels.join(", ")}`);

const index = new Map(model.features.map((f, i) => [f, i]));

function features(text: string): Map<string, number> {
  return extractBinaryGateFeatureCounts(text);
}

function vectorize(counts: Map<string, number>) {
  const pairs: Array<[number, number]> = [];
  let nrm = 0;
  for (const [feature, tf] of counts) {
    const idx = index.get(feature);
    if (idx === undefined) continue;
    const value = (1 + Math.log(tf)) * model.idf[idx];
    pairs.push([idx, value]);
    nrm += value * value;
  }
  const scale = nrm > 0 ? 1 / Math.sqrt(nrm) : 1;
  pairs.sort((a, b) => a[0] - b[0]);
  return { I: pairs.map(([i]) => i), V: pairs.map(([, v]) => v * scale) };
}

function predict(text: string) {
  const vec = vectorize(features(text));
  const scores = model.bias.slice();
  for (let c = 0; c < model.weights.length; c++) {
    let score = scores[c];
    const w = model.weights[c];
    for (let i = 0; i < vec.I.length; i++) score += w[vec.I[i]] * vec.V[i];
    scores[c] = score;
  }
  const maxS = Math.max(...scores);
  const exps = scores.map((v) => Math.exp(v - maxS));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const probs = exps.map((v) => v / sum);
  const idx = probs[0] >= probs[1] ? 0 : 1;
  return { decision: model.labels[idx], confidence: probs[idx] };
}

// Warmup (includes model cache + JIT)
for (const s of SAMPLES) predict(s);

// Measure single prediction time (TTFS)
const singleStart = performance.now();
const singleResult = predict("fix typo in readme");
const singleMs = performance.now() - singleStart;

// Measure throughput (batch of N)
const N = SAMPLES.length;
const iterations = 100;
const batchStart = performance.now();
for (let iter = 0; iter < iterations; iter++) {
  for (const s of SAMPLES) predict(s);
}
const batchMs = performance.now() - batchStart;
const totalPredictions = N * iterations;
const avgMs = batchMs / totalPredictions;
const tps = 1000 / avgMs;

console.log(`\n--- Performance ---`);
console.log(`Cold load: ${coldLoadMs.toFixed(1)}ms`);
console.log(`Single prediction (TTFS): ${singleMs.toFixed(3)}ms`);
console.log(`Average per prediction: ${avgMs.toFixed(3)}ms`);
console.log(`Throughput: ${tps.toFixed(0)} predictions/sec`);
console.log(`Batch: ${totalPredictions} predictions in ${batchMs.toFixed(0)}ms`);
console.log(`Sample: ${singleResult.decision} (${(singleResult.confidence * 100).toFixed(1)}%)`);
