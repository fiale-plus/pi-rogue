import { hashText } from "./hash.js";
import type { RawPiSessionEvent } from "./session-reader.js";
import type { ProgressSignals } from "./types.js";

const FILE_PATH_RE = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|py|rs|go|css|scss|html|sh))(?:\s|$|:)/g;

export function touchedFileHashesFromEvent(event: RawPiSessionEvent): string[] {
  const files = new Set<string>();
  const rawMessage = event.raw.message;
  if (!rawMessage || typeof rawMessage !== "object") return [];
  const content = (rawMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const args = record.arguments;
    const command = args && typeof args === "object" ? (args as Record<string, unknown>).command : undefined;
    if (typeof command !== "string") continue;
    for (const match of command.matchAll(FILE_PATH_RE)) files.add(match[1]);
  }
  return [...files].sort().map((file) => hashText(file));
}

export function touchedFileHashes(events: RawPiSessionEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    for (const fileHash of touchedFileHashesFromEvent(event)) files.add(fileHash);
  }
  return [...files].sort();
}

function consecutiveRepeatCount<T>(items: T[], valueOf: (item: T) => string | undefined): number {
  let last: string | undefined;
  let count = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const value = valueOf(items[index]);
    if (!value) continue;
    if (last === undefined) {
      last = value;
      count = 1;
      continue;
    }
    if (value !== last) break;
    count++;
  }
  return count;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function computeProgressSignals(events: RawPiSessionEvent[]): ProgressSignals {
  const commandEvents = events.flatMap((event) => event.commandEvents);
  const toolResults = events.flatMap((event) => event.toolResult ? [event.toolResult] : []);
  const errorResults = toolResults.filter((result) => result.isError && result.errorHash);
  const sameCommandRepeatedCount = consecutiveRepeatCount(commandEvents, (event) => event.normalizedCommandHash);
  const sameErrorRepeatedCount = consecutiveRepeatCount(errorResults, (event) => event.errorHash);
  const verifierUsed = commandEvents.some((event) => event.isVerifier);
  const recentCommands = commandEvents.slice(-10);
  const uniqueRecentCommands = new Set(recentCommands.map((event) => event.normalizedCommandHash).filter(Boolean));
  const fileHashes = touchedFileHashes(events);

  const commandRepeatPressure = clamp01((sameCommandRepeatedCount - 1) / 3);
  const errorRepeatPressure = clamp01((sameErrorRepeatedCount - 1) / 3);
  const toolThrashScore = recentCommands.length === 0 ? 0 : clamp01(1 - uniqueRecentCommands.size / recentCommands.length);
  const noVerifierUsed = fileHashes.length > 0 && commandEvents.length >= 4 && !verifierUsed;
  const noVerifierPressure = noVerifierUsed ? 0.2 : 0;
  const loopScore = clamp01(commandRepeatPressure * 0.35 + errorRepeatPressure * 0.4 + toolThrashScore * 0.2 + noVerifierPressure);
  const progressScore = clamp01(1 - loopScore - (noVerifierUsed ? 0.1 : 0));
  const lastError = errorResults.at(-1)?.errorHash;
  const previousError = errorResults.at(-2)?.errorHash;

  return {
    sameCommandRepeatedCount,
    sameErrorRepeatedCount,
    errorChanged: Boolean(lastError && previousError && lastError !== previousError),
    testsImproved: null,
    filesTouched: fileHashes.length,
    diffLines: 0,
    diffFilesChanged: 0,
    diffLinesAdded: 0,
    diffLinesDeleted: 0,
    diffChurnScore: 0,
    toolThrashScore,
    goalDriftScore: 0,
    loopScore,
    progressScore,
    verifierUsed,
    noVerifierUsed,
    toolCallsLast10Turns: recentCommands.length,
  };
}
