#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data", "routing");
const LABELS = ["continue", "escalate"] as const;
type Label = typeof LABELS[number];
type Row = { text: string; label: Label; source: string; id?: string };
type ResolvedConflict = Row & {
  id: string;
  pair: string;
  currentGoldLabel: string;
  currentGoldBinary: Label;
  heuristicLabel: string;
  heuristicBinary: Label;
  policyRule: string;
  action: "accept_gold" | "relabel_by_policy" | "manual_review_keep_current_gold_for_now";
};

type Args = { reviewed: string[] };

function parseArgs(argv: string[]): Args {
  const reviewed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--reviewed") continue;
    const value = argv[++i];
    if (!value) throw new Error("--reviewed requires a JSONL file path or comma-separated paths");
    reviewed.push(...value.split(",").map((file) => file.trim()).filter(Boolean));
  }
  return { reviewed };
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as T);
}
function normalize(text: string) {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, " url ").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}
function shuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => { state += 0x6D2B79F5; let r = Math.imul(state ^ (state >>> 15), 1 | state); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function countBy<T>(rows: T[], key: (row: T) => string) {
  return rows.reduce<Record<string, number>>((acc, row) => { const k = key(row); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function readReviewedRows(files: string[]): Row[] {
  return files.flatMap((file) => readJsonl<any>(file).map((row, index) => {
    const label = row.label as Label;
    if (!LABELS.includes(label)) throw new Error(`Invalid reviewed label in ${file}:${index + 1}: ${String(row.label)}`);
    const text = String(row.text || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`Missing reviewed text in ${file}:${index + 1}`);
    return { id: row.id ? String(row.id) : `${path.basename(file)}:${index + 1}`, text, label, source: row.source ? String(row.source) : "q1_q10_reviewed" };
  }));
}

function q1q10Policy(text: string): { label?: Label; rule: string } {
  const t = text.toLowerCase();
  const highRisk = /\b(portfolio|trading|money|security|auth|secret|production|prod|migration|delete|destructive|deploy)\b/.test(t);
  const readOnly = /\b(check|inspect|report|summarize|list|show|read|explain|what is|status)\b/.test(t);
  const irreversible = /\b(move money|trade|buy|sell|deploy|migrate|delete|remove secrets?|rotate secret|change auth|production|prod|drop table|wipe|destroy)\b/.test(t);
  const clearSteps = /\b(task:|step|checklist|run|execute|update|write|generate|create|fix|build)\b/.test(t);
  if (highRisk && (irreversible || !clearSteps) && !readOnly) return { label: "escalate", rule: "q10_high_risk_impact_or_unclear" };
  if (highRisk && (readOnly || clearSteps)) return { label: "continue", rule: "q10_high_risk_clear_or_readonly" };

  const judgment = /\b(review|assess|verdict|should we|should i|which should|which model|which card|path forward|architecture|strategy|advisor|is this good|compare options|decide)\b/.test(t);
  const concrete = /\b(update|fix|fill|produce|write|patch|edit|cleanup|remove|docs?|readme|file|pr desc|log)\b/.test(t);
  if (/\b(error|failed|failure|stack trace|traceback|parse error|crash|deployment failed|logs?)\b/.test(t) && /\b(repeated|again|keeps|why|path forward|should we|strategy|production|prod)\b/.test(t)) return { label: "escalate", rule: "q8_repeated_or_unclear_failure" };
  if (/\b(error|failed|failure|stack trace|traceback|parse error|crash|deployment failed|logs?)\b/.test(t) && /\b(fix|debug|resolve|look|check|what is wrong|whats wrong)\b/.test(t)) return { label: "continue", rule: "q8_concrete_error_debug" };
  if (/\bcheck\b/.test(t) && /\b(machine|ssh|status|logs?|config|env|environment|models?|install|version|works fine|working fine)\b/.test(t) && !/\b(architecture|strategy|path forward|redesign|which should|which model|which card)\b/.test(t)) return { label: "continue", rule: "q7_concrete_machine_status" };
  if (/\bcheck\b/.test(t) && concrete && !judgment) return { label: "continue", rule: "q1_check_concrete" };
  if (/\b(run|execute)\b[\s\S]{0,160}\bautoresearch\b[\s\S]{0,120}\bcycles?\b/.test(t)) return { label: "continue", rule: "q2_fixed_autoresearch" };
  if (/\b(grok|paperclip|summary|recommendation|agent response|claude response)\b/.test(t) && /\b(apply|update|adjust|patch|write|edit)\b/.test(t) && !judgment) return { label: "continue", rule: "q3_apply_summary" };
  if (/\b(grok|paperclip|summary|recommendation|agent response|claude response)\b/.test(t) && judgment) return { label: "escalate", rule: "q3_judge_summary" };
  if (/\b(continue|resume)\b/.test(t) && /\b(best model|which model|strategy|path|research direction|experiment|decide)\b/.test(t)) return { label: "escalate", rule: "q4_open_research_continue" };
  if (/\b(continue|resume)\b/.test(t) && /\b(fix|setup|run|test|patch|edit|implement)\b/.test(t)) return { label: "continue", rule: "q4_concrete_continue" };
  if (/\b(qwen|gemma|mlx|ollama|lmstudio|local-router|router|model|card|gpu|quantized|quantization)\b/.test(t) && judgment) return { label: "escalate", rule: "q5_model_strategy" };
  if (/\b(qwen|gemma|mlx|ollama|lmstudio|local-router|router|model|card|gpu|quantized|quantization)\b/.test(t) && /\b(what does|what is|is it|installed|status|list)\b/.test(t)) return { label: "continue", rule: "q5_model_factual" };
  if (/\b(better options|what to build|which option|best option|best model|best tool|figure out|decide)\b/.test(t) && /\b(try|create|build|experiment|autoresearch|model|tool|router)\b/.test(t)) return { label: "escalate", rule: "q6_open_mixed_research_impl" };
  if (/\b(try|create|build|fork|make|implement)\b/.test(t) && /\b(specific|this|here|worktree|repo|file|script|tool|router|experiment)\b/.test(t) && !/\b(better options|which option|best option|figure out|decide|strategy)\b/.test(t)) return { label: "continue", rule: "q6_specific_mixed_research_impl" };
  return { rule: "needs_manual_review" };
}

function resolveConflicts(): ResolvedConflict[] {
  const report = JSON.parse(fs.readFileSync(path.join(DIR, "binary-conflict-review-report.json"), "utf8"));
  return report.conflicts.map((c: any) => {
    const policy = q1q10Policy(c.text);
    const label = policy.label || c.gold.binary;
    const action = !policy.label ? "manual_review_keep_current_gold_for_now" : policy.label === c.gold.binary ? "accept_gold" : "relabel_by_policy";
    return {
      id: c.id,
      text: String(c.text).replace(/\s+/g, " "),
      label,
      source: "q1_q10_resolved_conflict",
      pair: `${c.gold.label}->${c.heuristic.label}`,
      currentGoldLabel: c.gold.label,
      currentGoldBinary: c.gold.binary,
      heuristicLabel: c.heuristic.label,
      heuristicBinary: c.heuristic.binary,
      policyRule: policy.rule,
      action,
    } satisfies ResolvedConflict;
  });
}
function folds<T>(rows: T[], k: number, seed: number) {
  const shuffled = shuffle(rows, seed);
  return Array.from({ length: k }, (_, i) => shuffled.filter((_, j) => j % k === i));
}
function features(text: string) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const f = new Map<string, number>();
  const inc = (k: string) => f.set(k, (f.get(k) || 0) + 1);
  for (const n of [1, 2]) if (tokens.length >= n) for (let i = 0; i <= tokens.length - n; i++) inc(`w${n}:${tokens.slice(i, i + n).join("_")}`);
  for (const cue of ["check", "why", "what", "how", "should", "status", "review", "pr", "build", "run", "test", "fix", "debug", "install", "configure", "plan", "continue", "research", "update", "cleanup", "autoresearch", "model", "advisor", "logs", "docs", "task", "error", "deploy", "portfolio"]) if (tokens.includes(cue)) inc(`cue:${cue}`);
  return f;
}
function train(rows: Row[]) {
  const df = new Map<string, number>();
  const docs = rows.map((r) => { const f = features(r.text); for (const k of f.keys()) df.set(k, (df.get(k) || 0) + 1); return f; });
  const names = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6000).map(([k]) => k);
  const index = new Map(names.map((n, i) => [n, i]));
  const idf = names.map((n) => Math.log((1 + rows.length) / (1 + (df.get(n) || 0))) + 1);
  const vec = (f: Map<string, number>) => {
    const pairs: Array<[number, number]> = []; let norm = 0;
    for (const [k, tf] of f) { const i = index.get(k); if (i === undefined) continue; const v = (1 + Math.log(tf)) * idf[i]; pairs.push([i, v]); norm += v * v; }
    const scale = norm ? 1 / Math.sqrt(norm) : 1;
    return pairs.map(([i, v]) => [i, v * scale] as [number, number]);
  };
  const x = docs.map(vec); const y = rows.map((r) => LABELS.indexOf(r.label));
  const weights = [Array(names.length).fill(0), Array(names.length).fill(0)]; const bias = [0, 0]; const order = [...Array(rows.length).keys()];
  for (let epoch = 1; epoch <= 25; epoch++) for (const rowIdx of shuffle(order, 500 + epoch)) {
    const scores = bias.slice(); for (let c = 0; c < 2; c++) for (const [i, v] of x[rowIdx]) scores[c] += weights[c][i] * v;
    const max = Math.max(...scores); const exp = scores.map((s) => Math.exp(s - max)); const sum = exp[0] + exp[1]; const probs = exp.map((e) => e / sum);
    for (let c = 0; c < 2; c++) { const err = probs[c] - (c === y[rowIdx] ? 1 : 0); bias[c] -= 0.22 * err; for (const [i, v] of x[rowIdx]) weights[c][i] = weights[c][i] * (1 - 0.22 * 0.0001) - 0.22 * err * v; }
  }
  return { vec, weights, bias };
}
function evaluate(model: ReturnType<typeof train>, rows: Row[]) {
  let correct = 0;
  for (const row of rows) {
    const x = model.vec(features(row.text)); const scores = model.bias.slice(); for (let c = 0; c < 2; c++) for (const [i, v] of x) scores[c] += model.weights[c][i] * v;
    const pred = LABELS[scores[0] >= scores[1] ? 0 : 1]; if (pred === row.label) correct++;
  }
  return { accuracy: correct / rows.length, correct, total: rows.length };
}

const args = parseArgs(process.argv.slice(2));
const binary = readJsonl<any>(path.join(DIR, "binary-gate.jsonl")).map((r) => ({ text: String(r.text), label: r.label as Label, source: String(r.source) }));
const resolved = resolveConflicts();
const reviewedRows = readReviewedRows(args.reviewed);
const conflictKeys = new Set(resolved.map((r) => normalize(r.text)));
const nonGold = binary.filter((r) => r.source !== "gold");
const goldNonConflict = binary.filter((r) => r.source === "gold" && !conflictKeys.has(normalize(r.text))).map((r) => ({ ...r, source: "gold_non_conflict" }));
const conflictFolds = folds(resolved, 5, 1001);
const goldFolds = folds(goldNonConflict, 5, 1002);
const sessionTest = shuffle(nonGold, 1003).slice(0, 400);
const policies = [
  { name: "non_gold_only", gold: false, conflict: false, reviewed: false },
  { name: "gold_non_conflict_only", gold: true, conflict: false, reviewed: false },
  { name: "q1_q10_conflict_only", gold: false, conflict: true, reviewed: false },
  { name: "gold_plus_q1_q10_conflict", gold: true, conflict: true, reviewed: false },
  ...(reviewedRows.length ? [{ name: "gold_plus_q1_q10_conflict_plus_reviewed", gold: true, conflict: true, reviewed: true }] : []),
];
const results = policies.map((policy) => {
  const folds = conflictFolds.map((conflictTest, i) => {
    const trainRows = [
      ...nonGold,
      ...(policy.gold ? goldFolds.flatMap((f, j) => j === i ? [] : f) : []),
      ...(policy.conflict ? conflictFolds.flatMap((f, j) => j === i ? [] : f) : []),
      ...(policy.reviewed ? reviewedRows : []),
    ];
    const model = train(trainRows);
    return { trainRows: trainRows.length, conflict: evaluate(model, conflictTest), gold: evaluate(model, goldFolds[i]), session: evaluate(model, sessionTest) };
  });
  const avg = (key: "conflict" | "gold" | "session") => folds.reduce((s, f) => s + f[key].accuracy, 0) / folds.length;
  return { policy: policy.name, avgTrainRows: Math.round(folds.reduce((s, f) => s + f.trainRows, 0) / folds.length), conflictAccuracy: avg("conflict"), goldAccuracy: avg("gold"), sessionAccuracy: avg("session"), folds };
});
const outputRows = resolved.map((r) => ({ id: r.id, text: r.text, label: r.label, source: r.source, sourceLabel: r.currentGoldLabel, pair: r.pair, policyRule: r.policyRule, action: r.action }));
const report = { rows: { nonGold: nonGold.length, goldNonConflict: goldNonConflict.length, conflicts: resolved.length, reviewed: reviewedRows.length }, reviewed: { sourceCounts: countBy(reviewedRows, (r) => r.source), labelCounts: countBy(reviewedRows, (r) => r.label) }, resolution: { actionCounts: countBy(resolved, (r) => r.action), ruleCounts: countBy(resolved, (r) => r.policyRule), resolvedCounts: countBy(resolved, (r) => r.label) }, results };
fs.writeFileSync(path.join(DIR, "binary-q1-q10-resolved-conflicts.jsonl"), outputRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(DIR, "binary-q1-q10-augmentation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
const md = [
  "# Binary Q1-Q10 augmentation report", "", "The Q1-Q10 rules are used as label-generation provenance only; the evaluated candidate trains the binary model on resolved labels rather than using a runtime policy overlay.", "",
  `- conflicts: ${resolved.length}`,
  `- reviewed augmentation rows: ${reviewedRows.length}`,
  `- relabel by policy: ${report.resolution.actionCounts.relabel_by_policy || 0}`,
  `- no-rule kept as current gold: ${report.resolution.actionCounts.manual_review_keep_current_gold_for_now || 0}`,
  "", "| Policy | Avg train rows | Conflict CV acc | Gold non-conflict CV acc | Session sample acc |", "|---|---:|---:|---:|---:|",
  ...results.map((r) => `| ${r.policy} | ${r.avgTrainRows} | ${(r.conflictAccuracy * 100).toFixed(1)}% | ${(r.goldAccuracy * 100).toFixed(1)}% | ${(r.sessionAccuracy * 100).toFixed(1)}% |`),
  "", "## Recommendation", "", "Do not ship a runtime policy overlay. If this path is promoted later, use the resolved Q1-Q10 rows as training/eval data so the model internalizes as much of the policy as possible.", "",
].join("\n");
fs.writeFileSync(path.join(DIR, "binary-q1-q10-augmentation-report.md"), md, "utf8");
console.log(md);
