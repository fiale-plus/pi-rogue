#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { datasetSha256, manifestPathFor, type BinaryDatasetManifest } from "./binary-dataset-manifest.js";
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
  provenance: "reviewed" | "heuristic";
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

function parseArgs(argv: string[]) {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { values[key.slice(2)] = next; i += 1; }
    else values[key.slice(2)] = true;
  }
  return {
    goldInput: String(values["gold-input"] || path.join(process.cwd(), "data", "routing", "gold.jsonl")),
    piSessions: String(values["pi-sessions"] || path.join(process.env.HOME || "/tmp", ".pi", "agent", "sessions")),
    claudeHistory: String(values["claude-history"] || path.join(process.env.HOME || "/tmp", ".claude", "history.jsonl")),
    claudeProjects: String(values["claude-projects"] || path.join(process.env.HOME || "/tmp", ".claude", "projects")),
    output: String(values.output || path.join(process.cwd(), "data", "routing", "binary-gate.jsonl")),
    limit: Number(values.limit || 4000),
    minimumReviewed: (() => {
      const value = Number(values["min-reviewed"] ?? 20);
      if (!Number.isInteger(value) || value < 1) throw new Error("--min-reviewed must be a positive integer");
      return value;
    })(),
    weakLabelResearch: values["weak-label-research"] === true,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const rows: BinaryRow[] = [];
  const seen = new Map<string, "escalate" | "continue">();
  const exclusions: Record<string, number> = {};
  let conflicts = 0;
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
  const add = (text: string, label: "escalate" | "continue", source: string, provenance: "reviewed" | "heuristic", sourceLabel?: Label) => {
    const key = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (text.length < 4) { exclude("too_short"); return; }
    const existing = seen.get(key);
    if (existing) {
      if (existing !== label) conflicts += 1;
      exclude("duplicate");
      return;
    }
    seen.set(key, label);
    rows.push({ id: hashText(text), text: text.trim(), label, source, sourceLabel, provenance });
  };

  // 1. Convert existing gold
  const gold = readJsonl<{ text: string; label: Label }>(args.goldInput);
  for (const g of gold) {
    const bin = BINARY_LABEL[g.label];
    if (bin) add(g.text, bin, "gold", "reviewed", g.label);
    else exclude("unmapped_gold");
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
          add(text, bin, "pi_session", "heuristic", cls.label);
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
        add(text, bin, "claude_history", "heuristic", cls.label);
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
            add(text, bin, "claude_project", "heuristic", cls.label);
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
  const reviewed = rows.filter((row) => row.provenance === "reviewed").length;
  const heuristic = rows.length - reviewed;
  if (reviewed < args.minimumReviewed && !args.weakLabelResearch) {
    throw new Error(`Reviewed/gold minimum not met: ${reviewed}/${args.minimumReviewed}. Use --weak-label-research only for non-promotable research.`);
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const manifest: BinaryDatasetManifest = {
    schemaVersion: 1,
    datasetSha256: datasetSha256(args.output),
    mode: reviewed >= args.minimumReviewed ? "reviewed-training" : "weak-label-research",
    promotable: reviewed >= args.minimumReviewed,
    minimumReviewed: args.minimumReviewed,
    counts: { total: rows.length, reviewed, heuristic, conflicts, exclusions, sources: sourceCounts },
  };
  fs.writeFileSync(manifestPathFor(args.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`\n--- RESULT ---`);
  console.log(`total binary rows: ${rows.length}`);
  console.log(`binary counts: ${JSON.stringify(binCounts)}`);
  console.log(`source counts: ${JSON.stringify(sourceCounts)}`);
  console.log(`output: ${args.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; }
}
