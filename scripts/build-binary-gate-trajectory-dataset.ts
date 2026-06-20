#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { hashText, type Label } from "./routing-heuristics.js";
import { iterateCheckpoints } from "../packages/router/src/checkpoints.js";
import { readPiSession } from "../packages/router/src/session-reader.js";

interface TrajectoryFeaturesJson {
  loopScore?: number;
  progressScore?: number;
  sameErrorRepeatedCount?: number;
  diffLines?: number;
  contextTokensApprox?: number;
  turns?: number;
  phase?: "preflight" | "review" | "closeout";
  failed?: boolean;
  fileChanged?: boolean;
}

interface TrajectoryRow {
  id: string;
  text: string;
  label: "escalate" | "continue";
  source: string;
  sourceLabel?: Label;
  cwd?: string;
  weight?: number;
  sessionId?: string;
  sessionFile?: string;
  eventIndex?: number;
  checkpointId?: string;
  trajectory?: TrajectoryFeaturesJson;
  trajectorySource?: "pi_router" | "claude_history_proxy";
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

interface TrajectoryMatch {
  sessionId?: string;
  sessionFile?: string;
  eventIndex?: number;
  checkpointId?: string;
  trajectory: TrajectoryFeaturesJson;
  trajectorySource: "pi_router" | "claude_history_proxy";
}

const DEBUG_RE = /\b(debug|bug|error|fail(?:ed|ing|ure)?|broken|crash|traceback|stack|cannot|can't)\b/i;
const STUCK_RE = /\b(stuck|looping|spinning|no[- ]?progress|blocked|same failure|repeated)\b/i;
const PROGRESS_RE = /\b(done|fixed|implemented|works?|passing|complete|merged|success|ok|nice|ship|continue)\b/i;

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
    claudeHistory: String(args["claude-history"] || path.join(process.env.HOME || "/tmp", ".claude", "history.jsonl")),
    noClaudeProxy: Boolean(args["no-claude-proxy"]),
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

function trajectoryFromCheckpoint(checkpoint: ReturnType<typeof iterateCheckpoints> extends Generator<infer T> ? T : never): TrajectoryFeaturesJson {
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

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function textFromClaudeHistory(row: Record<string, unknown>): string {
  return String(row.display || row.content || row.text || row.prompt || "").trim();
}

function buildClaudeHistoryProxy(file: string): Map<string, TrajectoryMatch> {
  const rows = readJsonl<Record<string, unknown>>(file)
    .map((row) => ({
      sessionId: String(row.sessionId || ""),
      timestamp: Number(row.timestamp || 0),
      project: typeof row.project === "string" ? row.project : undefined,
      text: textFromClaudeHistory(row),
    }))
    .filter((row) => row.text)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.timestamp - b.timestamp);

  const byId = new Map<string, TrajectoryMatch>();
  const state = new Map<string, { turn: number; lastText: string; repeat: number; debugRun: number; cumulativeTokens: number }>();

  for (const row of rows) {
    const s = state.get(row.sessionId) ?? { turn: 0, lastText: "", repeat: 0, debugRun: 0, cumulativeTokens: 0 };
    const normalized = normalizeText(row.text);
    s.turn += 1;
    s.cumulativeTokens += Math.max(1, row.text.split(/\s+/).filter(Boolean).length);
    s.repeat = normalized && normalized === s.lastText ? s.repeat + 1 : 1;
    s.lastText = normalized;

    const failed = DEBUG_RE.test(row.text) || STUCK_RE.test(row.text);
    s.debugRun = failed ? s.debugRun + 1 : 0;
    const loopScore = Math.min(1, Math.max(0, (s.repeat - 1) / 3) + (STUCK_RE.test(row.text) ? 0.45 : 0) + (s.debugRun > 1 ? 0.25 : 0));
    const progressScore = STUCK_RE.test(row.text)
      ? 0.15
      : failed
        ? 0.35
        : PROGRESS_RE.test(row.text)
          ? 0.9
          : 0.85;

    byId.set(hashText(row.text), {
      sessionId: row.sessionId || undefined,
      trajectorySource: "claude_history_proxy",
      trajectory: {
        loopScore,
        progressScore,
        sameErrorRepeatedCount: failed ? s.debugRun : 0,
        diffLines: 0,
        contextTokensApprox: Math.round(s.cumulativeTokens * 1.3),
        turns: s.turn,
        failed,
        fileChanged: false,
      },
    });
    state.set(row.sessionId, s);
  }

  return byId;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const labelRows = readJsonl<LabelRow>(args.labels);
  const sessionFiles = walkJsonlFiles(args.input);
  const trajectoryById = new Map<string, TrajectoryMatch>();
  const scanStats = { files: 0, checkpoints: 0, userTurns: 0, piRouterMatches: 0, claudeProxyMatches: 0 };
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
          trajectorySource: "pi_router",
        });
      }
      scanStats.userTurns++;
      const phase = checkpoint.phase === "unknown" ? "unknown" : checkpoint.phase;
      phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    }
  }

  const claudeProxy = args.noClaudeProxy ? new Map<string, TrajectoryMatch>() : buildClaudeHistoryProxy(args.claudeHistory);

  const enriched: TrajectoryRow[] = labelRows.map((row) => {
    let match = trajectoryById.get(row.id);
    if (match) scanStats.piRouterMatches++;
    if (!match) {
      match = claudeProxy.get(row.id);
      if (match) scanStats.claudeProxyMatches++;
    }
    return {
      ...row,
      sessionId: match?.sessionId,
      sessionFile: match?.sessionFile,
      eventIndex: match?.eventIndex,
      checkpointId: match?.checkpointId,
      trajectory: match?.trajectory,
      trajectorySource: match?.trajectorySource,
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
  const trajectorySourceCounts = enriched.reduce<Record<string, number>>((acc, row) => {
    const key = row.trajectorySource || "missing";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const matched = scanStats.piRouterMatches + scanStats.claudeProxyMatches;
  const coverage = enriched.length > 0 ? matched / enriched.length : 0;
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
    claudeHistory: args.claudeHistory,
    output: args.output,
    files: scanStats.files,
    checkpoints: scanStats.checkpoints,
    userTurns: scanStats.userTurns,
    labelRows: labelRows.length,
    matched,
    piRouterMatches: scanStats.piRouterMatches,
    claudeProxyMatches: scanStats.claudeProxyMatches,
    coverage,
    labelCounts,
    sourceCounts,
    trajectorySourceCounts,
    phaseCounts,
    trajectoryCoverage,
  }, null, 2)}\n`, "utf8");

  console.log(`label rows: ${labelRows.length}`);
  console.log(`session files: ${scanStats.files}`);
  console.log(`checkpoints scanned: ${scanStats.checkpoints}`);
  console.log(`user turns scanned: ${scanStats.userTurns}`);
  console.log(`matched trajectory rows: ${matched}`);
  console.log(`pi router matches: ${scanStats.piRouterMatches}`);
  console.log(`claude proxy matches: ${scanStats.claudeProxyMatches}`);
  console.log(`coverage: ${(coverage * 100).toFixed(1)}%`);
  console.log(`labels: ${JSON.stringify(labelCounts)}`);
  console.log(`sources: ${JSON.stringify(sourceCounts)}`);
  console.log(`trajectory sources: ${JSON.stringify(trajectorySourceCounts)}`);
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
