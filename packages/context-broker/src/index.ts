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

export function createInMemoryContextBroker(options: ContextBrokerOptions = {}): BoundedContextBroker {
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
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
  const summaryBytes = Math.max(16, Math.floor(options.summaryBytes ?? DEFAULT_SUMMARY_BYTES));
  const defaultBriefBytes = Math.max(64, Math.floor(options.briefBytes ?? DEFAULT_BRIEF_BYTES));
  let artifacts: Array<ContextArtifact & { sequence: number; baseTier: ContextArtifactTier }> = [];
  let sequence = 0;

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

  function withinCaps(sessionId: string, tier?: ContextArtifactTier): boolean {
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === sessionId && (!tier || artifact.tier === tier));
    const recordsCap = tier ? tierMaxRecords[tier] : maxRecords;
    const bytesCap = tier ? tierMaxBytes[tier] : maxBytes;
    return sessionArtifacts.length <= recordsCap && sessionArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) <= bytesCap;
  }

  function prune(now = Date.now(), protectedIds = new Set<string>()): ContextBrokerStatus {
    dropExpired(now, protectedIds);

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

    return currentStatus();
  }

  function status(): ContextBrokerStatus {
    dropExpired();
    return currentStatus();
  }

  function purge(options: ContextPurgeOptions = {}): ContextBrokerStatus {
    dropExpired();
    const keepPinned = options.keepPinned ?? true;
    artifacts = artifacts.filter((artifact) => {
      if (options.sessionId && artifact.sessionId !== options.sessionId) return true;
      return keepPinned && artifact.pinned;
    });
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
      sequence: artifactSequence,
      baseTier,
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
      "Lookup: use broker lookup by handle/path/tag/kind/session before replaying raw payloads.",
    ].filter(Boolean);

    return truncateUtf8(lines.join("\n"), budget);
  }

  return {
    publish,
    lookup,
    pin,
    prune,
    purge,
    status,
    renderBrief,
  };
}
