#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { hashText, type Label } from "./routing-heuristics.js";
import { iterateCheckpoints } from "../packages/router/src/checkpoints.js";
import { readPiSession } from "../packages/router/src/session-reader.js";

interface TrajectoryRow {
  id: string;
  text: string;
  label: "escalate" | "continue";
  source: string;
  sourceLabel?: Label;
  cwd?: string;
  sessionId?: string;
  sessionFile?: string;
  eventIndex?: number;
  checkpointId?: string;
  trajectory?: {
    loopScore?: number;
    progressScore?: number;
    sameErrorRepeatedCount?: number;
    diffLines?: number;
    contextTokensApprox?: number;
    turns?: number;
    phase?: "preflight" | "review" | "closeout";
    failed?: boolean;
    fileChanged?: boolean;
  };
}

interface LabelRow {
  id: string;
  text: string;
  label: "escalate" | "continue";
  source: string;
  sourceLabel?: Label;
  cwd?: string;
  weight?: number;
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
    input: String(args.input || path.join(process.env.HOME || "/tmp", ".pi", "agent", "sessions")),
    labels: String(args.labels || path.join(process.cwd(), "data", "routing", "binary-gate.jsonl")),
    output: String(args.output || path.join(process.cwd(), "data", "routing", "binary-gate-trajectory.jsonl")),
    report: String(args.report || path.join(process.cwd(), "data", "routing", "binary-gate-trajectory-report.json")),
    limit: Number(args.limit || 0) || 0,
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

function trajectoryFromCheckpoint(checkpoint: ReturnType<typeof iterateCheckpoints> extends Generator<infer T> ? T : never): NonNullable<TrajectoryRow["trajectory"]> {
  const f = checkpoint.features;
  return {
    loopScore: f.loopScore,
    progressScore: f.progressScore,
    sameErrorRepeatedCount: f.sameErrorRepeatedCount,
    diffLines: f.diffLines,
    contextTokensApprox: f.contextTokensApprox ?? undefined,
    turns: f.turnIndex,
    phase: checkpoint.phase === "unknown" ? undefined : checkpoint.phase,
    failed: Boolean((checkpoint.recent.lastErrorHash ?? checkpoint.recent.lastErrorFingerprintHash) && f.sameErrorRepeatedCount > 0),
    fileChanged: Boolean(f.diffLines > 0 || f.diffFilesChanged > 0 || f.filesTouched > 0),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const labelRows = readJsonl<LabelRow>(args.labels);
  const sessionFiles = walkJsonlFiles(args.input);
  const trajectoryById = new Map<string, Omit<TrajectoryRow, "id" | "text" | "label" | "source" | "sourceLabel" | "cwd">>();
  const scanStats = { files: 0, checkpoints: 0, userTurns: 0, matched: 0 };
  const phaseCounts: Record<string, number> = {};

  for (const file of sessionFiles) {
    if (args.limit > 0 && scanStats.userTurns >= args.limit) break;
    let session;
    try {
      session = readPiSession(file);
    } catch {
      continue;
    }
    scanStats.files++;

    for (const checkpoint of iterateCheckpoints(session)) {
      scanStats.checkpoints++;
      const event = session.events[checkpoint.sourceEvent.index];
      if (!event || event.role !== "user") continue;
      const rawEvent = event.raw as Record<string, unknown>;
      const message = rawEvent.message as Record<string, unknown> | undefined;
      const text = textFromContent(message?.content);
      if (!text) continue;

      const id = hashText(text);
      if (!trajectoryById.has(id)) {
        trajectoryById.set(id, {
          sessionId: session.id,
          sessionFile: file,
          eventIndex: checkpoint.sourceEvent.index,
          checkpointId: checkpoint.checkpointId,
          trajectory: trajectoryFromCheckpoint(checkpoint),
        });
      }
      scanStats.userTurns++;
      const phase = checkpoint.phase === "unknown" ? "unknown" : checkpoint.phase;
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    }
  }

  const enriched: TrajectoryRow[] = labelRows.map((row) => {
    const match = trajectoryById.get(row.id);
    if (match) scanStats.matched++;
    return {
      ...row,
      sessionId: match?.sessionId,
      sessionFile: match?.sessionFile,
      eventIndex: match?.eventIndex,
      checkpointId: match?.checkpointId,
      trajectory: match?.trajectory,
    };
  });

  const labelCounts = enriched.reduce<Record<string, number>>((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, {});
  const sourceCounts = enriched.reduce<Record<string, number>>((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});
  const coverage = enriched.length > 0 ? scanStats.matched / enriched.length : 0;
  const trajectoryCoverage = enriched.length > 0 ? {
    withLoopScore: enriched.filter((row) => typeof row.trajectory?.loopScore === "number").length,
    withProgressScore: enriched.filter((row) => typeof row.trajectory?.progressScore === "number").length,
    withSameErrorRepeatedCount: enriched.filter((row) => typeof row.trajectory?.sameErrorRepeatedCount === "number").length,
    withDiffLines: enriched.filter((row) => typeof row.trajectory?.diffLines === "number").length,
    withContextTokensApprox: enriched.filter((row) => typeof row.trajectory?.contextTokensApprox === "number").length,
  } : {
    withLoopScore: 0,
    withProgressScore: 0,
    withSameErrorRepeatedCount: 0,
    withDiffLines: 0,
    withContextTokensApprox: 0,
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, enriched.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  fs.writeFileSync(args.report, `${JSON.stringify({
    labels: args.labels,
    input: args.input,
    output: args.output,
    files: scanStats.files,
    checkpoints: scanStats.checkpoints,
    userTurns: scanStats.userTurns,
    labelRows: labelRows.length,
    matched: scanStats.matched,
    coverage,
    labelCounts,
    sourceCounts,
    phaseCounts,
    trajectoryCoverage,
  }, null, 2)}\n`, "utf8");

  console.log(`label rows: ${labelRows.length}`);
  console.log(`session files: ${scanStats.files}`);
  console.log(`checkpoints scanned: ${scanStats.checkpoints}`);
  console.log(`user turns scanned: ${scanStats.userTurns}`);
  console.log(`matched trajectory rows: ${scanStats.matched}`);
  console.log(`coverage: ${(coverage * 100).toFixed(1)}%`);
  console.log(`labels: ${JSON.stringify(labelCounts)}`);
  console.log(`sources: ${JSON.stringify(sourceCounts)}`);
  console.log(`phases: ${JSON.stringify(phaseCounts)}`);
  console.log(`output: ${args.output}`);
  console.log(`report: ${args.report}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
}
