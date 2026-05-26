#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_OUTPUT = path.join(DIR, "q1-q10-conflict-like-review-queue.jsonl");
const DEFAULT_MARKDOWN = path.join(DIR, "q1-q10-conflict-like-review-queue.md");
const DEFAULT_REPORT = path.join(DIR, "q1-q10-conflict-like-review-queue-report.json");

type BinaryLabel = "continue" | "escalate";
type QueueRow = {
  id: string;
  text: string;
  label: BinaryLabel;
  rule: string;
  ambiguity: number;
  source: string;
  sessionFile?: string;
  sessionId?: string;
  messageId?: string;
  cwd?: string;
  turnIndex?: number;
};

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i++; }
    else args[key] = true;
  }
  return {
    output: String(args.output || DEFAULT_OUTPUT),
    markdown: String(args.markdown || DEFAULT_MARKDOWN),
    report: String(args.report || DEFAULT_REPORT),
    perRule: Number(args["per-rule"] || 8) || 8,
  };
}
function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function policy(text: string): { label?: BinaryLabel; rule?: string } {
  const t = text.toLowerCase();
  const high = /\b(portfolio|trading|money|security|auth|secret|production|prod|migration|delete|destructive|deploy)\b/.test(t);
  const readOnly = /\b(check|inspect|report|summarize|list|show|read|explain|what is|status)\b/.test(t);
  const irreversible = /\b(move money|trade|buy|sell|deploy|migrate|delete|remove secrets?|rotate secret|change auth|production|prod|drop table|wipe|destroy)\b/.test(t);
  const clearSteps = /\b(task:|step|checklist|run|execute|update|write|generate|create|fix|build)\b/.test(t);
  if (high && (irreversible || !clearSteps) && !readOnly) return { label: "escalate", rule: "q10_high_risk_impact_or_unclear" };
  if (high && (readOnly || clearSteps)) return { label: "continue", rule: "q10_high_risk_clear_or_readonly" };

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
  return {};
}
function ambiguity(text: string) {
  return [
    /\bcheck\b/i,
    /\breview\b/i,
    /\bresearch|autoresearch\b/i,
    /\bcontinue|resume\b/i,
    /\bmodel|router|qwen|gemma|mlx\b/i,
    /\berror|failed|logs?\b/i,
    /\btask:\b/i,
    /\bshould|which|best|strategy\b/i,
  ].filter((re) => re.test(text)).length;
}
function countBy<T>(rows: T[], key: (row: T) => string) {
  return rows.reduce<Record<string, number>>((acc, row) => { const k = key(row); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = [
    ...readJsonl<any>(path.join(DIR, "unlabeled.jsonl")).map((row) => ({ ...row, source: "unlabeled" })),
    ...readJsonl<any>(path.join(DIR, "examples.jsonl")).map((row) => ({ ...row, source: "weak_example" })),
  ];
  const candidates = sources.map((row) => {
    const text = normalizeText(row.text || row.input || row.prompt);
    const pred = policy(text);
    if (!text || !pred.label || !pred.rule) return null;
    const amb = ambiguity(text);
    if (amb < 2) return null;
    return { text, label: pred.label, rule: pred.rule, ambiguity: amb, source: row.source, sessionFile: row.sessionFile, sessionId: row.sessionId, messageId: row.messageId, cwd: row.cwd, turnIndex: row.turnIndex };
  }).filter((row): row is Omit<QueueRow, "id"> => Boolean(row));
  const seen = new Set<string>();
  const deduped = candidates
    .sort((a, b) => b.ambiguity - a.ambiguity || a.rule.localeCompare(b.rule) || a.text.localeCompare(b.text))
    .filter((row) => { const key = row.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  const queue: QueueRow[] = [];
  let nextId = 1;
  for (const rule of Object.keys(countBy(deduped, (row) => row.rule)).sort()) {
    for (const row of deduped.filter((candidate) => candidate.rule === rule).slice(0, args.perRule)) {
      queue.push({ id: `q1q10-${String(nextId++).padStart(3, "0")}`, ...row });
    }
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, queue.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  fs.writeFileSync(args.report, JSON.stringify({ candidates: deduped.length, queue: queue.length, perRule: args.perRule, ruleCounts: countBy(deduped, (row) => row.rule), labelCounts: countBy(queue, (row) => row.label), sourceCounts: countBy(queue, (row) => row.source) }, null, 2) + "\n", "utf8");
  const md = [
    "# Q1-Q10 conflict-like review queue",
    "",
    "Purpose: add reviewed conflict-like examples so the model can internalize Q1-Q10 policy instead of relying on runtime overlay.",
    "",
    `- Q1-Q10 conflict-like candidates: ${deduped.length}`,
    `- Balanced queue rows: ${queue.length}`,
    "",
    "## By rule",
    "",
    ...Object.entries(countBy(deduped, (row) => row.rule)).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `- ${rule}: ${n}`),
    "",
    "## Queue",
    "",
    "| ID | Rule | Label | Ambiguity | Text |",
    "|---|---|---|---:|---|",
    ...queue.map((row) => `| ${row.id} | ${row.rule} | ${row.label} | ${row.ambiguity} | ${row.text.slice(0, 180).replace(/\|/g, "\\|")}${row.text.length > 180 ? "…" : ""} |`),
    "",
  ].join("\n");
  fs.writeFileSync(args.markdown, md, "utf8");
  console.log(`candidates: ${deduped.length}`);
  console.log(`queue: ${queue.length}`);
  console.log(`output: ${args.output}`);
  console.log(`markdown: ${args.markdown}`);
  console.log(`report: ${args.report}`);
}
main();
