import { basename, resolve } from "node:path";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { hashMaybe, hashText, normalizeText } from "./hash.js";
import type { SessionCommandEvent, SessionEventPointer, SessionRole, SessionToolResultEvent } from "./types.js";

export interface RawPiSessionEvent {
  index: number;
  byteStart: number;
  byteEnd: number;
  raw: Record<string, unknown>;
  rawLineHash: string;
  pointer: SessionEventPointer;
  role: SessionRole;
  textHash?: string;
  normalizedTextHash?: string;
  commandEvents: SessionCommandEvent[];
  toolResult?: SessionToolResultEvent;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface PiSession {
  id: string;
  path: string;
  cwd?: string;
  events: RawPiSessionEvent[];
}

export interface PiSessionReadOptions {
  fromByteStart?: number;
  startIndex?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function roleOf(raw: Record<string, unknown>): SessionRole {
  const message = asRecord(raw.message);
  const role = String(message?.role ?? "");
  if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") return role;
  return "unknown";
}

function textFromContent(content: unknown): string {
  const parts: string[] = [];
  for (const item of asArray(content)) {
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

function commandFromToolCallArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  const record = asRecord(args);
  const command = record?.command;
  return typeof command === "string" ? command : undefined;
}

function isVerifierCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)\b|\b(vitest|pytest|cargo\s+test|go\s+test|make\s+test|tsc\b)/i.test(command);
}

function normalizedErrorFingerprint(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, " <uuid> ")
    .replace(/0x[0-9a-f]+/g, " <addr> ")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, " <timestamp> ")
    .replace(/\b[\w./-]+\.(?:test\.)?(?:ts|tsx|js|jsx|json|md|yaml|yml|py|rs|go|css|scss|html|sh)(?::\d+)*(?:\b|$)/g, " <file> ")
    .replace(/(?:file:\/\/)?(?:\/[\w .-]+)+/g, " <path> ")
    .replace(/\bline\s+\d+\b/g, " line <n> ")
    .replace(/\bcolumn\s+\d+\b/g, " column <n> ")
    .replace(/\b\d+ms\b/g, " <duration> ")
    .replace(/\bport\s+\d+\b/g, " port <n> ")
    .replace(/\b\d+\b/g, " <n> ")
    .replace(/\s+/g, " ")
    .trim();
}

function exitCodeFromText(text: string): number | undefined {
  const match = text.match(/\b(?:exit(?:ed)?(?: with)? code|code)\s+([1-9]\d*)\b/i);
  return match ? Number(match[1]) : undefined;
}

