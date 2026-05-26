#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";

const DEFAULT_HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const DEFAULT_INPUT_DIR = path.join(DEFAULT_HOME, ".pi", "agent", "sessions");
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "data", "routing");
const DEFAULT_OUTCOMES = path.join(DEFAULT_OUTPUT_DIR, "session-model-outcomes.jsonl");
const DEFAULT_REPORT = path.join(DEFAULT_OUTPUT_DIR, "session-model-outcomes-report.json");

interface OutcomeRow {
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
  messageId?: string;
  parentId?: string;
  createdAt?: string;
  userText?: string;
  provider?: string;
  api?: string;
  model: string;
  stopReason?: string;
  responseId?: string;
  errorCode?: string;
  errorMessage?: string;
  toolCalls: number;
  toolNames: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
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
    output: String(args.output || DEFAULT_OUTCOMES),
    report: String(args.report || DEFAULT_REPORT),
    cwdContains: args["cwd-contains"] ? String(args["cwd-contains"]) : "",
    modelContains: args["model-contains"] ? String(args["model-contains"]).toLowerCase() : "",
    limit: Number(args.limit || 0) || 0,
  };
}

function walkJsonlFiles(input: string): string[] {
  if (!fs.existsSync(input)) return [];
  const stat = fs.statSync(input);
  if (stat.isFile()) return input.endsWith(".jsonl") ? [input] : [];
  const out: string[] = [];
  const stack = [input];
  while (stack.length) {
    const current = stack.pop()!;
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

function readRows(file: string): any[] {
  const rows: any[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return rows;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return String(content ?? "").replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") { parts.push(item); continue; }
    const obj = item as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    else if (typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractSessionMeta(rows: any[]): SessionMeta {
  const first = rows.find((row) => row?.type === "session") ?? {};
  return {
    sessionId: typeof first.id === "string" ? first.id : undefined,
    cwd: typeof first.cwd === "string" ? first.cwd : undefined,
  };
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "toolCall" && typeof obj.name === "string") names.push(obj.name);
  }
  return names;
}

function usageOf(message: any): OutcomeRow["usage"] {
  const usage = message?.usage ?? {};
  const cost = usage?.cost ?? {};
  return {
    input: Number(usage.input || 0),
    output: Number(usage.output || 0),
    cacheRead: Number(usage.cacheRead || 0),
    cacheWrite: Number(usage.cacheWrite || 0),
    totalTokens: Number(usage.totalTokens || 0),
    cost: Number(cost.total || 0),
  };
}

function errorCode(message: any): string | undefined {
  const raw = String(message?.errorMessage || "");
  const match = raw.match(/"code"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

function errorMessage(message: any): string | undefined {
  const raw = String(message?.errorMessage || "").replace(/\s+/g, " ").trim();
  return raw || undefined;
}

function countBy<T>(rows: T[], fn: (row: T) => string | undefined): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = fn(row) || "missing";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = walkJsonlFiles(args.input);
  const outcomes: OutcomeRow[] = [];
  let scannedMessages = 0;

  for (const file of files) {
    const rows = readRows(file);
    const meta = extractSessionMeta(rows);
    if (args.cwdContains && !(meta.cwd || file).includes(args.cwdContains)) continue;
    let lastUserText = "";

    for (const row of rows) {
      if (row?.type !== "message") continue;
      const msg = row.message;
      if (!msg) continue;
      if (msg.role === "user") {
        lastUserText = textFromContent(msg.content).slice(0, 1000);
        continue;
      }
      if (msg.role !== "assistant" || !msg.model) continue;
      scannedMessages++;
      const model = String(msg.model);
      if (args.modelContains && !model.toLowerCase().includes(args.modelContains)) continue;
      const tools = toolNames(msg.content);
      outcomes.push({
        sessionFile: rel(file),
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        messageId: row.id,
        parentId: row.parentId,
        createdAt: row.timestamp || msg.timestamp,
        userText: lastUserText || undefined,
        provider: msg.provider,
        api: msg.api,
        model,
        stopReason: msg.stopReason,
        responseId: msg.responseId,
        errorCode: errorCode(msg),
        errorMessage: errorMessage(msg),
        toolCalls: tools.length,
        toolNames: tools,
        usage: usageOf(msg),
      });
      if (args.limit > 0 && outcomes.length >= args.limit) break;
    }
    if (args.limit > 0 && outcomes.length >= args.limit) break;
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, outcomes.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");

  const totals = outcomes.reduce((acc, row) => {
    acc.input += row.usage.input;
    acc.output += row.usage.output;
    acc.cacheRead += row.usage.cacheRead;
    acc.cacheWrite += row.usage.cacheWrite;
    acc.totalTokens += row.usage.totalTokens;
    acc.cost += row.usage.cost;
    acc.toolCalls += row.toolCalls;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, toolCalls: 0 });

  const contextErrors = outcomes.filter((row) => row.errorCode === "context_length_exceeded" || /context_length_exceeded|context window/i.test(row.errorMessage || ""));
  const report = {
    input: args.input,
    files: files.length,
    scannedMessages,
    outcomes: outcomes.length,
    output: args.output,
    totals,
    byModel: countBy(outcomes, (row) => `${row.provider || "unknown"}/${row.model}`),
    byStopReason: countBy(outcomes, (row) => row.stopReason),
    byModelStopReason: countBy(outcomes, (row) => `${row.provider || "unknown"}/${row.model}:${row.stopReason || "missing"}`),
    contextErrors: {
      count: contextErrors.length,
      sample: contextErrors.slice(0, 10).map((row) => ({ sessionFile: row.sessionFile, createdAt: row.createdAt, model: row.model, userText: row.userText, errorCode: row.errorCode })),
    },
  };

  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`files: ${files.length}`);
  console.log(`assistant model messages: ${scannedMessages}`);
  console.log(`outcomes: ${outcomes.length}`);
  console.log(`models: ${JSON.stringify(report.byModel)}`);
  console.log(`stop reasons: ${JSON.stringify(report.byStopReason)}`);
  console.log(`context errors: ${contextErrors.length}`);
  console.log(`outcomes file: ${args.output}`);
  console.log(`report file: ${args.report}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
