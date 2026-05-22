#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { LABELS, classifyRoutingText, hashText, type Label } from "./routing-heuristics.js";

const DEFAULT_DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_EXAMPLES = path.join(DEFAULT_DIR, "examples.jsonl");
const DEFAULT_UNLABELED = path.join(DEFAULT_DIR, "unlabeled.jsonl");
const DEFAULT_OUTPUT = path.join(DEFAULT_DIR, "label-queue.jsonl");
const DEFAULT_MARKDOWN = path.join(DEFAULT_DIR, "label-queue.md");

interface SourceRow {
  text: string;
  label?: string;
  confidence?: number;
  confidenceSource?: string;
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
  turnIndex?: number;
  messageId?: string;
  createdAt?: string;
}

interface QueueRow {
  id: string;
  text: string;
  goldLabel: "" | Label | "drop";
  heuristicLabel?: Label;
  heuristicConfidence?: number;
  heuristicReason?: string;
  source: "heuristic" | "ambiguous";
  priority: number;
  reviewReason: string;
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
  turnIndex?: number;
  messageId?: string;
  createdAt?: string;
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
    examples: String(args.examples || DEFAULT_EXAMPLES),
    unlabeled: String(args.unlabeled || DEFAULT_UNLABELED),
    output: String(args.output || DEFAULT_OUTPUT),
    markdown: args.markdown === false ? "" : String(args.markdown || DEFAULT_MARKDOWN),
    perLabel: Math.max(1, Number(args["per-label"] || 30) || 30),
    ambiguous: Math.max(0, Number(args.ambiguous || 100) || 100),
  };
}

function readJsonl(file: string): SourceRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceRow)
    .filter((row) => typeof row.text === "string" && row.text.trim().length > 0);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();
}

function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function qualityPenalty(text: string): number {
  const words = tokenCount(text);
  let penalty = 0;
  if (words < 2) penalty += 60;
  if (/^\/?exit\b/i.test(text)) penalty += 80;
  if (/^[\W_]+$/.test(text)) penalty += 80;
  if (text.length > 2400) penalty += 25;
  return penalty;
}

function heuristicPriority(row: SourceRow): { priority: number; reason: string } {
  const label = row.label || "";
  const text = row.text;
  const rareBoost: Record<string, number> = {
    planning: 80,
    debugging: 70,
    handoff: 45,
    review: 40,
    research: 35,
    implementation: 30,
    ops: 25,
  };
  let priority = 100 + (rareBoost[label] || 0) - qualityPenalty(text);
  const reasons = [`heuristic ${label || "unknown"}`];

  if (/\bcheck\b/i.test(text)) {
    priority += 35;
    reasons.push("check-boundary case");
  }
  if (/\b(what should|should we|next step|path forward|strategy|plan)\b/i.test(text)) {
    priority += 35;
    reasons.push("planning-ish boundary");
  }
  if (/\b(error|fail|broken|stuck|crash|traceback|debug)\b/i.test(text)) {
    priority += 25;
    reasons.push("debug boundary");
  }
  if ((row.confidence || 0) < 0.85) {
    priority += 20;
    reasons.push("lower heuristic confidence");
  }
  return { priority, reason: reasons.join("; ") };
}

function ambiguousPriority(row: SourceRow): { priority: number; reason: string } {
  const text = row.text;
  let priority = 120 - qualityPenalty(text);
  const reasons = ["ambiguous/miner skipped"];

  if (/\b(status|stats|logs?|test|tests|build|run|deploy|install|model|provider|config)\b/i.test(text)) {
    priority += 45;
    reasons.push("ops-command boundary");
  }
  if (/\b(why|error|fail|broken|stuck|fix|debug)\b/i.test(text)) {
    priority += 45;
    reasons.push("debug boundary");
  }
  if (/\b(what|how|which|safe|github|tool|package|library|model)\b/i.test(text)) {
    priority += 35;
    reasons.push("research boundary");
  }
  if (/\b(next|continue|resume|compact|handoff|plan|strategy|should)\b/i.test(text)) {
    priority += 35;
    reasons.push("planning/handoff boundary");
  }
  const words = tokenCount(text);
  if (words >= 4 && words <= 80) {
    priority += 20;
    reasons.push("annotation-sized");
  }
  return { priority, reason: reasons.join("; ") };
}

