import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { ensureOwnerOnlyDirectory, safeName, secureWriteFile, tightenOwnerOnlyFile, tightenSqliteArtifacts } from "@fiale-plus/pi-core";
import type { BoundedContextBroker, ContextArtifact, ContextArtifactInput, ContextArtifactTier, ContextBrokerOptions, ContextBrokerStatus, ContextLookupQuery, ContextPurgeOptions } from "@fiale-plus/pi-core";
import { CONTEXT_BROKER_PERSISTENCE_SNAPSHOT, CONTEXT_BROKER_RESTORE_ARTIFACT, createInMemoryContextBroker } from "./index.js";

export interface FileContextBrokerOptions extends ContextBrokerOptions {
  dir?: string;
}

const STORE_VERSION = 1;

interface StoredRecord {
  version: number;
  id?: string;
  sequence?: number;
  handle: string;
  baseTier?: ContextArtifactTier;
  input: Omit<ContextArtifactInput, "payload"> & { payloadSha256: string };
}

function defaultStoreDir(): string {
  return join(homedir(), ".pi", "agent", "fiale-plus", "context-broker");
}

function ensureDir(path: string): void {
  ensureOwnerOnlyDirectory(path);
}

function metadataFile(dir: string): string {
  return join(dir, "metadata.jsonl");
}

function blobFile(dir: string, sha256: string): string {
  return join(dir, "blobs", `${sha256}.txt`);
}

function withStoreLock<T>(dir: string, operation: () => T): T {
  const lockPath = join(dir, ".metadata-lock.sqlite");
  tightenSqliteArtifacts(lockPath);
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout = 30000");
    lock.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      lock.exec("COMMIT");
      return result;
    } catch (error) {
      try { lock.exec("ROLLBACK"); } catch { /* preserve the operation error */ }
      throw error;
    }
  } finally {
    lock.close();
    tightenSqliteArtifacts(lockPath);
  }
}

function stableSource(input: ContextArtifactInput): string | undefined {
  return input.parentIds?.find(Boolean);
}

function readStoredRecords(dir: string): StoredRecord[] {
  const file = metadataFile(dir);
  if (!existsSync(file)) return [];
  tightenOwnerOnlyFile(file);
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
  tightenOwnerOnlyFile(file);
  return readFileSync(file, "utf8");
}

function artifactBaseTier(artifact: ContextArtifact, fallback?: ContextArtifactTier): ContextArtifactTier {
  return (artifact as ContextArtifact & { baseTier?: ContextArtifactTier }).baseTier ?? fallback ?? artifact.tier;
}

function storedRecord(artifact: ContextArtifact, input: ContextArtifactInput, persistedHandle = artifact.handle, persistedId = artifact.id): StoredRecord {
  return {
    version: STORE_VERSION,
    id: persistedId,
    sequence: (artifact as ContextArtifact & { sequence?: number }).sequence,
    handle: persistedHandle,
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
      pinned: input.pinned ?? artifact.pinned,
      parentIds: input.parentIds,
      createdAt: input.createdAt ?? artifact.createdAt,
      payloadSha256: artifact.sha256,
    },
  };
}

function ensureBlob(dir: string, artifact: ContextArtifact): void {
  ensureDir(join(dir, "blobs"));
  const blob = blobFile(dir, artifact.sha256);
  if (!existsSync(blob)) {
    try {
      secureWriteFile(blob, artifact.payload, "exclusive");
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      tightenOwnerOnlyFile(blob);
    }
  } else {
    tightenOwnerOnlyFile(blob);
  }
}

function persistRecord(dir: string, artifact: ContextArtifact, input: ContextArtifactInput): void {
  ensureBlob(dir, artifact);
  const record = storedRecord(artifact, input);
  ensureDir(dirname(metadataFile(dir)));
  secureWriteFile(metadataFile(dir), `${JSON.stringify(record)}\n`, "append");
}

function snapshotInput(artifact: ContextArtifact): ContextArtifactInput {
  return {
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
  };
}

