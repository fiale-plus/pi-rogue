import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { safeName } from "@fiale-plus/pi-core";
import type { BoundedContextBroker, ContextArtifact, ContextArtifactInput, ContextArtifactTier, ContextBrokerOptions, ContextBrokerStatus, ContextLookupQuery } from "@fiale-plus/pi-core";
import { createInMemoryContextBroker } from "./index.js";

export interface FileContextBrokerOptions extends ContextBrokerOptions {
  dir?: string;
}

const STORE_VERSION = 1;

interface StoredRecord {
  version: number;
  handle: string;
  baseTier?: ContextArtifactTier;
  input: Omit<ContextArtifactInput, "payload"> & { payloadSha256: string };
}

function defaultStoreDir(): string {
  return join(homedir(), ".pi", "agent", "fiale-plus", "context-broker");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function metadataFile(dir: string): string {
  return join(dir, "metadata.jsonl");
}

function blobFile(dir: string, sha256: string): string {
  return join(dir, "blobs", `${sha256}.txt`);
}

function stableSource(input: ContextArtifactInput): string | undefined {
  return input.parentIds?.find(Boolean);
}

function readStoredRecords(dir: string): StoredRecord[] {
  const file = metadataFile(dir);
  if (!existsSync(file)) return [];
  const recordsByHandle = new Map<string, StoredRecord>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as StoredRecord;
      if (parsed?.version === STORE_VERSION && parsed.handle && parsed.input?.payloadSha256) {
        recordsByHandle.set(parsed.handle, parsed);
      }
    } catch {
      // Ignore corrupt JSONL rows; durable storage is append-only recovery, not a startup blocker.
    }
  }
  return [...recordsByHandle.values()];
}

function loadPayload(dir: string, sha256: string): string | undefined {
  const file = blobFile(dir, sha256);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}

function artifactBaseTier(artifact: ContextArtifact, fallback?: ContextArtifactTier): ContextArtifactTier {
  return (artifact as ContextArtifact & { baseTier?: ContextArtifactTier }).baseTier ?? fallback ?? artifact.tier;
}

function persistRecord(dir: string, artifact: ContextArtifact, input: ContextArtifactInput): void {
  ensureDir(join(dir, "blobs"));
  const blob = blobFile(dir, artifact.sha256);
  if (!existsSync(blob)) writeFileSync(blob, artifact.payload, "utf8");
  const record: StoredRecord = {
    version: STORE_VERSION,
    handle: artifact.handle,
    baseTier: artifactBaseTier(artifact, input.tier),
    input: {
      sessionId: input.sessionId,
      kind: input.kind,
      summary: input.summary,
      tags: input.tags,
      paths: input.paths,
      command: input.command,
      branch: input.branch,
      tier: artifactBaseTier(artifact, input.tier),
      ttlMs: input.ttlMs,
      pinned: artifact.pinned,
      parentIds: input.parentIds,
      createdAt: input.createdAt ?? artifact.createdAt,
      payloadSha256: artifact.sha256,
    },
  };
  ensureDir(dirname(metadataFile(dir)));
  appendFileSync(metadataFile(dir), `${JSON.stringify(record)}\n`, "utf8");
}

function persistArtifactSnapshot(dir: string, artifact: ContextArtifact): void {
  persistRecord(dir, artifact, {
    sessionId: artifact.sessionId,
    kind: artifact.kind,
    payload: artifact.payload,
    summary: artifact.summary,
    tags: artifact.tags,
    paths: artifact.paths,
    command: artifact.command,
    branch: artifact.branch,
    tier: artifactBaseTier(artifact),
    ttlMs: artifact.expiresAt ? Math.max(0, artifact.expiresAt - artifact.createdAt) : 0,
    pinned: artifact.pinned,
    parentIds: artifact.parentIds,
    createdAt: artifact.createdAt,
  });
}

export function createFileContextBroker(options: FileContextBrokerOptions = {}): BoundedContextBroker {
  const dir = options.dir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR ?? defaultStoreDir();
  ensureDir(join(dir, "blobs"));
  const broker = createInMemoryContextBroker(options);
  const persistedSources = new Map<string, string>();
  const handleAliases = new Map<string, string>();

  for (const record of readStoredRecords(dir)) {
    const payload = loadPayload(dir, record.input.payloadSha256);
    if (payload === undefined) continue;
    const artifact = broker.publish({ ...record.input, tier: record.baseTier ?? record.input.tier, payload });
    handleAliases.set(record.handle, artifact.handle);
    const source = stableSource(record.input as unknown as ContextArtifactInput);
    if (source) persistedSources.set(source, artifact.handle);
  }

  function publish(input: ContextArtifactInput): ContextArtifact {
    const source = stableSource(input);
    const existingHandle = source ? persistedSources.get(source) : undefined;
    if (existingHandle) {
      const existing = broker.lookup({ handle: existingHandle })[0];
      if (existing) return existing;
    }

    const artifact = broker.publish(input);
    if (source) persistedSources.set(source, artifact.handle);
    persistRecord(dir, artifact, input);
    return artifact;
  }

  return {
    publish,
    lookup(query?: ContextLookupQuery): ContextArtifact[] {
      const mappedHandle = query?.handle ? handleAliases.get(query.handle) : undefined;
      return broker.lookup(mappedHandle ? { ...query, handle: mappedHandle } : query);
    },
    pin(idOrHandle: string, pinned?: boolean): ContextArtifact | null {
      const artifact = broker.pin(handleAliases.get(idOrHandle) ?? idOrHandle, pinned);
      if (artifact) persistArtifactSnapshot(dir, artifact);
      return artifact;
    },
    prune(now?: number): ContextBrokerStatus { return broker.prune(now); },
    status(): ContextBrokerStatus { return broker.status(); },
    renderBrief(query?: ContextLookupQuery & { budgetBytes?: number }): string { return broker.renderBrief(query); },
  };
}

export function contextBrokerStoreDirForSession(baseDir: string, sessionId: string): string {
  return join(baseDir, safeName(sessionId));
}