function toQueueRow(row: SourceRow, source: QueueRow["source"], priority: number, reviewReason: string): QueueRow {
  const prediction = classifyRoutingText(row.text, row.cwd);
  const heuristicLabel = (row.label || prediction.label) as Label | undefined;
  return {
    id: hashText(row.text, row.sessionId || "", String(row.turnIndex ?? "")),
    text: row.text,
    goldLabel: "",
    heuristicLabel,
    heuristicConfidence: row.confidence ?? prediction.confidence,
    heuristicReason: row.reason || prediction.reason,
    source,
    priority,
    reviewReason,
    sessionFile: row.sessionFile,
    sessionId: row.sessionId,
    cwd: row.cwd,
    turnIndex: row.turnIndex,
    messageId: row.messageId,
    createdAt: row.createdAt,
  };
}

function byHeuristicLabel(rows: SourceRow[]): Record<string, SourceRow[]> {
  const grouped: Record<string, SourceRow[]> = {};
  for (const row of rows) {
    const label = row.label || classifyRoutingText(row.text, row.cwd).label || "unknown";
    (grouped[label] ||= []).push(row);
  }
  return grouped;
}

function writeMarkdown(file: string, rows: QueueRow[], perLabel: number, ambiguous: number) {
  const labels = LABELS.map((label) => `\`${label}\``).join(", ");
  const lines = [
    "# Routing hand-label queue",
    "",
    "Fill `goldLabel` in `label-queue.jsonl`; this markdown is a review aid.",
    "",
    `Allowed labels: ${labels}, \`drop\` for unusable rows.`,
    "",
    `Sampling target: up to ${perLabel} per heuristic label + ${ambiguous} ambiguous rows.`,
    "",
    "## Queue",
    "",
  ];

  for (const row of rows) {
    const oneLine = row.text.replace(/\s+/g, " ").trim();
    lines.push(`### ${row.id}`);
    lines.push(`- goldLabel: `);
    lines.push(`- heuristic: ${row.heuristicLabel || "none"} (${row.heuristicConfidence ?? "n/a"})`);
    lines.push(`- source: ${row.source}`);
    lines.push(`- priority: ${row.priority}`);
    lines.push(`- reason: ${row.reviewReason}`);
    if (row.cwd) lines.push(`- cwd: \`${row.cwd}\``);
    lines.push("");
    lines.push("> " + oneLine.replace(/\n/g, "\n> "));
    lines.push("");
  }

  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const examples = readJsonl(args.examples);
  const unlabeled = readJsonl(args.unlabeled);
  const seen = new Set<string>();
  const queue: QueueRow[] = [];

  const add = (row: QueueRow) => {
    const key = normalize(row.text);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(row);
  };

  const grouped = byHeuristicLabel(examples);
  for (const label of LABELS) {
    const selected = (grouped[label] || [])
      .map((row) => ({ row, score: heuristicPriority(row) }))
      .sort((a, b) => b.score.priority - a.score.priority)
      .slice(0, args.perLabel);
    for (const item of selected) {
      add(toQueueRow(item.row, "heuristic", item.score.priority, item.score.reason));
    }
  }

  const ambiguousSelected = unlabeled
    .map((row) => ({ row, score: ambiguousPriority(row) }))
    .sort((a, b) => b.score.priority - a.score.priority)
    .slice(0, args.ambiguous);
  for (const item of ambiguousSelected) {
    add(toQueueRow(item.row, "ambiguous", item.score.priority, item.score.reason));
  }

  queue.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, queue.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  if (args.markdown) writeMarkdown(args.markdown, queue, args.perLabel, args.ambiguous);

  const sourceCounts = queue.reduce<Record<string, number>>((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});
  const labelCounts = queue.reduce<Record<string, number>>((acc, row) => {
    const label = row.heuristicLabel || "none";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  console.log(`queue rows: ${queue.length}`);
  console.log(`source counts: ${JSON.stringify(sourceCounts)}`);
  console.log(`heuristic label counts: ${JSON.stringify(labelCounts)}`);
  console.log(`queue file: ${args.output}`);
  if (args.markdown) console.log(`markdown file: ${args.markdown}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