function failingTestHashFromText(text: string): string | undefined {
  const match = text.match(/(?:FAIL|FAILED)\s+([^\n\r]+)/i) ?? text.match(/(?:test|it)\(["']([^"']+)["']/i);
  return match?.[1] ? hashText(normalizeText(match[1])) : undefined;
}

function commandEventsFromMessage(eventIndex: number, raw: Record<string, unknown>): SessionCommandEvent[] {
  const message = asRecord(raw.message);
  if (message?.role !== "assistant") return [];

  return asArray(message.content).flatMap((item) => {
    const record = asRecord(item);
    if (!record || record.type !== "toolCall") return [];
    const toolName = typeof record.name === "string" ? record.name : "unknown";
    const command = toolName === "bash" ? commandFromToolCallArgs(record.arguments) : undefined;
    return [{
      eventIndex,
      toolCallId: typeof record.id === "string" ? record.id : undefined,
      toolName,
      commandHash: command ? hashText(command) : undefined,
      normalizedCommandHash: command ? hashMaybe(command) : undefined,
      isVerifier: command ? isVerifierCommand(command) : false,
    } satisfies SessionCommandEvent];
  });
}

function toolResultFromMessage(eventIndex: number, raw: Record<string, unknown>): SessionToolResultEvent | undefined {
  const message = asRecord(raw.message);
  if (message?.role !== "toolResult") return undefined;
  const text = textFromContent(message.content);
  const isError = Boolean(message.isError) || /\b(error|failed|failure|traceback|exception|not found|enoent|command exited with code [1-9])\b/i.test(text);
  const fingerprint = isError && text ? normalizedErrorFingerprint(text) : "";
  return {
    eventIndex,
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
    toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    isError,
    outputHash: text ? hashText(text) : undefined,
    normalizedOutputHash: text ? hashMaybe(text) : undefined,
    errorHash: isError && text ? hashMaybe(text) : undefined,
    errorFingerprintHash: fingerprint ? hashText(fingerprint) : undefined,
    exitCode: text ? exitCodeFromText(text) : undefined,
    failingTestHash: text ? failingTestHashFromText(text) : undefined,
  };
}

function textHashes(raw: Record<string, unknown>): { textHash?: string; normalizedTextHash?: string } {
  const message = asRecord(raw.message);
  if (!message) return {};
  const text = textFromContent(message.content);
  if (!text) return {};
  return { textHash: hashText(text), normalizedTextHash: hashText(normalizeText(text)) };
}

function modelFrom(raw: Record<string, unknown>): { provider?: string; model?: string; usage?: Record<string, unknown> } {
  const message = asRecord(raw.message);
  return {
    provider: typeof raw.provider === "string" ? raw.provider : typeof message?.provider === "string" ? message.provider : undefined,
    model: typeof raw.modelId === "string" ? raw.modelId : typeof message?.model === "string" ? message.model : undefined,
    usage: asRecord(message?.usage),
  };
}

export function sessionIdFromPath(path: string): string {
  return basename(path).replace(/\.jsonl$/i, "");
}

export function parsePiSessionLine(line: string, index: number, byteStart: number, byteEnd: number): RawPiSessionEvent {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const role = roleOf(raw);
  const model = modelFrom(raw);
  return {
    index,
    byteStart,
    byteEnd,
    raw,
    rawLineHash: hashText(line),
    pointer: {
      index,
      byteStart,
      byteEnd,
      id: typeof raw.id === "string" ? raw.id : undefined,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      role,
    },
    role,
    ...textHashes(raw),
    commandEvents: commandEventsFromMessage(index, raw),
    toolResult: toolResultFromMessage(index, raw),
    ...model,
  };
}

export async function* streamPiSessionEvents(path: string, options: PiSessionReadOptions = {}): AsyncGenerator<RawPiSessionEvent> {
  const resolved = resolve(path);
  const fromByteStart = Math.max(0, Math.floor(options.fromByteStart ?? 0));
  const input = createReadStream(resolved, { encoding: "utf8", start: fromByteStart > 0 ? fromByteStart : undefined });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = options.startIndex ?? 0;
  let byteStart = fromByteStart;
  for await (const line of lines) {
    const byteEnd = byteStart + Buffer.byteLength(`${line}\n`);
    if (line.trim()) {
      yield parsePiSessionLine(line, index, byteStart, byteEnd);
      index++;
    }
    byteStart = byteEnd;
  }
}

export function readPiSession(path: string): PiSession {
  const resolved = resolve(path);
  const rawBuffer = readFileSync(resolved);
  const text = rawBuffer.toString("utf8");
  const events: RawPiSessionEvent[] = [];
  let byteStart = 0;
  let cwd: string | undefined;

  for (const line of text.split(/(?<=\n)/)) {
    const withoutNewline = line.endsWith("\n") ? line.slice(0, -1) : line;
    const byteEnd = byteStart + Buffer.byteLength(line);
    if (withoutNewline.trim()) {
      const event = parsePiSessionLine(withoutNewline, events.length, byteStart, byteEnd);
      if (event.raw.type === "session" && typeof event.raw.cwd === "string") cwd = event.raw.cwd;
      events.push(event);
    }
    byteStart = byteEnd;
  }

  return { id: sessionIdFromPath(resolved), path: resolved, cwd, events };
}
