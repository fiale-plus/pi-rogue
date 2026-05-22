#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const DEFAULT_INPUT_DIR = path.join(DEFAULT_HOME, ".pi", "agent", "sessions");
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "data", "routing");

const LABELS = ["planning", "implementation", "debugging", "review", "research", "ops", "handoff"] as const;
type Label = (typeof LABELS)[number];

type ConfidenceSource = "explicit" | "heuristic";

interface ExampleRow {
  text: string;
  label: Label;
  confidence: number;
  confidenceSource: ConfidenceSource;
  reason: string;
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  turnIndex: number;
  messageId?: string;
  createdAt?: string;
}

interface UnlabeledRow {
  text: string;
  reason: string;
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  turnIndex: number;
  messageId?: string;
  createdAt?: string;
}

interface SessionMeta {
  sessionId?: string;
  cwd?: string;
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
    input: String(args.input || DEFAULT_INPUT_DIR),
    output: String(args.output || DEFAULT_OUTPUT_DIR),
    limit: Number(args.limit || 0) || 0,
    minConfidence: Number(args["min-confidence"] || 0) || 0,
    keepUnlabeled: args["no-unlabeled"] ? false : true,
    report: args.report !== false,
    cwdContains: args["cwd-contains"] ? String(args["cwd-contains"]) : "",
  };
}

function walkJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (current.endsWith(".jsonl")) out.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out.sort();
}

function rel(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

function readLines(file: string): any[] {
  const raw = fs.readFileSync(file, "utf8");
  const rows: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return String(content ?? "").trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    else if (typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractSessionMeta(lines: any[]): SessionMeta {
  const first = lines.find((row) => row?.type === "session") ?? {};
  return {
    sessionId: typeof first.id === "string" ? first.id : undefined,
    cwd: typeof first.cwd === "string" ? first.cwd : undefined,
  };
}

function classify(text: string, cwd?: string): { label?: Label; confidence: number; reason: string; source: ConfidenceSource } {
  const t = text.toLowerCase();
  const c = (cwd || "").toLowerCase();

  const rules: Array<{ label: Label; re: RegExp; reason: string; confidence: number; source: ConfidenceSource }> = [
    { label: "handoff", re: /\b(\/compact|compact|resume|continue|handoff|pick up|move on|wrap up|carry on)\b/i, reason: "handoff/compact signal", confidence: 0.96, source: "explicit" },
    { label: "review", re: /\b(review|pr|pull request|check|inspect|audit|looks good|approve|merge)\b/i, reason: "review signal", confidence: 0.92, source: "heuristic" },
    { label: "debugging", re: /\b(debug|bug|error|fail|failing|broken|stuck|fix(?:ing)?|traceback|investigate)\b/i, reason: "debugging signal", confidence: 0.9, source: "heuristic" },
    { label: "research", re: /\b(research|docs?|documentation|compare|benchmark|look up|find out|what is|how does)\b/i, reason: "research/question signal", confidence: 0.85, source: "heuristic" },
    { label: "ops", re: /\b(install|configure|settings?|theme|cmux|ghostty|setup|enable|disable|update|deploy|shell|terminal|environment|path)\b/i, reason: "ops/config signal", confidence: 0.84, source: "heuristic" },
    { label: "implementation", re: /\b(implement|build|create|write|add|edit|refactor|change|make|code|script)\b/i, reason: "implementation signal", confidence: 0.81, source: "heuristic" },
    { label: "planning", re: /\b(plan|scope|architecture|design|strategy|next step|what should|should we|roadmap)\b/i, reason: "planning signal", confidence: 0.8, source: "heuristic" },
  ];

  for (const rule of rules) {
    if (rule.re.test(t) || (rule.label === "ops" && /cmux|ghostty/.test(c))) return rule;
  }

  return { confidence: 0.2, reason: "ambiguous", source: "heuristic" };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function jsonlLine(v: unknown): string {
  return `${JSON.stringify(v)}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = walkJsonlFiles(args.input);
  const examples: ExampleRow[] = [];
  const unlabeled: UnlabeledRow[] = [];
  const counts = new Map<string, number>();
  let scanned = 0;
  let skipped = 0;

  for (const file of files) {
    const lines = readLines(file);
    const meta = extractSessionMeta(lines);
    if (args.cwdContains && !(meta.cwd || "").includes(args.cwdContains)) continue;

    let turnIndex = 0;
    for (const row of lines) {
      if (row?.type !== "message") continue;
      const msg = row.message;
      if (!msg || msg.role !== "user") continue;
      const text = textFromContent(msg.content);
      if (!text) continue;

      scanned++;
      const cls = classify(text, meta.cwd);
      if (!cls.label || cls.confidence < args.minConfidence) {
        skipped++;
        if (args.keepUnlabeled) {
          unlabeled.push({
            text,
            reason: cls.reason,
            sessionFile: rel(file),
            sessionId: meta.sessionId,
            cwd: meta.cwd,
            turnIndex,
            messageId: row.id,
            createdAt: msg.timestamp ? String(msg.timestamp) : undefined,
          });
        }
        turnIndex++;
        continue;
      }

      const example: ExampleRow = {
        text,
        label: cls.label,
        confidence: cls.confidence,
        confidenceSource: cls.source,
        reason: cls.reason,
        sessionFile: rel(file),
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        turnIndex,
        messageId: row.id,
        createdAt: msg.timestamp ? String(msg.timestamp) : undefined,
      };
      examples.push(example);
      counts.set(cls.label, (counts.get(cls.label) || 0) + 1);
      turnIndex++;

      if (args.limit > 0 && examples.length >= args.limit) break;
    }

    if (args.limit > 0 && examples.length >= args.limit) break;
  }

  ensureDir(args.output);
  const examplesPath = path.join(args.output, "examples.jsonl");
  const unlabeledPath = path.join(args.output, "unlabeled.jsonl");

  fs.writeFileSync(examplesPath, examples.map(jsonlLine).join(""), "utf8");
  if (args.keepUnlabeled) fs.writeFileSync(unlabeledPath, unlabeled.map(jsonlLine).join(""), "utf8");

  if (args.report) {
    const total = examples.length;
    const labelCounts = LABELS.map((label) => `${label}: ${counts.get(label) || 0}`).join(", ");
    console.log(`files: ${files.length}`);
    console.log(`scanned turns: ${scanned}`);
    console.log(`examples: ${total}`);
    console.log(`skipped/ambiguous: ${skipped}`);
    console.log(`labels: ${labelCounts}`);
    console.log(`examples file: ${examplesPath}`);
    if (args.keepUnlabeled) console.log(`unlabeled file: ${unlabeledPath}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
