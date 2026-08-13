import { createHash } from "node:crypto";
import { safeName } from "@fiale-plus/pi-core";
import type {
  BoundedContextBroker,
  ContextArtifact,
  ContextArtifactInput,
  ContextArtifactKind,
  ContextArtifactTier,
  ContextBrokerOptions,
  ContextBrokerStatus,
  ContextLookupQuery,
  ContextPurgeOptions,
} from "@fiale-plus/pi-core";

export type {
  BoundedContextBroker,
  ContextArtifact,
  ContextArtifactInput,
  ContextArtifactKind,
  ContextArtifactTier,
  ContextBrokerOptions,
  ContextBrokerStatus,
  ContextLookupQuery,
  ContextPurgeOptions,
} from "@fiale-plus/pi-core";

const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SUMMARY_BYTES = 320;
const DEFAULT_BRIEF_BYTES = 2_000;
const TIER_ORDER: Record<ContextArtifactTier, number> = { hot: 0, warm: 1, cold: 2 };
const TIER_REMOVAL_ORDER: Record<ContextArtifactTier, number> = { cold: 0, warm: 1, hot: 2 };
export const MAX_CONTEXT_SOURCE_ID_BYTES = 512;
/**
 * Provenance must comfortably outlive the 64-eligible/512-raw-entry resume
 * window, but cannot grow without bound when artifacts are pruned.
 */
export const MAX_CONTEXT_SOURCES_PER_SESSION = 4_096;
/**
 * Across all sessions, provenance retains the newest 65,536 ingestion entries.
 * This deliberately exceeds the per-session cap so active sessions retain their
 * full tail, while preventing a large number of sessions from growing durable
 * ledgers without bound.
 */
export const MAX_CONTEXT_SOURCES_GLOBAL = 65_536;

/** Source ids share a key separator with their session id and must be bounded before persistence. */
export function sourceIdFor(input: ContextArtifactInput): string | undefined {
  const sourceId = input.sourceId ?? input.parentIds?.find(Boolean);
  if (sourceId === undefined) return undefined;
  if (typeof sourceId !== "string" || !sourceId.trim() || sourceId.includes("\u0000") || Buffer.byteLength(sourceId, "utf8") > MAX_CONTEXT_SOURCE_ID_BYTES) {
    throw new Error(`Invalid context broker sourceId (must be non-empty, contain no NUL, and be <= ${MAX_CONTEXT_SOURCE_ID_BYTES} UTF-8 bytes)`);
  }
  return sourceId;
}

export { contextBrokerFeatureStatus, serializeContextBrokerFeatureStatus } from "./status.js";
export type { ContextBrokerBackend, ContextBrokerStatusSource } from "./status.js";

export function sourceKey(sessionId: string, sourceId: string): string {
  return `${sessionId}\u0000${sourceId}`;
}

/**
 * Record provenance in ingestion order, retaining the newest per-session and
 * global tails. Map iteration order is the durable ingestion order used by the
 * JSONL/checkpoint backend; duplicate observations do not become new ingests.
 */
const sourceCounts = new WeakMap<Map<string, string>, Map<string, number>>();