function replayRecord(broker: BoundedContextBroker, record: StoredRecord, payload: string): ContextArtifact {
  const input = { ...record.input, tier: record.baseTier ?? record.input.tier, payload };
  if (record.id && typeof record.sequence === "number") {
    return (broker as BoundedContextBroker & {
      [CONTEXT_BROKER_RESTORE_ARTIFACT](input: ContextArtifactInput, identity: { id: string; handle: string; sequence: number }): ContextArtifact;
    })[CONTEXT_BROKER_RESTORE_ARTIFACT](input, { id: record.id, handle: record.handle, sequence: record.sequence });
  }
  return broker.publish(input);
}

function removeUnreferencedBlobs(dir: string, keptSha256: Set<string>): void {
  const blobsDir = join(dir, "blobs");
  if (!existsSync(blobsDir)) return;
  for (const entry of readdirSync(blobsDir)) {
    if (!entry.endsWith(".txt")) continue;
    const sha256 = entry.slice(0, -4);
    if (!keptSha256.has(sha256)) unlinkSync(join(blobsDir, entry));
  }
}

export function createFileContextBroker(options: FileContextBrokerOptions = {}): BoundedContextBroker {
  const dir = options.dir ?? process.env.PI_CONTEXT_BROKER_STORE_DIR ?? defaultStoreDir();
  ensureDir(dir);
  ensureDir(join(dir, "blobs"));
  const initialReplayControl = { autoPruneOnPublish: false };
  let broker = createInMemoryContextBroker(options, initialReplayControl);
  const persistedSources = new Map<string, string>();
  const handleAliases = new Map<string, string>();
  const persistedHandleByCurrent = new Map<string, string>();
  const idAliases = new Map<string, string>();
  const persistedIdByCurrent = new Map<string, string>();
  const initialStored = withStoreLock(dir, () => readStoredRecords(dir).map((record) => ({ record, payload: loadPayload(dir, record.input.payloadSha256) })));

  for (const { record, payload } of initialStored) {
    if (payload === undefined) continue;
    const artifact = replayRecord(broker, record, payload);
    handleAliases.set(record.handle, artifact.handle);
    persistedHandleByCurrent.set(artifact.handle, record.handle);
    const persistedId = record.id ?? artifact.id;
    idAliases.set(persistedId, artifact.id);
    persistedIdByCurrent.set(artifact.id, persistedId);
    const source = stableSource(record.input as unknown as ContextArtifactInput);
    if (source) persistedSources.set(source, artifact.handle);
  }

  initialReplayControl.autoPruneOnPublish = true;
  broker.prune();

  function compactPersistedState(operation: { type: "prune"; now?: number } | { type: "purge"; options?: ContextPurgeOptions } | { type: "pin"; idOrHandle: string; pinned?: boolean }): ContextBrokerStatus | ContextArtifact | null {
    const fresh = createInMemoryContextBroker(options, { autoPruneOnPublish: false });
    const freshAliases = new Map<string, string>();
    const freshPersistedByCurrent = new Map<string, string>();
    const freshIdAliases = new Map<string, string>();
    const freshPersistedIdByCurrent = new Map<string, string>();
    for (const record of readStoredRecords(dir)) {
      const payload = loadPayload(dir, record.input.payloadSha256);
      if (payload === undefined) continue;
      const artifact = replayRecord(fresh, record, payload);
      freshAliases.set(record.handle, artifact.handle);
      freshPersistedByCurrent.set(artifact.handle, record.handle);
      const persistedId = record.id ?? artifact.id;
      freshIdAliases.set(persistedId, artifact.id);
      freshPersistedIdByCurrent.set(artifact.id, persistedId);
    }

    let result: ContextBrokerStatus | ContextArtifact | null;
    if (operation.type === "prune") result = fresh.prune(operation.now);
    else if (operation.type === "purge") result = fresh.purge(operation.options);
    else {
      fresh.prune();
      result = fresh.pin(freshAliases.get(operation.idOrHandle) ?? freshIdAliases.get(operation.idOrHandle) ?? operation.idOrHandle, operation.pinned);
    }
    const remaining = (fresh as BoundedContextBroker & { [CONTEXT_BROKER_PERSISTENCE_SNAPSHOT](): ContextArtifact[] })[CONTEXT_BROKER_PERSISTENCE_SNAPSHOT]();
    const keptSha256 = new Set<string>();
    const records: StoredRecord[] = [];
    const nextSources = new Map<string, string>();
    const nextAliases = new Map<string, string>();
    const nextPersistedByCurrent = new Map<string, string>();
    const nextIdAliases = new Map<string, string>();
    const nextPersistedIdByCurrent = new Map<string, string>();
    for (const artifact of remaining) {
      ensureBlob(dir, artifact);
      keptSha256.add(artifact.sha256);
      const persistedHandle = freshPersistedByCurrent.get(artifact.handle) ?? artifact.handle;
      for (const parentId of artifact.parentIds) nextSources.set(parentId, artifact.handle);
      nextAliases.set(persistedHandle, artifact.handle);
      if (!nextAliases.has(artifact.handle)) nextAliases.set(artifact.handle, artifact.handle);
      nextPersistedByCurrent.set(artifact.handle, persistedHandle);
      const persistedId = freshPersistedIdByCurrent.get(artifact.id) ?? artifact.id;
      nextIdAliases.set(persistedId, artifact.id);
      if (!nextIdAliases.has(artifact.id)) nextIdAliases.set(artifact.id, artifact.id);
      nextPersistedIdByCurrent.set(artifact.id, persistedId);
      records.push(storedRecord(artifact, snapshotInput(artifact), persistedHandle, persistedId));
    }

    const metadata = metadataFile(dir);
    const temporary = `${metadata}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    secureWriteFile(temporary, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "exclusive");
    renameSync(temporary, metadata);
    tightenOwnerOnlyFile(metadata);
    removeUnreferencedBlobs(dir, keptSha256);
    broker = fresh;
    persistedSources.clear();
    handleAliases.clear();
    persistedHandleByCurrent.clear();
    idAliases.clear();
    persistedIdByCurrent.clear();
    for (const [key, value] of nextSources) persistedSources.set(key, value);
    for (const [key, value] of nextAliases) handleAliases.set(key, value);
    for (const [key, value] of nextPersistedByCurrent) persistedHandleByCurrent.set(key, value);
    for (const [key, value] of nextIdAliases) idAliases.set(key, value);
    for (const [key, value] of nextPersistedIdByCurrent) persistedIdByCurrent.set(key, value);
    return result;
  }

  function externalizeArtifact(artifact: ContextArtifact): ContextArtifact {
    const persistedHandle = persistedHandleByCurrent.get(artifact.handle) ?? artifact.handle;
    const persistedId = persistedIdByCurrent.get(artifact.id) ?? artifact.id;
    return persistedHandle !== artifact.handle || persistedId !== artifact.id ? { ...artifact, id: persistedId, handle: persistedHandle } : artifact;
  }

  function publish(input: ContextArtifactInput): ContextArtifact {
    return withStoreLock(dir, () => {
      const replayControl = { autoPruneOnPublish: false };
      const fresh = createInMemoryContextBroker(options, replayControl);
      const nextSources = new Map<string, string>();
      const nextAliases = new Map<string, string>();
      const nextPersistedByCurrent = new Map<string, string>();
      const nextIdAliases = new Map<string, string>();
      const nextPersistedIdByCurrent = new Map<string, string>();
      for (const record of readStoredRecords(dir)) {
        const payload = loadPayload(dir, record.input.payloadSha256);
        if (payload === undefined) continue;
        const replayed = replayRecord(fresh, record, payload);
        nextAliases.set(record.handle, replayed.handle);
        if (!nextAliases.has(replayed.handle)) nextAliases.set(replayed.handle, replayed.handle);
        nextPersistedByCurrent.set(replayed.handle, record.handle);
        const persistedId = record.id ?? replayed.id;
        nextIdAliases.set(persistedId, replayed.id);
        if (!nextIdAliases.has(replayed.id)) nextIdAliases.set(replayed.id, replayed.id);
        nextPersistedIdByCurrent.set(replayed.id, persistedId);
        for (const parentId of replayed.parentIds) nextSources.set(parentId, replayed.handle);
      }
      const applyFreshState = () => {
        broker = fresh;
        persistedSources.clear(); handleAliases.clear(); persistedHandleByCurrent.clear(); idAliases.clear(); persistedIdByCurrent.clear();
        for (const [key, value] of nextSources) persistedSources.set(key, value);
        for (const [key, value] of nextAliases) handleAliases.set(key, value);
        for (const [key, value] of nextPersistedByCurrent) persistedHandleByCurrent.set(key, value);
        for (const [key, value] of nextIdAliases) idAliases.set(key, value);
        for (const [key, value] of nextPersistedIdByCurrent) persistedIdByCurrent.set(key, value);
      };
      const source = stableSource(input);
      const existingHandle = source ? nextSources.get(source) : undefined;
      if (existingHandle) {
        fresh.prune();
        const existing = fresh.lookup({ handle: existingHandle })[0];
        if (existing) {
          applyFreshState();
          return externalizeArtifact(existing);
        }
      }
      replayControl.autoPruneOnPublish = true;
      const artifact = fresh.publish(input);
      persistRecord(dir, artifact, input);
      if (source) nextSources.set(source, artifact.handle);
      nextAliases.set(artifact.handle, artifact.handle);
      nextPersistedByCurrent.set(artifact.handle, artifact.handle);
      nextIdAliases.set(artifact.id, artifact.id);
      nextPersistedIdByCurrent.set(artifact.id, artifact.id);
      applyFreshState();
      return externalizeArtifact(artifact);
    });
  }

  return {
    publish,
    lookup(query?: ContextLookupQuery): ContextArtifact[] {
      const mappedHandle = query?.handle ? handleAliases.get(query.handle) : undefined;
      const mappedId = query?.id ? idAliases.get(query.id) : undefined;
      return broker.lookup({ ...query, ...(mappedHandle ? { handle: mappedHandle } : {}), ...(mappedId ? { id: mappedId } : {}) }).map(externalizeArtifact);
    },
    pin(idOrHandle: string, pinned?: boolean): ContextArtifact | null {
      const mappedCurrentHandle = handleAliases.get(idOrHandle) ?? idOrHandle;
      const mappedCurrentId = idAliases.get(idOrHandle) ?? idOrHandle;
      const byId = broker.lookup({ id: mappedCurrentId, limit: 1 })[0];
      const persistedIdentity = persistedHandleByCurrent.get(mappedCurrentHandle)
        ?? persistedIdByCurrent.get(mappedCurrentId)
        ?? (byId ? persistedHandleByCurrent.get(byId.handle) ?? persistedIdByCurrent.get(byId.id) : undefined)
        ?? idOrHandle;
      const artifact = withStoreLock(dir, () => compactPersistedState({ type: "pin", idOrHandle: persistedIdentity, pinned }) as ContextArtifact | null);
      return artifact ? externalizeArtifact(artifact) : null;
    },
    prune(now?: number): ContextBrokerStatus {
      return withStoreLock(dir, () => compactPersistedState({ type: "prune", now }) as ContextBrokerStatus);
    },
    purge(options?: ContextPurgeOptions): ContextBrokerStatus {
      return withStoreLock(dir, () => compactPersistedState({ type: "purge", options }) as ContextBrokerStatus);
    },
    status(): ContextBrokerStatus { return broker.status(); },
    renderBrief(query?: ContextLookupQuery & { budgetBytes?: number }): string {
      const mappedHandle = query?.handle ? handleAliases.get(query.handle) : undefined;
      const mappedId = query?.id ? idAliases.get(query.id) : undefined;
      let brief = broker.renderBrief({ ...query, ...(mappedHandle ? { handle: mappedHandle } : {}), ...(mappedId ? { id: mappedId } : {}) });
      const replacements = [...persistedHandleByCurrent].filter(([current, persisted]) => current !== persisted);
      replacements.forEach(([current], index) => { brief = brief.replaceAll(current, `__PI_ROGUE_HANDLE_${index}__`); });
      replacements.forEach(([, persisted], index) => { brief = brief.replaceAll(`__PI_ROGUE_HANDLE_${index}__`, persisted); });
      return brief;
    },
  };
}

export function contextBrokerStoreDirForSession(baseDir: string, sessionId: string): string {
  return join(baseDir, safeName(sessionId));
}
