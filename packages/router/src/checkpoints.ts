import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashMaybe, hashText, normalizeText } from "./hash.js";
import { routerSessionKey } from "./config.js";
import { diffChurnScore, EMPTY_DIFF_STATS, readGitDiffStats } from "./git-features.js";
import { touchedFileHashesFromEvent } from "./progress.js";
import { readPiSession, sessionIdFromPath, streamPiSessionEvents, type PiSession, type RawPiSessionEvent } from "./session-reader.js";
import { RAW_SESSION_REF_SCHEMA, ROUTER_CHECKPOINT_SCHEMA, type ProgressSignals, type RawSessionRef, type RouterCheckpoint, type SessionCommandEvent, type SessionToolResultEvent } from "./types.js";

function textFromEvent(event: RawPiSessionEvent): string {
  const message = event.raw.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function phaseFromText(text: string): RouterCheckpoint["phase"] {
  const normalized = normalizeText(text);
  if (/\b(debug|bug|error|fail(?:ed|ing|ure)?|broken|crash|traceback|stack)\b/.test(normalized)) return "debug";
  if (/\b(review|diff|pr|pull request|audit|looks good)\b/.test(normalized)) return "review";
  if (/\b(research|docs?|look up|what is|compare|benchmark)\b/.test(normalized)) return "research";
  if (/\b(install|config|configure|status|logs?|deploy|environment|shell)\b/.test(normalized)) return "ops";
  if (/\b(plan|design|architecture|strategy|scope)\b/.test(normalized)) return "planning";
  if (/\b(implement|build|add|edit|refactor|fix|write|change)\b/.test(normalized)) return "implementation";
  return "unknown";
}

function contextTokensFromUsage(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null;
  const candidates = ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "totalTokens", "total_tokens"];
  for (const key of candidates) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

interface SessionContext {
  id: string;
  path: string;
  cwd?: string;
}

function rawSessionRef(session: SessionContext, refEvents: RawPiSessionEvent[], last: RawPiSessionEvent | undefined): RawSessionRef {
  const first = refEvents[0];
  const fromByte = first?.byteStart ?? 0;
  const toByte = last?.byteEnd ?? 0;
  return {
    schema: RAW_SESSION_REF_SCHEMA,
    path: session.path,
    fromEvent: first?.index ?? 0,
    toEvent: last?.index ?? 0,
    fromByte,
    toByte,
    contentHash: hashText(...refEvents.map((event) => event.rawLineHash)),
  };
}

function repoHashFromCwd(cwd?: string): string | undefined {
  return cwd ? hashText(resolve(cwd)) : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const RAW_REF_EVENT_WINDOW = 30;

interface BuildState {
  activeModel?: string;
  provider?: string;
  contextTokensApprox: number | null;
  lastUserGoalHash?: string;
  phase: RouterCheckpoint["phase"];
  lastCommandHash?: string;
  sameCommandRepeatedCount: number;
  lastErrorHash?: string;
  previousErrorHash?: string;
  lastErrorFingerprintHash?: string;
  previousErrorFingerprintHash?: string;
  sameErrorRepeatedCount: number;
  verifierUsed: boolean;
  commandCount: number;
  recentCommands: string[];
  touchedFileHashes: Set<string>;
  diffStats: import("./types.js").DiffStats;
}

function updateCommandState(state: BuildState, command: SessionCommandEvent): void {
  if (command.normalizedCommandHash) {
    if (state.lastCommandHash === command.normalizedCommandHash) state.sameCommandRepeatedCount++;
    else state.sameCommandRepeatedCount = 1;
    state.lastCommandHash = command.normalizedCommandHash;
    state.recentCommands.push(command.normalizedCommandHash);
    state.recentCommands = state.recentCommands.slice(-10);
  }
  state.commandCount++;
  state.verifierUsed = state.verifierUsed || command.isVerifier;
}

function updateToolResultState(state: BuildState, result: SessionToolResultEvent): void {
  const errorKey = result.errorFingerprintHash ?? result.errorHash;
  if (!errorKey) return;
  state.previousErrorHash = state.lastErrorHash;
  state.previousErrorFingerprintHash = state.lastErrorFingerprintHash;
  if ((state.lastErrorFingerprintHash ?? state.lastErrorHash) === errorKey) state.sameErrorRepeatedCount++;
  else state.sameErrorRepeatedCount = 1;
  state.lastErrorHash = result.errorHash;
  state.lastErrorFingerprintHash = result.errorFingerprintHash;
}

function signalsFromState(state: BuildState): ProgressSignals {
  const uniqueRecentCommands = new Set(state.recentCommands);
  const commandRepeatPressure = clamp01((state.sameCommandRepeatedCount - 1) / 3);
  const errorRepeatPressure = clamp01((state.sameErrorRepeatedCount - 1) / 3);
  const toolThrashScore = state.recentCommands.length === 0 ? 0 : clamp01(1 - uniqueRecentCommands.size / state.recentCommands.length);
  const changedFiles = state.touchedFileHashes.size + state.diffStats.filesChanged;
  const phaseWantsVerifier = state.phase === "implementation" || state.phase === "debug" || state.phase === "review";
  const noVerifierUsed = phaseWantsVerifier && changedFiles > 0 && state.commandCount >= 4 && !state.verifierUsed;
  const noVerifierPressure = noVerifierUsed ? 0.2 : 0;
  const loopScore = clamp01(commandRepeatPressure * 0.35 + errorRepeatPressure * 0.4 + toolThrashScore * 0.2 + noVerifierPressure);
  const progressScore = clamp01(1 - loopScore - (noVerifierUsed ? 0.1 : 0));
  return {
    sameCommandRepeatedCount: state.sameCommandRepeatedCount,
    sameErrorRepeatedCount: state.sameErrorRepeatedCount,
    errorChanged: Boolean(
      (state.lastErrorFingerprintHash ?? state.lastErrorHash)
      && (state.previousErrorFingerprintHash ?? state.previousErrorHash)
      && (state.lastErrorFingerprintHash ?? state.lastErrorHash) !== (state.previousErrorFingerprintHash ?? state.previousErrorHash),
    ),
    testsImproved: null,
    filesTouched: state.touchedFileHashes.size,
    diffLines: state.diffStats.totalLines,
    diffFilesChanged: state.diffStats.filesChanged,
    diffLinesAdded: state.diffStats.linesAdded,
    diffLinesDeleted: state.diffStats.linesDeleted,
    diffChurnScore: diffChurnScore(state.diffStats),
    toolThrashScore,
    goalDriftScore: 0,
    loopScore,
    progressScore,
    verifierUsed: state.verifierUsed,
    noVerifierUsed,
    toolCallsLast10Turns: state.recentCommands.length,
  };
}

function checkpointFromState(session: SessionContext, event: RawPiSessionEvent, refEvents: RawPiSessionEvent[], state: BuildState): RouterCheckpoint {
  const signals = signalsFromState(state);
  return {
    schema: ROUTER_CHECKPOINT_SCHEMA,
    sessionId: session.id,
    checkpointId: `${session.id}:event-${event.index}`,
    createdAt: new Date().toISOString(),
    rawSessionRef: rawSessionRef(session, refEvents, event),
    harness: "pi",
    repoHash: repoHashFromCwd(session.cwd),
    goalHash: state.lastUserGoalHash,
    phase: state.phase,
    activeModel: state.activeModel,
    provider: state.provider,
    features: {
      ...signals,
      turnIndex: event.index,
      contextTokensApprox: state.contextTokensApprox,
      gitDirty: null,
    },
    recent: {
      lastUserGoalHash: state.lastUserGoalHash,
      lastCommandHash: state.lastCommandHash,
      lastErrorHash: state.lastErrorHash,
      lastErrorFingerprintHash: state.lastErrorFingerprintHash,
      touchedFileHashes: [...state.touchedFileHashes].sort(),
      diffFileHashes: state.diffStats.fileHashes,
    },
    sourceEvent: event.pointer,
  };
}

function initialBuildState(): BuildState {
  return {
    contextTokensApprox: null,
    phase: "unknown",
    sameCommandRepeatedCount: 0,
    sameErrorRepeatedCount: 0,
    verifierUsed: false,
    commandCount: 0,
    recentCommands: [],
    touchedFileHashes: new Set(),
    diffStats: EMPTY_DIFF_STATS,
  };
}

function updateStateFromEvent(state: BuildState, event: RawPiSessionEvent): void {
  state.activeModel = event.model ?? state.activeModel;
  state.provider = event.provider ?? state.provider;
  state.contextTokensApprox = contextTokensFromUsage(event.usage) ?? state.contextTokensApprox;

  if (event.role === "user") {
    const text = textFromEvent(event);
    state.lastUserGoalHash = hashMaybe(text);
    state.phase = phaseFromText(text);
  }
  for (const fileHash of touchedFileHashesFromEvent(event)) state.touchedFileHashes.add(fileHash);
  for (const command of event.commandEvents) updateCommandState(state, command);
  if (event.toolResult) updateToolResultState(state, event.toolResult);
}

function isCheckpointEvent(event: RawPiSessionEvent): boolean {
  return event.role === "user" || event.role === "assistant" || event.role === "toolResult";
}

function pushRefWindow(refEvents: RawPiSessionEvent[], event: RawPiSessionEvent): void {
  refEvents.push(event);
  if (refEvents.length > RAW_REF_EVENT_WINDOW) refEvents.shift();
}

export function* iterateCheckpoints(session: PiSession): Generator<RouterCheckpoint> {
  const state = initialBuildState();
  const refEvents: RawPiSessionEvent[] = [];
  for (const event of session.events) {
    pushRefWindow(refEvents, event);
    updateStateFromEvent(state, event);
    if (!isCheckpointEvent(event)) continue;
    yield checkpointFromState(session, event, refEvents, state);
  }
}

export async function* streamCheckpointsFromSessionPath(sessionPath: string): AsyncGenerator<RouterCheckpoint> {
  const session: SessionContext = { id: sessionIdFromPath(resolve(sessionPath)), path: resolve(sessionPath) };
  const state = initialBuildState();
  const refEvents: RawPiSessionEvent[] = [];
  for await (const event of streamPiSessionEvents(session.path)) {
    if (event.raw.type === "session" && typeof event.raw.cwd === "string") session.cwd = event.raw.cwd;
    pushRefWindow(refEvents, event);
    updateStateFromEvent(state, event);
    if (!isCheckpointEvent(event)) continue;
    yield checkpointFromState(session, event, refEvents, state);
  }
}

function clampFeature(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

export function checkpointWithDiffStats(checkpoint: RouterCheckpoint, cwd?: string, excludePaths: string[] = []): RouterCheckpoint {
  const stats = readGitDiffStats(cwd, { excludePaths });
  if (stats.filesChanged === 0) return checkpoint;
  const phaseWantsVerifier = checkpoint.phase === "implementation" || checkpoint.phase === "debug" || checkpoint.phase === "review";
  const noVerifierUsed = checkpoint.features.noVerifierUsed
    || (phaseWantsVerifier && !checkpoint.features.verifierUsed && checkpoint.features.toolCallsLast10Turns >= 4);
  const loopScore = noVerifierUsed && !checkpoint.features.noVerifierUsed
    ? clampFeature(checkpoint.features.loopScore + 0.2)
    : checkpoint.features.loopScore;
  const progressScore = noVerifierUsed && !checkpoint.features.noVerifierUsed
    ? clampFeature(checkpoint.features.progressScore - 0.1)
    : checkpoint.features.progressScore;
  return {
    ...checkpoint,
    features: {
      ...checkpoint.features,
      diffLines: stats.totalLines,
      diffFilesChanged: stats.filesChanged,
      diffLinesAdded: stats.linesAdded,
      diffLinesDeleted: stats.linesDeleted,
      diffChurnScore: diffChurnScore(stats),
      noVerifierUsed,
      loopScore,
      progressScore,
    },
    recent: { ...checkpoint.recent, diffFileHashes: stats.fileHashes },
  };
}

function applyWorkspaceDiffToLatest(checkpoints: RouterCheckpoint[], cwd?: string, excludePaths: string[] = []): RouterCheckpoint[] {
  if (checkpoints.length === 0) return checkpoints;
  const next = [...checkpoints];
  next[next.length - 1] = checkpointWithDiffStats(next[next.length - 1], cwd, excludePaths);
  return next;
}

export function buildCheckpoints(session: PiSession): RouterCheckpoint[] {
  return [...iterateCheckpoints(session)];
}

export function rebuildCheckpointsFromSession(sessionPath: string): RouterCheckpoint[] {
  return buildCheckpoints(readPiSession(sessionPath));
}

export function writeCheckpointsJsonl(checkpoints: RouterCheckpoint[], outputPath: string): void {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const fd = openSync(resolved, "w");
  try {
    for (const checkpoint of checkpoints) writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface SessionCheckpointWriteSummary {
  sessions: string[];
  output: string;
  checkpoints: number;
  firstCheckpointId?: string;
  lastCheckpointId?: string;
}

export async function writeSessionCheckpointsJsonl(sessionPaths: string[], outputPath: string, options: { workspaceDiff?: boolean } = {}): Promise<SessionCheckpointWriteSummary> {
  if (options.workspaceDiff && sessionPaths.length !== 1) {
    throw new Error("--workspace-diff can only be used with exactly one current session");
  }

  const resolved = resolve(outputPath);
  // Compute live workspace diff before opening/truncating the output so the output artifact cannot count itself.
  const workspaceDiffCheckpoints = options.workspaceDiff
    ? (() => {
      const session = readPiSession(sessionPaths[0]);
      const routerDir = session.cwd ? resolve(session.cwd, ".pi", "router") : undefined;
      const routerSessionDir = routerDir ? resolve(routerDir, "sessions", routerSessionKey(session.path)) : undefined;
      const routerArtifacts = routerDir ? [
        routerDir,
        resolve(routerDir, "config.json"),
        resolve(routerDir, "state.json"),
        resolve(routerDir, "events.jsonl"),
        ...(routerSessionDir ? [resolve(routerSessionDir, "state.json"), resolve(routerSessionDir, "events.jsonl")] : []),
      ] : [];
      return applyWorkspaceDiffToLatest(buildCheckpoints(session), session.cwd, [session.path, resolved, ...routerArtifacts]);
    })()
    : null;
  mkdirSync(dirname(resolved), { recursive: true });
  const fd = openSync(resolved, "w");
  let checkpoints = 0;
  let firstCheckpointId: string | undefined;
  let lastCheckpointId: string | undefined;
  try {
    if (workspaceDiffCheckpoints) {
      for (const checkpoint of workspaceDiffCheckpoints) {
        firstCheckpointId ??= checkpoint.checkpointId;
        lastCheckpointId = checkpoint.checkpointId;
        checkpoints++;
        writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
      }
    } else {
      for (const sessionPath of sessionPaths) {
        for await (const checkpoint of streamCheckpointsFromSessionPath(sessionPath)) {
          firstCheckpointId ??= checkpoint.checkpointId;
          lastCheckpointId = checkpoint.checkpointId;
          checkpoints++;
          writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  return { sessions: sessionPaths, output: resolved, checkpoints, firstCheckpointId, lastCheckpointId };
}