function countsForSources(sources: Map<string, string>): Map<string, number> {
  let counts = sourceCounts.get(sources);
  if (counts) return counts;
  counts = new Map<string, number>();
  for (const key of sources.keys()) {
    const separator = key.indexOf("\u0000");
    const sessionId = key.slice(0, separator);
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  sourceCounts.set(sources, counts);
  return counts;
}

function forgetSource(sources: Map<string, string>, counts: Map<string, number>, key: string): void {
  if (!sources.delete(key)) return;
  const separator = key.indexOf("\u0000");
  const sessionId = key.slice(0, separator);
  const count = (counts.get(sessionId) ?? 1) - 1;
  if (count > 0) counts.set(sessionId, count);
  else counts.delete(sessionId);
}

export function rememberSource(sources: Map<string, string>, sessionId: string, sourceId: string, handle: string): void {
  const key = sourceKey(sessionId, sourceId);
  const counts = countsForSources(sources);
  if (sources.has(key)) {
    sources.set(key, handle);
    return;
  }
  sources.set(key, handle);
  const sessionCount = (counts.get(sessionId) ?? 0) + 1;
  counts.set(sessionId, sessionCount);
  if (sessionCount > MAX_CONTEXT_SOURCES_PER_SESSION) {
    const prefix = `${sessionId}\u0000`;
    for (const candidate of sources.keys()) {
      if (candidate.startsWith(prefix)) {
        forgetSource(sources, counts, candidate);
        break;
      }
    }
  }
  while (sources.size > MAX_CONTEXT_SOURCES_GLOBAL) {
    const oldest = sources.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    forgetSource(sources, counts, oldest);
  }
}

/**
 * `publish` predates batched duplicate reporting and must still return an
 * artifact. When a source ledger entry survives payload retention, return a
 * deterministic, non-persisted reference instead of silently republishing.
 * Live ingestion uses publishBatch and handles this case as no artifact.
 */
export function sourceTombstoneArtifact(input: ContextArtifactInput, sourceId: string, persistedHandle?: string): ContextArtifact {
  const identity = createHash("sha256").update(sourceKey(input.sessionId, sourceId)).digest("hex");
  const id = `ctx-source-${identity.slice(0, 24)}`;
  return {
    id,
    handle: persistedHandle || `ctx://session/${safeName(input.sessionId || "session")}/source-tombstone/${identity.slice(0, 24)}`,
    sessionId: input.sessionId,
    kind: input.kind,
    createdAt: 0,
    updatedAt: 0,
    bytes: 0,
    sha256: createHash("sha256").update("").digest("hex"),
    payload: "",
    summary: "[Duplicate source retained as provenance only; artifact payload was pruned.]",
    tags: [],
    paths: [],
    tier: "cold",
    pinned: false,
    parentIds: [sourceId],
    sourceId,
  };
}

function optionMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

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

function classifyBaseTier(input: ContextArtifactInput, tags: string[]): ContextArtifactTier {
  if (input.tier) return input.tier;
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  if (normalizedTags.includes("hot")) return "hot";
  if (normalizedTags.includes("warm")) return "warm";
  if (normalizedTags.includes("cold")) return "cold";
  if (normalizedTags.some((tag) => tag === "error" || tag === "failed" || tag === "failure")) return "hot";
  if (normalizedTags.some((tag) => tag === "archive" || tag === "historical" || tag === "completed")) return "cold";
  if (input.kind === "advisor_brief" || input.kind === "memory_note") return "hot";
  return "warm";
}

function artifactMatches(artifact: ContextArtifact, query: ContextLookupQuery): boolean {
  if (query.id && artifact.id !== query.id) return false;
  if (query.handle && artifact.handle !== query.handle) return false;
  if (query.sessionId && artifact.sessionId !== query.sessionId) return false;
  if (query.kind && artifact.kind !== query.kind) return false;
  if (query.branch && artifact.branch !== query.branch) return false;
  if (query.tier && artifact.tier !== query.tier) return false;
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

function tierLine(artifact: ContextArtifact): string {
  const pin = artifact.pinned ? " pinned" : "";
  const path = artifact.paths.length ? ` paths=${artifact.paths.slice(0, 3).join(",")}` : "";
  const tags = artifact.tags.length ? ` tags=${artifact.tags.slice(0, 3).join(",")}` : "";
  return `- ${artifact.handle} tier=${artifact.tier} kind=${artifact.kind}${pin}${path}${tags} summary="${artifact.summary}"`;
}

export const CONTEXT_BROKER_PERSISTENCE_SNAPSHOT = Symbol("context-broker-persistence-snapshot");
export const CONTEXT_BROKER_RESTORE_ARTIFACT = Symbol("context-broker-restore-artifact");

export function createInMemoryContextBroker(options: ContextBrokerOptions = {}, internal: { autoPruneOnPublish?: boolean } = {}): BoundedContextBroker {
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const globalMaxRecords = typeof options.globalMaxRecords === "number" && Number.isFinite(options.globalMaxRecords)
    ? Math.max(1, Math.floor(options.globalMaxRecords))
    : Number.POSITIVE_INFINITY;
  const globalMaxBytes = typeof options.globalMaxBytes === "number" && Number.isFinite(options.globalMaxBytes)
    ? Math.max(1, Math.floor(options.globalMaxBytes))
    : Number.POSITIVE_INFINITY;
  const defaultTtlMs = Math.max(0, Math.floor(options.defaultTtlMs ?? DEFAULT_TTL_MS));
  const tierTtlMs: Record<ContextArtifactTier, number> = {
    hot: Math.max(0, Math.floor(options.hotTtlMs ?? defaultTtlMs)),
    warm: Math.max(0, Math.floor(options.warmTtlMs ?? defaultTtlMs)),
    cold: Math.max(0, Math.floor(options.coldTtlMs ?? defaultTtlMs)),
  };
  const tierMaxRecords: Record<ContextArtifactTier, number> = {
    hot: Math.max(1, Math.floor(options.hotMaxRecords ?? maxRecords)),
    warm: Math.max(1, Math.floor(options.warmMaxRecords ?? maxRecords)),
    cold: Math.max(1, Math.floor(options.coldMaxRecords ?? maxRecords)),
  };
  const tierMaxBytes: Record<ContextArtifactTier, number> = {
    hot: Math.max(1, Math.floor(options.hotMaxBytes ?? maxBytes)),
    warm: Math.max(1, Math.floor(options.warmMaxBytes ?? maxBytes)),
    cold: Math.max(1, Math.floor(options.coldMaxBytes ?? maxBytes)),
  };
  const hotToWarmMs = optionMs(options.hotToWarmMs);
  const warmToColdMs = optionMs(options.warmToColdMs);
  const summaryBytes = Math.max(16, Math.floor(options.summaryBytes ?? DEFAULT_SUMMARY_BYTES));
  const defaultBriefBytes = Math.max(64, Math.floor(options.briefBytes ?? DEFAULT_BRIEF_BYTES));
  let artifacts: Array<ContextArtifact & { sequence: number; baseTier: ContextArtifactTier }> = [];
  let sequence = 0;
  // Provenance deliberately outlives artifact retention so resume/backfill is idempotent.
  const sources = new Map<string, string>();

  function cooledTier(artifact: ContextArtifact & { baseTier: ContextArtifactTier }, now = Date.now()): ContextArtifactTier {
    if (artifact.pinned) return "hot";
    if (artifact.baseTier === "cold") return "cold";
    const age = Math.max(0, now - artifact.createdAt);
    if (age >= warmToColdMs) return "cold";
    if (artifact.baseTier === "hot" && age >= hotToWarmMs) return "warm";
    return artifact.baseTier;
  }

  function applyCooling(now = Date.now(), _protectedIds = new Set<string>()): void {
    for (const artifact of artifacts) {
      const nextTier = cooledTier(artifact, now);
      if (artifact.tier !== nextTier) {
        artifact.tier = nextTier;
        artifact.updatedAt = now;
      }
    }
  }

  function currentStatus(): ContextBrokerStatus {
    const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
    const pinned = artifacts.filter((artifact) => artifact.pinned);
    const byTier = (tier: ContextArtifactTier) => artifacts.filter((artifact) => artifact.tier === tier);
    const hot = byTier("hot");
    const warm = byTier("warm");
    const cold = byTier("cold");
    return {
      records: artifacts.length,
      bytes,
      pinnedRecords: pinned.length,
      pinnedBytes: pinned.reduce((sum, artifact) => sum + artifact.bytes, 0),
      hotRecords: hot.length,
      hotBytes: hot.reduce((sum, artifact) => sum + artifact.bytes, 0),
      warmRecords: warm.length,
      warmBytes: warm.reduce((sum, artifact) => sum + artifact.bytes, 0),
      coldRecords: cold.length,
      coldBytes: cold.reduce((sum, artifact) => sum + artifact.bytes, 0),
      maxRecords,
      maxBytes,
      globalMaxRecords,
      globalMaxBytes,
    };
  }

  function dropExpired(now = Date.now(), protectedIds = new Set<string>()): void {
    artifacts = artifacts.filter(
      (artifact) => artifact.pinned || protectedIds.has(artifact.id) || !artifact.expiresAt || artifact.expiresAt > now,
    );
  }

  function removalCandidates(sessionId: string, protectedIds: Set<string>, tier?: ContextArtifactTier): Array<{ artifact: ContextArtifact & { sequence: number; baseTier: ContextArtifactTier }; index: number }> {
    return artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => artifact.sessionId === sessionId && !artifact.pinned && !protectedIds.has(artifact.id) && (!tier || artifact.tier === tier))
      .sort((a, b) => {
        if (!tier && TIER_REMOVAL_ORDER[a.artifact.tier] !== TIER_REMOVAL_ORDER[b.artifact.tier]) {
          return TIER_REMOVAL_ORDER[a.artifact.tier] - TIER_REMOVAL_ORDER[b.artifact.tier];
        }
        if (a.artifact.createdAt !== b.artifact.createdAt) return a.artifact.createdAt - b.artifact.createdAt;
        return a.artifact.sequence - b.artifact.sequence;
      });
  }

  function removalCandidatesGlobal(protectedIds: Set<string>, tier?: ContextArtifactTier): Array<{ artifact: ContextArtifact & { sequence: number; baseTier: ContextArtifactTier }; index: number }> {
    return artifacts
      .map((artifact, index) => ({ artifact, index }))
      .filter(({ artifact }) => !artifact.pinned && !protectedIds.has(artifact.id) && (!tier || artifact.tier === tier))
      .sort((a, b) => {
        if (!tier && TIER_REMOVAL_ORDER[a.artifact.tier] !== TIER_REMOVAL_ORDER[b.artifact.tier]) {
          return TIER_REMOVAL_ORDER[a.artifact.tier] - TIER_REMOVAL_ORDER[b.artifact.tier];
        }
        if (a.artifact.createdAt !== b.artifact.createdAt) return a.artifact.createdAt - b.artifact.createdAt;
        return a.artifact.sequence - b.artifact.sequence;
      });
  }

  function withinCaps(sessionId: string, tier?: ContextArtifactTier): boolean {
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === sessionId && (!tier || artifact.tier === tier));
    const recordsCap = tier ? tierMaxRecords[tier] : maxRecords;
    const bytesCap = tier ? tierMaxBytes[tier] : maxBytes;
    return sessionArtifacts.length <= recordsCap && sessionArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) <= bytesCap;
  }

  function withinGlobalCaps(): boolean {
    if (globalMaxRecords === Number.POSITIVE_INFINITY && globalMaxBytes === Number.POSITIVE_INFINITY) return true;
    const records = artifacts.length;
    const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
    return records <= globalMaxRecords && bytes <= globalMaxBytes;
  }

  function prune(now = Date.now(), protectedIds = new Set<string>()): ContextBrokerStatus {
    dropExpired(now, protectedIds);
    applyCooling(now, protectedIds);

    for (const sessionId of new Set(artifacts.map((artifact) => artifact.sessionId))) {
      for (const tier of ["cold", "warm", "hot"] as ContextArtifactTier[]) {
        while (!withinCaps(sessionId, tier)) {
          const candidate = removalCandidates(sessionId, protectedIds, tier)[0];
          if (!candidate) break;
          artifacts.splice(candidate.index, 1);
        }
      }

      while (!withinCaps(sessionId)) {
        const candidate = removalCandidates(sessionId, protectedIds)[0];
        if (!candidate) break;
        artifacts.splice(candidate.index, 1);
      }
    }

    while (!withinGlobalCaps()) {
      const candidate = removalCandidatesGlobal(protectedIds)[0];
      if (!candidate) break;
      artifacts.splice(candidate.index, 1);
    }

    return currentStatus();
  }

  function status(): ContextBrokerStatus {
    dropExpired();
    applyCooling();
    return currentStatus();
  }

  function purge(options: ContextPurgeOptions = {}): ContextBrokerStatus {
    dropExpired();
    applyCooling();
    const keepPinned = options.keepPinned ?? true;
    artifacts = artifacts.filter((artifact) => {
      if (options.sessionId && artifact.sessionId !== options.sessionId) return true;
      return keepPinned && artifact.pinned;
    });
    return currentStatus();
  }

  function publishOne(input: ContextArtifactInput): ContextArtifact {
    const now = input.createdAt ?? Date.now();
    const payload = payloadText(input.payload);
    const sha256 = hashPayload(input.payload);
    const bytes = payloadBytes(input.payload);
    const artifactSequence = ++sequence;
    const id = `ctx-${now.toString(36)}-${String(artifactSequence).padStart(4, "0")}-${sha256.slice(0, 12)}`;
    const session = safeName(input.sessionId || "session");
    const kind = input.kind;
    const tags = normalizeList(input.tags);
    const baseTier = classifyBaseTier(input, tags);
    const tier: ContextArtifactTier = input.pinned ? "hot" : baseTier;
    const handle = `ctx://session/${session}/${kind}/${sha256.slice(0, 16)}/${id}`;
    const ttlMs = input.ttlMs ?? tierTtlMs[tier];

    const artifact: ContextArtifact & { sequence: number; baseTier: ContextArtifactTier } = {
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
      tags,
      paths: normalizeList(input.paths),
      command: input.command?.trim() || undefined,
      branch: input.branch?.trim() || undefined,
      tier,
      expiresAt: ttlMs > 0 ? now + ttlMs : undefined,
      pinned: Boolean(input.pinned),
      parentIds: normalizeList(input.parentIds),
      sourceId: input.sourceId,
      sequence: artifactSequence,
      baseTier,
    };

    artifacts = [artifact, ...artifacts];
    if (internal.autoPruneOnPublish !== false) prune(Date.now(), new Set([artifact.id]));
    return artifact;
  }

  function publish(input: ContextArtifactInput): ContextArtifact {
    // Validate and consult provenance before changing the bounded artifact set.
    const sourceId = sourceIdFor(input);
    if (sourceId) {
      const key = sourceKey(input.sessionId, sourceId);
      const persistedHandle = sources.get(key);
      if (persistedHandle !== undefined) {
        const existing = artifacts.find((artifact) => artifact.handle === persistedHandle);
        return existing ?? sourceTombstoneArtifact(input, sourceId, persistedHandle);
      }
    }
    const artifact = publishOne(input);
    if (sourceId) rememberSource(sources, input.sessionId, sourceId, artifact.handle);
    return artifact;
  }

  function publishBatch(inputs: ContextArtifactInput[]): import("@fiale-plus/pi-core").ContextPublishBatchResult {
    const priorArtifacts = artifacts;
    const priorSequence = sequence;
    const priorSources = new Map(sources);
    const artifactsBefore = artifacts.length;
    const result: ContextArtifact[] = [];
    let duplicateSources = 0;
    const oldAutoPrune = internal.autoPruneOnPublish;
    internal.autoPruneOnPublish = false;
    try {
      for (const input of inputs) {
        const sourceId = sourceIdFor(input);
        const key = sourceId ? sourceKey(input.sessionId, sourceId) : undefined;
        if (key && sources.has(key)) {
          duplicateSources += 1;
          const existing = lookup({ handle: sources.get(key), limit: 1 })[0];
          if (existing) result.push(existing);
          continue;
        }
        const artifact = publishOne(input);
        result.push(artifact);
        if (sourceId) rememberSource(sources, input.sessionId, sourceId, artifact.handle);
      }
      const beforePrune = artifacts.length;
      prune();
      return { artifacts: result.filter((artifact) => artifacts.some((current) => current.id === artifact.id)), scanned: inputs.length, duplicateSources, published: inputs.length - duplicateSources, pruned: Math.max(0, beforePrune - artifacts.length) };
    } catch (error) {
      artifacts = priorArtifacts;
      sequence = priorSequence;
      sources.clear();
      sourceCounts.delete(sources);
      for (const [key, value] of priorSources) sources.set(key, value);
      throw error;
    } finally {
      internal.autoPruneOnPublish = oldAutoPrune;
    }
  }

  function lookup(query: ContextLookupQuery = {}): ContextArtifact[] {
    dropExpired();
    applyCooling();
    const limit = Math.max(1, Math.floor(query.limit ?? (artifacts.length || 1)));
    return artifacts
      .filter((artifact) => artifactMatches(artifact, query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned)
        || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
        || b.createdAt - a.createdAt
        || b.sequence - a.sequence)
      .slice(0, limit);
  }

  function pin(idOrHandle: string, pinned = true): ContextArtifact | null {
    dropExpired();
    const artifact = artifacts.find((candidate) => candidate.id === idOrHandle || candidate.handle === idOrHandle) ?? null;
    if (!artifact) return null;
    artifact.pinned = pinned;
    artifact.tier = pinned ? "hot" : artifact.baseTier;
    artifact.updatedAt = Date.now();
    prune();
    return artifacts.find((candidate) => candidate.id === artifact.id) ?? null;
  }

  function renderBrief(query: ContextLookupQuery & { budgetBytes?: number } = {}): string {
    const budget = Math.max(64, Math.floor(query.budgetBytes ?? defaultBriefBytes));
    const explicitCold = query.tier === "cold" || Boolean(query.handle || query.id);
    const baseQuery = { ...query };
    delete (baseQuery as { budgetBytes?: number }).budgetBytes;
    const candidates = lookup({ ...baseQuery, limit: query.limit ?? 32 })
      .filter((artifact) => explicitCold || artifact.tier !== "cold");
    const hot = candidates.filter((artifact) => artifact.tier === "hot");
    const warm = candidates.filter((artifact) => artifact.tier === "warm");
    const cold = candidates.filter((artifact) => artifact.tier === "cold");
    const lines = [
      "## Context Broker",
      `Budget: ${budget} bytes`,
      hot.length ? "Hot:" : "",
      ...hot.map(tierLine),
      warm.length ? "Warm:" : "",
      ...warm.map(tierLine),
      cold.length ? "Cold:" : "",
      ...cold.map(tierLine),
      "Lookup: call context_lookup({handle}) for exact payloads.",
    ].filter(Boolean);

    return truncateUtf8(lines.join("\n"), budget);
  }

  return {
    publish,
    publishBatch,
    sourceSeen: (sessionId: string, sourceId: string) => sources.has(sourceKey(sessionId, sourceIdFor({ sessionId, sourceId, kind: "tool_output", payload: "" })!)),
    lookup,
    pin,
    prune,
    purge,
    status,
    renderBrief,
    [CONTEXT_BROKER_PERSISTENCE_SNAPSHOT]: () => artifacts.map((artifact) => ({ ...artifact, tags: [...artifact.tags], paths: [...artifact.paths], parentIds: [...artifact.parentIds] })),
    [CONTEXT_BROKER_RESTORE_ARTIFACT]: (input: ContextArtifactInput, identity: { id: string; handle: string; sequence: number }) => {
      const restored = publish(input) as ContextArtifact & { sequence: number };
      restored.id = identity.id;
      restored.handle = identity.handle;
      restored.sequence = identity.sequence;
      sequence = Math.max(sequence, identity.sequence);
      return restored;
    },
  } as BoundedContextBroker & {
    [CONTEXT_BROKER_PERSISTENCE_SNAPSHOT](): ContextArtifact[];
    [CONTEXT_BROKER_RESTORE_ARTIFACT](input: ContextArtifactInput, identity: { id: string; handle: string; sequence: number }): ContextArtifact;
  };
}
