#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { LABELS, classifyRoutingText, type Label } from "./routing-heuristics.js";

const DEFAULT_DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_INPUT = path.join(DEFAULT_DIR, "label-queue.jsonl");
const DEFAULT_QUEUE_OUT = path.join(DEFAULT_DIR, "model-label-queue.jsonl");
const DEFAULT_GOLD_OUT = path.join(DEFAULT_DIR, "gold.jsonl");
const DEFAULT_REPORT = path.join(DEFAULT_DIR, "model-label-report.json");
const LABELER = "model_assisted_rules_v1";

interface QueueRow {
  id: string;
  text: string;
  goldLabel?: "" | Label | "drop";
  heuristicLabel?: Label;
  heuristicConfidence?: number;
  heuristicReason?: string;
  source?: "heuristic" | "ambiguous";
  priority?: number;
  reviewReason?: string;
  sessionFile?: string;
  sessionId?: string;
  cwd?: string;
  turnIndex?: number;
  messageId?: string;
  createdAt?: string;
}

interface LabelDecision {
  label: Label | "drop";
  confidence: number;
  reason: string;
}

interface LabeledQueueRow extends QueueRow {
  goldLabel: Label | "drop";
  labeler: string;
  modelConfidence: number;
  modelReason: string;
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
    input: String(args.input || DEFAULT_INPUT),
    queueOutput: String(args["queue-output"] || DEFAULT_QUEUE_OUT),
    goldOutput: String(args["gold-output"] || DEFAULT_GOLD_OUT),
    report: String(args.report || DEFAULT_REPORT),
    minConfidence: Math.max(0, Math.min(1, Number(args["min-confidence"] || 0.45) || 0.45)),
  };
}

