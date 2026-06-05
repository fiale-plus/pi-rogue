import { createHash } from "node:crypto";
import { safeName } from "./text.js";

export type ContextArtifactKind =
  | "tool_output"
  | "diff"
  | "file_snapshot"
  | "subagent_result"
  | "advisor_brief"
  | "memory_note";

export interface ContextArtifactInput {
  sessionId: string;
  kind: ContextArtifactKind;
  payload: string | Buffer;
  summary?: string;
  tags?: string[];
  paths?: string[];
  command?: string;
  branch?: string;
  ttlMs?: number;
  pinned?: boolean;
  parentIds?: string[];
  createdAt?: number;
}

export interface ContextArtifact {
  id: string;
  handle: string;
  sessionId: string;
  kind: ContextArtifactKind;
  createdAt: number;
  updatedAt: number;
  bytes: number;
  sha256: string;
  payload: string;
  summary: string;
  tags: string[];
  paths: string[];
  command?: string;
  branch?: string;
  expiresAt?: number;
  pinned: boolean;
  parentIds: string[];
}

export interface ContextLookupQuery {
  id?: string;
  handle?: string;
  sessionId?: string;
  kind?: ContextArtifactKind;
  tag?: string;
  path?: string;
  commandPrefix?: string;
  branch?: string;
  text?: string;
  limit?: number;
}

export interface ContextBrokerStatus {
  records: number;
  bytes: number;
  pinnedRecords: number;
  pinnedBytes: number;
  maxRecords: number;
  maxBytes: number;
}

export interface ContextBrokerOptions {
  maxRecords?: number;
  maxBytes?: number;
  defaultTtlMs?: number;
  summaryBytes?: number;
  briefBytes?: number;
}

export interface BoundedContextBroker {
  publish(input: ContextArtifactInput): ContextArtifact;
  lookup(query?: ContextLookupQuery): ContextArtifact[];
  pin(idOrHandle: string, pinned?: boolean): ContextArtifact | null;
  prune(now?: number): ContextBrokerStatus;
  status(): ContextBrokerStatus;
  renderBrief(query?: ContextLookupQuery & { budgetBytes?: number }): string;
}

const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_BYTES = 320;
const DEFAULT_BRIEF_BYTES = 2_000;

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function payloadText(payload: string | Buffer): string {
  return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
}

function payloadBytes(payload: string | Buffer): number {
  return Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload ?? ""), "utf8");
}

function hashPayload(payload: string | Buffer): string {
  return createHash("sha256").update(Buffer.isBuffer(payload) ? payload : String(payload)).digest("hex");
}

function normalizeNeedle(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function truncateUtf8(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  if (limit === 0) return "";

  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const contentLimit = Math.max(0, limit - ellipsisBytes);
  let used = 0;
  let result = "";

  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > contentLimit) break;
    result += char;
    used += bytes;
  }

  if (Buffer.byteLength(result + ellipsis, "utf8") <= limit) return result + ellipsis;
  return result;
}

function summarizeArtifact(summary: string | undefined, kind: ContextArtifactKind, bytes: number, sha256: string, maxBytes: number): string {
  const cleaned = String(summary ?? "").replace(/\s+/g, " ").trim();
  if (cleaned) return truncateUtf8(cleaned, maxBytes);
  return truncateUtf8(`[${kind} payload stored externally; ${bytes} bytes; sha256=${sha256.slice(0, 16)}]`, maxBytes);
}

function artifactMatches(artifact: ContextArtifact, query: ContextLookupQuery): boolean {
  if (query.id && artifact.id !== query.id) return false;
  if (query.handle && artifact.handle !== query.handle) return false;
  if (query.sessionId && artifact.sessionId !== query.sessionId) return false;
  if (query.kind && artifact.kind !== query.kind) return false;
  if (query.branch && artifact.branch !== query.branch) return false;
  if (query.tag && !artifact.tags.includes(query.tag)) return false;
  if (query.path) {
    const queryPath = query.path.replace(/\/$/, "");
    if (!artifact.paths.some((path) => path === query.path || path.startsWith(`${queryPath}/`))) return false;
  }
  if (query.commandPrefix && !artifact.command?.startsWith(query.commandPrefix)) return false;

  const text = normalizeNeedle(query.text);
  if (text) {
    const haystack = [artifact.summary, artifact.payload, artifact.command, artifact.tags.join(" "), artifact.paths.join(" ")]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(text)) return false;
  }

  return true;
}

