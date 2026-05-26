#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_INPUT = path.join(DIR, "binary-q1-q10-conflict-misses.jsonl");
const DEFAULT_OUTPUT = path.join(DIR, "binary-q1-q10-hard-negative-packet.jsonl");
const DEFAULT_MARKDOWN = path.join(DIR, "binary-q1-q10-hard-negative-packet.md");
const DEFAULT_REPORT = path.join(DIR, "binary-q1-q10-hard-negative-packet-report.json");

type Label = "continue" | "escalate";
type Miss = {
  id?: string;
  text: string;
  label: Label;
  pred: Label;
  source: string;
  policyRule?: string;
  fold?: number;
};
type PacketRow = {
  id: string;
  sourceId?: string;
  text: string;
  label: Label;
  predictedLabel: Label;
  missDirection: string;
  policyRule: string;
  fold?: number;
  reviewPrompt: string;
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
    input: String(args.input || DEFAULT_INPUT),
    output: String(args.output || DEFAULT_OUTPUT),
    markdown: String(args.markdown || DEFAULT_MARKDOWN),
    report: String(args.report || DEFAULT_REPORT),
  };
}
function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) throw new Error(`Missing input file: ${file}. Run binary:eval-q1-q10 first.`);
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function countBy<T>(rows: T[], key: (row: T) => string) {
  return rows.reduce<Record<string, number>>((acc, row) => { const k = key(row); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function compact(text: string, max = 220) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
function reviewPrompt(row: Miss) {
  if (row.label === "continue" && row.pred === "escalate") {
    return "Find the decisive concrete/read-only/executable signal that should keep this as continue; optionally add one similar escalate variant where that signal is removed.";
  }
  if (row.label === "escalate" && row.pred === "continue") {
    return "Find the decisive ambiguity/judgment/risk signal that should make this escalate; optionally add one similar continue variant where the ambiguity is resolved.";
  }
  return "Confirm the label and note the decisive signal.";
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const misses = readJsonl<Miss>(args.input);
  const rows: PacketRow[] = misses
    .sort((a, b) => (a.policyRule || "unknown").localeCompare(b.policyRule || "unknown") || `${a.label}->${a.pred}`.localeCompare(`${b.label}->${b.pred}`) || a.text.localeCompare(b.text))
    .map((miss, index) => ({
      id: `hn-${String(index + 1).padStart(3, "0")}`,
      sourceId: miss.id,
      text: miss.text.replace(/\s+/g, " ").trim(),
      label: miss.label,
      predictedLabel: miss.pred,
      missDirection: `${miss.label}->${miss.pred}`,
      policyRule: miss.policyRule || "unknown",
      fold: miss.fold,
      reviewPrompt: reviewPrompt(miss),
    }));
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  const report = {
    input: args.input,
    rows: rows.length,
    missDirectionCounts: countBy(rows, (row) => row.missDirection),
    ruleCounts: countBy(rows, (row) => row.policyRule),
  };
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n", "utf8");
  const md = [
    "# Q1-Q10 hard-negative review packet",
    "",
    "Purpose: inspect conflict CV misses and derive contrastive hard negatives without adding runtime policy overlay.",
    "",
    `- Rows: ${rows.length}`,
    "",
    "## Miss directions",
    "",
    ...Object.entries(report.missDirectionCounts).sort().map(([direction, count]) => `- ${direction}: ${count}`),
    "",
    "## Miss clusters by rule",
    "",
    ...Object.entries(report.ruleCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => `- ${rule}: ${count}`),
    "",
    "## Review rows",
    "",
    "| ID | Source | Rule | Label | Pred | Prompt | Text |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${row.sourceId || ""} | ${row.policyRule} | ${row.label} | ${row.predictedLabel} | ${row.reviewPrompt.replace(/\|/g, "\\|")} | ${compact(row.text).replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n");
  fs.writeFileSync(args.markdown, md, "utf8");
  console.log(`rows: ${rows.length}`);
  console.log(`output: ${args.output}`);
  console.log(`markdown: ${args.markdown}`);
  console.log(`report: ${args.report}`);
}
main();