function readJsonl(file: string): QueueRow[] {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueueRow)
    .filter((row) => typeof row.id === "string" && typeof row.text === "string");
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function words(text: string): number {
  return clean(text).split(/\s+/).filter(Boolean).length;
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

function dropDecision(raw: string): LabelDecision | undefined {
  const text = clean(raw);
  const lower = text.toLowerCase();
  if (!text) return { label: "drop", confidence: 0.99, reason: "empty" };
  if (/^\/?exit\b|^quit\b|^q$/i.test(text)) return { label: "drop", confidence: 0.98, reason: "session exit/no-op" };
  if (/^<skill name=/.test(text) || /^<available_skills>/.test(text) || /^You are a delegated subagent\b/i.test(text)) {
    return { label: "drop", confidence: 0.95, reason: "synthetic/tool prompt, not a direct routing turn" };
  }
  if (/^(ok|okay|thanks|thank you|cool|nice|great|yes|no|yep|nah|lol|haha)[.!]*$/i.test(text)) {
    return { label: "drop", confidence: 0.9, reason: "acknowledgement/no routing intent" };
  }
  if (words(text) <= 2 && !/\b(status|stats|logs?|test|build|run|fix|debug|review|continue|resume|plan)\b/i.test(lower)) {
    return { label: "drop", confidence: 0.78, reason: "too short without routing signal" };
  }
  return undefined;
}

function modelLabel(row: QueueRow): LabelDecision {
  const raw = clean(row.text);
  const lower = raw.toLowerCase();
  const drop = dropDecision(raw);
  if (drop) return drop;

  const check = /\bcheck\b/i.test(lower);
  const commandLike = /^\s*(?:go run|npm run|pnpm|yarn|bun|cargo|pytest|vitest|make|git |gh |hermes\b|ollama\b|lms\b|ssh\b|curl\b|open\b|ls\b|rg\b|find\b|cat\b|node\b|tsx\b|python\b)/i.test(raw)
    || /\b(status|stats|logs?|test|tests|build|deploy|install|configured|configuration|settings?|api key|provider|model list|loaded|terminal|theme|cmux|ghostty|env|path|machine|worktree|ssh)\b/i.test(lower);
  const diagnosticWhy = /\bwhy\b[^.!?\n]*(?:not|doesn'?t|isn'?t|won'?t|fail|failed|error|broken|crash|slow|fallback|falls back|strip|missing|called|support|work|opens?)/i.test(lower);
  const debugish = diagnosticWhy || /\b(error|errors|fail(?:ed|ing|ure)?|broken|bug|crash(?:ed)?|stuck|not working|nothing opens|fallback|falls back|slow|strip(?:ped)?|missing|not being called|traceback|stack trace|fix)\b/i.test(lower);
  const researchish = /\b(what is|what's|which|compare|comparison|benchmark|research|docs?|documentation|look up|find out|safe to use|is it safe|github|repo|package|library|tool|model family|availability|availability|quantized|mlx|ollama cloud|nemotron|qwen|gemma|compressor)\b/i.test(lower);
  const planningish = /\b(path forward|what would be the path|what should|should we|shall we|why do we need|next step|plan|strategy|roadmap|architecture|scope|design|talk through|decide|where do we go)\b/i.test(lower);
  const reviewish = /\b(review|pr|pull request|diff|approve|merge|looks good|audit|inspect\b|validate|is this correct|are we done|done correctly|check(?:ed)? (?:the )?(?:diff|pr|pull request|code|patch|changes?|implementation|work))\b/i.test(lower);
  const handoffish = /\b(\/compact|compact|resume|continue|handoff|pick up|carry on|move on|wrap up|next one|proceed)\b/i.test(lower);
  const implementationish = /\b(implement|build|create|write|add|edit|refactor|change|make|code|script|wire|integrate|install that|go with|do it|set up|setup|migrate|port|patch|update.+file|renovate|cleanup|clean up|remove|fix this)\b/i.test(lower);

  if (handoffish && !planningish && !implementationish) {
    return { label: "handoff", confidence: 0.9, reason: "explicit continuation/handoff intent" };
  }
  if (implementationish && check && /\b(update|patch|file|cleanup|clean up|remove|renovate|compress|readme|docs?)\b/i.test(lower)) {
    return { label: "implementation", confidence: 0.84, reason: "check request asks to update/patch/cleanup content" };
  }
  if (check && commandLike && !reviewish) {
    return { label: "ops", confidence: 0.84, reason: "check request about machine/status/config/environment" };
  }
  if (reviewish) {
    return { label: "review", confidence: check ? 0.86 : 0.88, reason: "asks for judgment/review of code, PR, diff, or completed work" };
  }
  if (debugish && !researchish && !planningish) {
    return { label: "debugging", confidence: 0.84, reason: "failure/why-not-working diagnosis" };
  }
  if (check && debugish) {
    return { label: "debugging", confidence: 0.82, reason: "check request about failure/error state" };
  }
  if (check && commandLike) {
    return { label: "ops", confidence: 0.82, reason: "check request about status/config/logs/environment" };
  }
  if (planningish && !commandLike) {
    return { label: "planning", confidence: 0.78, reason: "asks for direction/scope/decision" };
  }
  if (researchish && !implementationish) {
    return { label: "research", confidence: 0.82, reason: "asks for information/comparison/tool or model understanding" };
  }
  if (commandLike && !planningish) {
    return { label: "ops", confidence: 0.8, reason: "command/config/status/environment intent" };
  }
  if (debugish) {
    return { label: "debugging", confidence: 0.75, reason: "debug signal mixed with other intent" };
  }
  if (researchish) {
    return { label: "research", confidence: 0.75, reason: "research signal mixed with other intent" };
  }
  if (planningish) {
    return { label: "planning", confidence: 0.72, reason: "planning signal mixed with other intent" };
  }
  if (implementationish) {
    return { label: "implementation", confidence: 0.78, reason: "asks to implement/build/change" };
  }

  const heuristic = classifyRoutingText(raw, row.cwd);
  if (heuristic.label) {
    return { label: heuristic.label, confidence: Math.min(0.7, heuristic.confidence), reason: `fallback heuristic: ${heuristic.reason}` };
  }

  if (row.heuristicLabel) {
    return { label: row.heuristicLabel, confidence: Math.min(0.65, row.heuristicConfidence || 0.65), reason: `queue heuristic fallback: ${row.heuristicReason || "unknown"}` };
  }

  return { label: "drop", confidence: 0.55, reason: "no reliable routing signal" };
}

function toGold(row: LabeledQueueRow) {
  if (row.goldLabel === "drop") return undefined;
  return {
    id: row.id,
    text: row.text,
    label: row.goldLabel,
    source: "model_gold",
    labeler: row.labeler,
    modelConfidence: row.modelConfidence,
    modelReason: row.modelReason,
    heuristicLabel: row.heuristicLabel,
    heuristicConfidence: row.heuristicConfidence,
    heuristicReason: row.heuristicReason,
    queueSource: row.source,
    sessionFile: row.sessionFile,
    sessionId: row.sessionId,
    cwd: row.cwd,
    turnIndex: row.turnIndex,
    messageId: row.messageId,
    createdAt: row.createdAt,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readJsonl(args.input);
  const labeled: LabeledQueueRow[] = rows.map((row) => {
    const decision = modelLabel(row);
    const goldLabel = decision.confidence < args.minConfidence ? "drop" : decision.label;
    return {
      ...row,
      goldLabel,
      labeler: LABELER,
      modelConfidence: decision.confidence,
      modelReason: decision.confidence < args.minConfidence ? `below confidence threshold: ${decision.reason}` : decision.reason,
    };
  });

  const gold = labeled.map(toGold).filter(Boolean);
  const labelCounts = labeled.reduce<Record<string, number>>((acc, row) => {
    acc[row.goldLabel] = (acc[row.goldLabel] || 0) + 1;
    return acc;
  }, {});
  const sourceCounts = labeled.reduce<Record<string, number>>((acc, row) => {
    const source = row.source || "unknown";
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  const lowConfidence = labeled
    .filter((row) => row.goldLabel !== "drop" && row.modelConfidence < 0.72)
    .sort((a, b) => a.modelConfidence - b.modelConfidence)
    .slice(0, 50)
    .map((row) => ({ id: row.id, goldLabel: row.goldLabel, confidence: row.modelConfidence, reason: row.modelReason, text: row.text.slice(0, 220) }));
  const disagreements = labeled
    .filter((row) => row.goldLabel !== "drop" && row.heuristicLabel && row.heuristicLabel !== row.goldLabel)
    .slice(0, 80)
    .map((row) => ({ id: row.id, heuristicLabel: row.heuristicLabel, goldLabel: row.goldLabel, confidence: row.modelConfidence, reason: row.modelReason, text: row.text.slice(0, 220) }));

  fs.mkdirSync(path.dirname(args.queueOutput), { recursive: true });
  fs.writeFileSync(args.queueOutput, labeled.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  fs.writeFileSync(args.goldOutput, gold.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  fs.writeFileSync(args.report, `${JSON.stringify({ labeler: LABELER, input: args.input, rows: rows.length, goldRows: gold.length, labelCounts, sourceCounts, lowConfidence, disagreements }, null, 2)}\n`, "utf8");

  console.log(`labeler: ${LABELER}`);
  console.log(`queue rows: ${rows.length}`);
  console.log(`gold rows: ${gold.length}`);
  console.log(`label counts: ${JSON.stringify(labelCounts)}`);
  console.log(`source counts: ${JSON.stringify(sourceCounts)}`);
  console.log(`low-confidence kept: ${lowConfidence.length}`);
  console.log(`heuristic disagreements: ${disagreements.length}`);
  console.log(`labeled queue: ${args.queueOutput}`);
  console.log(`gold file: ${args.goldOutput}`);
  console.log(`report: ${args.report}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
