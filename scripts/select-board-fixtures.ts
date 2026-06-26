#!/usr/bin/env tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardEvent, BoardFixture } from "../packages/advisor/src/board.js";
import { evaluateBoardFixtures } from "../packages/advisor/src/board.js";

interface Args {
  input: string;
  output: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return {
    input: String(args.input || path.join(process.env.HOME || "/tmp", ".pi", "agent", "sessions")),
    output: String(args.output || path.join(os.tmpdir(), "pi-rogue-board-fixture-candidates.json")),
    limit: Number(args.limit || 25) || 25,
  };
}

function walkJsonl(input: string): string[] {
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

export function compactText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(compactText).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!value || typeof value !== "object") return String(value ?? "").replace(/\s+/g, " ").trim();
  const record = value as Record<string, unknown>;
  return [record.raw, record.content, record.text, record.message, record.details, record.error, record.arguments, record.command]
    .map(compactText)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function redacted(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:sk|ghp|gho|github_pat|xoxb|hf)[-_][A-Za-z0-9_\-]{8,}/g, "[secret]")
    .slice(0, 240);
}

function candidateEvents(file: string): BoardEvent[] {
  const events: BoardEvent[] = [{ type: "session", id: path.basename(file), worktree: path.dirname(file) }];
  let turn = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    turn++;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { continue; }
    const text = redacted(compactText(row));
    if (!text) continue;
    if (/\b(edit|write|modified|created|updated|changed)\b/i.test(text) && /\.(ts|tsx|js|json|md)\b/i.test(text)) {
      const pathMatch = text.match(/[\w./-]+\.(?:ts|tsx|js|json|md)\b/);
      if (pathMatch) events.push({ type: "file_changed", path: pathMatch[0], turn });
    }
    if (/\b(exit code 0|passed|green|success|merged)\b/i.test(text)) {
      events.push({ type: "validation", command: text, exitCode: 0, status: "green", terminal: /\b(merged|complete|done)\b/i.test(text), turn });
    }
    if (/\b(exit code 1|failed|failure|error|red)\b/i.test(text)) {
      events.push({ type: "tool_failure", tool: "session", key: text.toLowerCase().slice(0, 48), message: text, turn });
    }
  }
  return events;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtures: BoardFixture[] = [];
  for (const file of walkJsonl(args.input)) {
    const events = candidateEvents(file);
    if (events.length < 3) continue;
    const id = path.relative(args.input, file).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
    fixtures.push({
      id,
      expectedEdgeMoment: "candidate mined from local session; hand-curate before committing",
      events,
    });
    if (fixtures.length >= args.limit) break;
  }
  const report = evaluateBoardFixtures(fixtures);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify({ fixtures, report }, null, 2)}\n`, "utf8");
  console.log(`wrote ${fixtures.length} candidate fixture(s) to ${args.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