export function createInMemoryContextBroker(options: ContextBrokerOptions = {}): BoundedContextBroker {
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const defaultTtlMs = Math.max(0, Math.floor(options.defaultTtlMs ?? DEFAULT_TTL_MS));
  const summaryBytes = Math.max(16, Math.floor(options.summaryBytes ?? DEFAULT_SUMMARY_BYTES));
  const defaultBriefBytes = Math.max(64, Math.floor(options.briefBytes ?? DEFAULT_BRIEF_BYTES));
  let artifacts: Array<ContextArtifact & { sequence: number }> = [];
  let sequence = 0;

  function currentStatus(): ContextBrokerStatus {
    const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
    const pinned = artifacts.filter((artifact) => artifact.pinned);
    return {
      records: artifacts.length,
      bytes,
      pinnedRecords: pinned.length,
      pinnedBytes: pinned.reduce((sum, artifact) => sum + artifact.bytes, 0),
      maxRecords,
      maxBytes,
    };
  }

  function dropExpired(now = Date.now(), protectedIds = new Set<string>()): void {
    artifacts = artifacts.filter(
      (artifact) => artifact.pinned || protectedIds.has(artifact.id) || !artifact.expiresAt || artifact.expiresAt > now,
    );
  }

  function oldestRemovable(sessionId: string, protectedIds: Set<string>): { artifact: ContextArtifact & { sequence: number }; index: number } | undefined {
    return artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact.sessionId === sessionId && !artifact.pinned && !protectedIds.has(artifact.id))
      .sort((a, b) => {
        if (a.artifact.createdAt !== b.artifact.createdAt) return a.artifact.createdAt - b.artifact.createdAt;
        return a.artifact.sequence - b.artifact.sequence;
      })[0];
  }

  function sessionWithinCaps(sessionId: string): boolean {
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === sessionId);
    return sessionArtifacts.length <= maxRecords && sessionArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) <= maxBytes;
  }

  function prune(now = Date.now(), protectedIds = new Set<string>()): ContextBrokerStatus {
    dropExpired(now, protectedIds);

    for (const sessionId of new Set(artifacts.map((artifact) => artifact.sessionId))) {
      while (!sessionWithinCaps(sessionId)) {
        const candidate = oldestRemovable(sessionId, protectedIds);
        if (!candidate) break;
        artifacts.splice(candidate.index, 1);
      }
    }

    return currentStatus();
  }

  function status(): ContextBrokerStatus {
    dropExpired();
    return currentStatus();
  }

  function publish(input: ContextArtifactInput): ContextArtifact {
    const now = input.createdAt ?? Date.now();
    const payload = payloadText(input.payload);
    const sha256 = hashPayload(input.payload);
    const bytes = payloadBytes(input.payload);
    const artifactSequence = ++sequence;
    const id = `ctx-${now.toString(36)}-${String(artifactSequence).padStart(4, "0")}-${sha256.slice(0, 12)}`;
    const session = safeName(input.sessionId || "session");
    const kind = input.kind;
    const handle = `ctx://session/${session}/${kind}/${sha256.slice(0, 16)}/${id}`;
    const ttlMs = input.ttlMs ?? defaultTtlMs;

    const artifact: ContextArtifact & { sequence: number } = {
      id,
      handle,
      sessionId: input.sessionId,
      kind,
      createdAt: now,
      updatedAt: now,
      bytes,
      sha256,
      payload,
      summary: summarizeArtifact(input.summary, kind, bytes, sha256, summaryBytes),
      tags: normalizeList(input.tags),
      paths: normalizeList(input.paths),
      command: input.command?.trim() || undefined,
      branch: input.branch?.trim() || undefined,
      expiresAt: ttlMs > 0 ? now + ttlMs : undefined,
      pinned: Boolean(input.pinned),
      parentIds: normalizeList(input.parentIds),
      sequence: artifactSequence,
    };

    artifacts = [artifact, ...artifacts];
    prune(now, new Set([artifact.id]));
    return artifact;
  }

  function lookup(query: ContextLookupQuery = {}): ContextArtifact[] {
    dropExpired();
    const limit = Math.max(1, Math.floor(query.limit ?? (artifacts.length || 1)));
    return artifacts
      .filter((artifact) => artifactMatches(artifact, query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || b.sequence - a.sequence)
      .slice(0, limit);
  }

  function pin(idOrHandle: string, pinned = true): ContextArtifact | null {
    dropExpired();
    const artifact = artifacts.find((candidate) => candidate.id === idOrHandle || candidate.handle === idOrHandle) ?? null;
    if (!artifact) return null;
    artifact.pinned = pinned;
    artifact.updatedAt = Date.now();
    prune();
    return artifacts.find((candidate) => candidate.id === artifact.id) ?? null;
  }

  function renderBrief(query: ContextLookupQuery & { budgetBytes?: number } = {}): string {
    const budget = Math.max(64, Math.floor(query.budgetBytes ?? defaultBriefBytes));
    const lines = [
      "## Context Broker",
      `Budget: ${budget} bytes`,
      ...lookup({ ...query, limit: query.limit ?? 8 }).map((artifact) => {
        const pin = artifact.pinned ? " pinned" : "";
        const path = artifact.paths.length ? ` paths=${artifact.paths.slice(0, 3).join(",")}` : "";
        const tags = artifact.tags.length ? ` tags=${artifact.tags.slice(0, 3).join(",")}` : "";
        return `- ${artifact.handle} kind=${artifact.kind}${pin}${path}${tags} summary="${artifact.summary}"`;
      }),
      "Lookup: use broker lookup by handle/path/tag/kind/session before replaying raw payloads.",
    ];

    return truncateUtf8(lines.join("\n"), budget);
  }

  return {
    publish,
    lookup,
    pin,
    prune,
    status,
    renderBrief,
  };
}
