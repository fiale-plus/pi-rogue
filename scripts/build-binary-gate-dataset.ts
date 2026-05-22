#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { classifyRoutingText, hashText, type Label } from "./routing-heuristics.js";

const BINARY_LABEL: Record<string, "escalate" | "continue"> = {
  planning: "escalate",
  debugging: "escalate",
  research: "escalate",
  review: "escalate",
  implementation: "continue",
  ops: "continue",
  handoff: "continue",
};

interface BinaryRow {
  id: string;
  text: string;
  label: "escalate" | "continue";
  source: string;
  sourceLabel?: Label;
  cwd?: string;
  sessionId?: string;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return String(content ?? "").trim();
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

function main() {
  const args = {
    goldInput: path.join(process.cwd(), "data", "routing", "gold.jsonl"),
    piSessions: path.join(process.env.HOME || "/tmp", ".pi", "agent", "sessions"),
    claudeHistory: path.join(process.env.HOME || "/tmp", ".claude", "history.jsonl"),
    claudeProjects: path.join(process.env.HOME || "/tmp", ".claude", "projects"),
    output: path.join(process.cwd(), "data", "routing", "binary-gate.jsonl"),
    limit: 4000,
  };

  const rows: BinaryRow[] = [];
  const seen = new Set<string>();
  const add = (text: string, label: "escalate" | "continue", source: string, sourceLabel?: Label) => {
    const key = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key) || text.length < 4) return;
    seen.add(key);
    rows.push({ id: hashText(text), text: text.trim(), label, source, sourceLabel });
  };

  // 1. Convert existing gold
  const gold = readJsonl<{ text: string; label: Label }>(args.goldInput);
  for (const g of gold) {
    const bin = BINARY_LABEL[g.label];
    if (bin) add(g.text, bin, "gold", g.label);
  }
  console.log(`gold converted: ${gold.length}`);

  // 2. Mine Pi sessions (use existing heuristic but map to binary)
  let piCount = 0;
  const stack = [args.piSessions];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (!fs.existsSync(dir)) continue;
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const raw = fs.readFileSync(full, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (row?.type !== "message") continue;
          const msg = row.message;
          if (!msg || msg.role !== "user") continue;
          const text = textFromContent(msg.content);
          if (!text || text.length < 4) continue;
          const cls = classifyRoutingText(text, row.cwd || msg.cwd);
          if (!cls.label) continue;
          const bin = BINARY_LABEL[cls.label];
          if (!bin) continue;
          add(text, bin, "pi_session", cls.label);
          piCount++;
        } catch {}
      }
      if (rows.length >= args.limit) break;
    }
    if (rows.length >= args.limit) break;
  }
  console.log(`pi sessions mined: ${piCount}`);

  // 3. Mine Claude history.jsonl (display field = user prompt)
  let claudeCount = 0;
  if (fs.existsSync(args.claudeHistory)) {
    const raw = fs.readFileSync(args.claudeHistory, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        const text = textFromContent(row.display || row.content || row.text || row.prompt);
        if (!text || text.length < 4) continue;
        const cls = classifyRoutingText(text, row.project || row.cwd);
        if (!cls.label) continue;
        const bin = BINARY_LABEL[cls.label];
        if (!bin) continue;
        add(text, bin, "claude_history", cls.label);
        claudeCount++;
      } catch {}
      if (rows.length >= args.limit) break;
    }
  }
  console.log(`claude history mined: ${claudeCount}`);

  // 4. Mine Claude project sessions (sample up to 200 files, no subagents)
  let claudeProjectCount = 0;
  if (fs.existsSync(args.claudeProjects)) {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (files.length >= 200) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes("subagents")) files.push(full);
        if (files.length >= 200) return;
      }
    };
    walk(args.claudeProjects);
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const row = JSON.parse(trimmed);
            const content = row?.messages?.find((m: any) => m.role === "user")?.content
              || row?.display
              || row?.content
              || row?.text
              || row?.prompt;
            const text = textFromContent(content);
            if (!text || text.length < 4) continue;
            const cls = classifyRoutingText(text, row.cwd);
            if (!cls.label) continue;
            const bin = BINARY_LABEL[cls.label];
            if (!bin) continue;
            add(text, bin, "claude_project", cls.label);
            claudeProjectCount++;
          } catch {}
          if (rows.length >= args.limit) break;
        }
      } catch {}
      if (rows.length >= args.limit) break;
    }
  }
  console.log(`claude project sessions mined: ${claudeProjectCount}`);

  // Output
  const binCounts = rows.reduce<Record<string, number>>((a, r) => { a[r.label] = (a[r.label] || 0) + 1; return a; }, {});
  const sourceCounts = rows.reduce<Record<string, number>>((a, r) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {});
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  console.log(`\n--- RESULT ---`);
  console.log(`total binary rows: ${rows.length}`);
  console.log(`binary counts: ${JSON.stringify(binCounts)}`);
  console.log(`source counts: ${JSON.stringify(sourceCounts)}`);
  console.log(`output: ${args.output}`);
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; }
