import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { ensureOwnerOnlyDirectory, safeName, secureWriteFile, tightenOwnerOnlyFile, tightenSqliteArtifacts } from "@fiale-plus/pi-core";
import type { BoundedContextBroker, ContextArtifact, ContextArtifactInput, ContextArtifactTier, ContextBrokerOptions, ContextBrokerStatus, ContextLookupQuery, ContextPurgeOptions } from "@fiale-plus/pi-core";
import { CONTEXT_BROKER_PERSISTENCE_SNAPSHOT, CONTEXT_BROKER_RESTORE_ARTIFACT, createInMemoryContextBroker, rememberSource, sourceIdFor, sourceTombstoneArtifact } from "./index.js";

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

function sourceLedgerFile(dir: string): string {
  return join(dir, "source-ledger.jsonl");
}

// This is the authoritative snapshot. Legacy JSONL files remain readable and
// are refreshed for compatibility, but a checkpoint makes records and source
// provenance visible as one renamed unit.
function checkpointFile(dir: string): string {
  return join(dir, "checkpoint.json");
}

interface SourceLedgerRecord { sessionId: string; sourceId: string; handle?: string; }
interface StoreCheckpoint { version: number; records: StoredRecord[]; sources: SourceLedgerRecord[]; }

function readSourceLedger(dir: string): Map<string, string> {
  const sources = new Map<string, string>();
  const file = sourceLedgerFile(dir);
  if (!existsSync(file)) return sources;
  tightenOwnerOnlyFile(file);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const record = JSON.parse(line) as SourceLedgerRecord;
      if (!record || typeof record.sessionId !== "string" || typeof record.sourceId !== "string") continue;
      const sourceId = sourceIdFor({ sessionId: record.sessionId, sourceId: record.sourceId, kind: "tool_output", payload: "" });
      if (sourceId) rememberSource(sources, record.sessionId, sourceId, typeof record.handle === "string" ? record.handle : "");
    } catch { /* ignore malformed append-only rows */ }
  }
  return sources;
}

function checkpointSourceLedger(dir: string, sources: Map<string, string>): void {
  const file = sourceLedgerFile(dir);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rows = [...sources].map(([key, handle]) => {
    const separator = key.indexOf("\u0000");
    return JSON.stringify({ sessionId: key.slice(0, separator), sourceId: key.slice(separator + 1), handle });
  });
  secureWriteFile(temporary, rows.join("\n") + (rows.length ? "\n" : ""), "exclusive");
  renameSync(temporary, file);
  tightenOwnerOnlyFile(file);
}

function sourceLedgerRows(sources: Map<string, string>): SourceLedgerRecord[] {
  return [...sources].map(([key, handle]) => {
    const separator = key.indexOf("\u0000");
    return { sessionId: key.slice(0, separator), sourceId: key.slice(separator + 1), handle };
  });
}

function sourcesFromRows(rows: SourceLedgerRecord[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row.sessionId !== "string" || typeof row.sourceId !== "string") continue;
    try {
      const sourceId = sourceIdFor({ sessionId: row.sessionId, sourceId: row.sourceId, kind: "tool_output", payload: "" });
      if (sourceId) rememberSource(sources, row.sessionId, sourceId, typeof row.handle === "string" ? row.handle : "");
    } catch { /* ignore malformed compatibility rows */ }
  }
  return sources;
}

function readPersistedState(dir: string): { records: StoredRecord[]; sources: Map<string, string> } {
  const file = checkpointFile(dir);
  if (existsSync(file)) {
    tightenOwnerOnlyFile(file);
    try {
      const checkpoint = JSON.parse(readFileSync(file, "utf8")) as StoreCheckpoint;
      if (checkpoint?.version === STORE_VERSION && Array.isArray(checkpoint.records) && Array.isArray(checkpoint.sources)) {
        return { records: checkpoint.records, sources: sourcesFromRows(checkpoint.sources) };
      }
    } catch { /* fall back to the legacy JSONL state */ }
  }
  const records = readStoredRecords(dir);
  const sources = readSourceLedger(dir);
  // Legacy JSONL stored provenance only on artifact inputs. Seed every record
  // before a first prune can discard its payload or write a checkpoint.
  for (const record of records) {
    try {
      const source = stableSource(record.input as unknown as ContextArtifactInput);
      if (source && !sources.has(source)) {
        const separator = source.indexOf("\u0000");
        rememberSource(sources, source.slice(0, separator), source.slice(separator + 1), record.handle);
      }
    } catch { /* malformed legacy provenance remains unreadable, not fatal */ }
  }
  return { records, sources };
}

function checkpointPersistedState(dir: string, records: StoredRecord[], sources: Map<string, string>): void {
  const checkpoint = checkpointFile(dir);
  const temporary = `${checkpoint}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // The checkpoint rename is the single commit point. Blobs are intentionally
  // written before this call and may safely remain orphaned on a failed write.
  secureWriteFile(temporary, JSON.stringify({ version: STORE_VERSION, records, sources: sourceLedgerRows(sources) }) + "\n", "exclusive");
  renameSync(temporary, checkpoint);
  tightenOwnerOnlyFile(checkpoint);

  // Keep the original JSONL files readable for existing stores/tools. They are
  // projections of the authoritative checkpoint and are never read when it is
  // valid, so a failure after the commit cannot expose a half-committed state.
  const metadata = metadataFile(dir);
  const metadataTemp = `${metadata}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    secureWriteFile(metadataTemp, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "exclusive");
    renameSync(metadataTemp, metadata);
    tightenOwnerOnlyFile(metadata);
  } catch {
    // The checkpoint already committed this state; legacy projections may lag.
  }
  try {
    checkpointSourceLedger(dir, sources);
  } catch {
    // The checkpoint already committed this state; legacy projections may lag.
  }
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
  const sourceId = sourceIdFor(input);
  return sourceId ? `${input.sessionId}\u0000${sourceId}` : undefined;
}

function rememberSourceKey(sources: Map<string, string>, key: string, handle: string): void {
  const separator = key.indexOf("\u0000");
  rememberSource(sources, key.slice(0, separator), key.slice(separator + 1), handle);
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
      sourceId: input.sourceId,
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
    sourceId: artifact.sourceId,
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
  // Existing compatibility projections still receive the same owner-only
  // repair on startup, even when a checkpoint is authoritative.
  for (const file of [metadataFile(dir), sourceLedgerFile(dir), checkpointFile(dir)]) {
    if (existsSync(file)) tightenOwnerOnlyFile(file);
  }
  const initialReplayControl = { autoPruneOnPublish: false };
  let broker = createInMemoryContextBroker(options, initialReplayControl);
  const persistedSources = new Map<string, string>();
  const handleAliases = new Map<string, string>();
  const persistedHandleByCurrent = new Map<string, string>();
  const idAliases = new Map<string, string>();
  const persistedIdByCurrent = new Map<string, string>();
  const initialState = withStoreLock(dir, () => readPersistedState(dir));
  for (const [key, value] of initialState.sources) persistedSources.set(key, value);
  const initialStored = initialState.records.map((record) => ({ record, payload: loadPayload(dir, record.input.payloadSha256) }));

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

  // File-backed readers must not serve the process-local replay after another
  // instance has compacted or purged the store. Rebuild while holding the same
  // lock writers use, then perform the requested read from that snapshot.
  function refreshFromDisk(): void {
    const state = readPersistedState(dir);
    const fresh = createInMemoryContextBroker(options, { autoPruneOnPublish: false });
    const nextAliases = new Map<string, string>();
    const nextPersistedByCurrent = new Map<string, string>();
    const nextIdAliases = new Map<string, string>();
    const nextPersistedIdByCurrent = new Map<string, string>();
    for (const record of state.records) {
      const payload = loadPayload(dir, record.input.payloadSha256);
      if (payload === undefined) continue;
      const artifact = replayRecord(fresh, record, payload);
      nextAliases.set(record.handle, artifact.handle);
      if (!nextAliases.has(artifact.handle)) nextAliases.set(artifact.handle, artifact.handle);
      nextPersistedByCurrent.set(artifact.handle, record.handle);
      const persistedId = record.id ?? artifact.id;
      nextIdAliases.set(persistedId, artifact.id);
      if (!nextIdAliases.has(artifact.id)) nextIdAliases.set(artifact.id, artifact.id);
      nextPersistedIdByCurrent.set(artifact.id, persistedId);
    }
    // A store may have been created with looser limits (or by a legacy
    // writer). Never expose that oversized replay through a reader using the
    // current configuration.
    fresh.prune();
    broker = fresh;
    persistedSources.clear(); handleAliases.clear(); persistedHandleByCurrent.clear(); idAliases.clear(); persistedIdByCurrent.clear();
    for (const [key, value] of state.sources) persistedSources.set(key, value);
    for (const [key, value] of nextAliases) handleAliases.set(key, value);
    for (const [key, value] of nextPersistedByCurrent) persistedHandleByCurrent.set(key, value);
    for (const [key, value] of nextIdAliases) idAliases.set(key, value);
    for (const [key, value] of nextPersistedIdByCurrent) persistedIdByCurrent.set(key, value);
  }

  function refreshed<T>(read: () => T): T {
    return withStoreLock(dir, () => { refreshFromDisk(); return read(); });
  }

  function compactPersistedState(operation: { type: "prune"; now?: number } | { type: "purge"; options?: ContextPurgeOptions } | { type: "pin"; idOrHandle: string; pinned?: boolean }): ContextBrokerStatus | ContextArtifact | null {
    const fresh = createInMemoryContextBroker(options, { autoPruneOnPublish: false });
    const freshAliases = new Map<string, string>();
    const freshPersistedByCurrent = new Map<string, string>();
    const freshIdAliases = new Map<string, string>();
    const freshPersistedIdByCurrent = new Map<string, string>();
    for (const record of readPersistedState(dir).records) {
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
    const nextSources = readPersistedState(dir).sources;
    const nextAliases = new Map<string, string>();
    const nextPersistedByCurrent = new Map<string, string>();
    const nextIdAliases = new Map<string, string>();
    const nextPersistedIdByCurrent = new Map<string, string>();
    for (const artifact of remaining) {
      ensureBlob(dir, artifact);
      keptSha256.add(artifact.sha256);
      const persistedHandle = freshPersistedByCurrent.get(artifact.handle) ?? artifact.handle;
      const source = stableSource(artifact);
      if (source && !nextSources.has(source)) rememberSourceKey(nextSources, source, artifact.handle);
      nextAliases.set(persistedHandle, artifact.handle);
      if (!nextAliases.has(artifact.handle)) nextAliases.set(artifact.handle, artifact.handle);
      nextPersistedByCurrent.set(artifact.handle, persistedHandle);
      const persistedId = freshPersistedIdByCurrent.get(artifact.id) ?? artifact.id;
      nextIdAliases.set(persistedId, artifact.id);
      if (!nextIdAliases.has(artifact.id)) nextIdAliases.set(artifact.id, artifact.id);
      nextPersistedIdByCurrent.set(artifact.id, persistedId);
      records.push(storedRecord(artifact, snapshotInput(artifact), persistedHandle, persistedId));
    }

    // Do not rebuild provenance from retained artifacts: sources must outlive pruning.
    checkpointPersistedState(dir, records, nextSources);
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
    // Source validation must happen before rebuilding any in-memory snapshot.
    const sourceId = sourceIdFor(input);
    const source = sourceId ? `${input.sessionId}\u0000${sourceId}` : undefined;
    return withStoreLock(dir, () => {
      const state = readPersistedState(dir);
      const sourceKey = source;
      // Read durable provenance before replaying records: its handle can outlive
      // the payload after pruning.
      const persistedHandle = sourceKey ? state.sources.get(sourceKey) : undefined;
      const sourceWasSeen = sourceKey ? state.sources.has(sourceKey) : false;
      const replayControl = { autoPruneOnPublish: false };
      const fresh = createInMemoryContextBroker(options, replayControl);
      const nextSources = state.sources;
      const nextAliases = new Map<string, string>();
      const nextPersistedByCurrent = new Map<string, string>();
      const nextIdAliases = new Map<string, string>();
      const nextPersistedIdByCurrent = new Map<string, string>();
      for (const record of state.records) {
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
        const replayedSource = stableSource(replayed);
        if (replayedSource && !nextSources.has(replayedSource)) rememberSourceKey(nextSources, replayedSource, replayed.handle);
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
      if (sourceWasSeen) {
        const existing = persistedHandle ? fresh.lookup({ handle: nextAliases.get(persistedHandle) ?? persistedHandle, limit: 1 })[0] : undefined;
        applyFreshState();
        return existing ? externalizeArtifact(existing) : sourceTombstoneArtifact(input, sourceId!, persistedHandle);
      }
      replayControl.autoPruneOnPublish = true;
      const artifact = fresh.publish(input);
      // Write blobs before the commit point; only the checkpoint publishes the
      // artifact and its provenance together.
      ensureBlob(dir, artifact);
      if (source) rememberSourceKey(nextSources, source, artifact.handle);
      const retained = (fresh as BoundedContextBroker & { [CONTEXT_BROKER_PERSISTENCE_SNAPSHOT](): ContextArtifact[] })[CONTEXT_BROKER_PERSISTENCE_SNAPSHOT]();
      const records = retained
        .map((current) => storedRecord(current, snapshotInput(current), nextPersistedByCurrent.get(current.handle) ?? current.handle, nextPersistedIdByCurrent.get(current.id) ?? current.id));
      checkpointPersistedState(dir, records, nextSources);
      removeUnreferencedBlobs(dir, new Set(retained.map((current) => current.sha256)));
      nextAliases.set(artifact.handle, artifact.handle);
      nextPersistedByCurrent.set(artifact.handle, artifact.handle);
      nextIdAliases.set(artifact.id, artifact.id);
      nextPersistedIdByCurrent.set(artifact.id, artifact.id);
      applyFreshState();
      return externalizeArtifact(artifact);
    });
  }

  function sourceSeen(sessionId: string, sourceId: string): boolean {
    const source = sourceIdFor({ sessionId, sourceId, kind: "tool_output", payload: "" })!;
    return withStoreLock(dir, () => {
      const currentSources = readPersistedState(dir).sources;
      persistedSources.clear();
      for (const [key, handle] of currentSources) persistedSources.set(key, handle);
      return currentSources.has(`${sessionId}\u0000${source}`);
    });
  }

  function publishBatch(inputs: ContextArtifactInput[]): import("@fiale-plus/pi-core").ContextPublishBatchResult {
    // Validate every source before any JSONL/blob write. This is the boundary
    // that prevents one malformed batch member from partially committing.
    const sources = inputs.map((input) => sourceIdFor(input));
    return withStoreLock(dir, () => {
      // Never consult the process-local cache for provenance. Another instance
      // may have appended or compacted while this broker was idle.
      const replayControl = { autoPruneOnPublish: false };
      const fresh = createInMemoryContextBroker(options, replayControl);
      const nextSources = readPersistedState(dir).sources;
      const nextAliases = new Map<string, string>();
      const nextPersistedByCurrent = new Map<string, string>();
      const nextIdAliases = new Map<string, string>();
      const nextPersistedIdByCurrent = new Map<string, string>();
      for (const record of readPersistedState(dir).records) {
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
        const source = stableSource(record.input as unknown as ContextArtifactInput);
        if (source && !nextSources.has(source)) rememberSourceKey(nextSources, source, record.handle);
      }

      const before = fresh.status().records;
      const artifacts: ContextArtifact[] = [];
      let duplicateSources = 0;
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        const source = sources[index];
        const existingHandle = source ? nextSources.get(`${input.sessionId}\u0000${source}`) : undefined;
        if (existingHandle !== undefined) {
          duplicateSources += 1;
          const existing = fresh.lookup({ handle: nextAliases.get(existingHandle) ?? existingHandle, limit: 1 })[0];
          if (existing) artifacts.push(existing);
          continue;
        }
        const artifact = fresh.publish(input);
        artifacts.push(artifact);
        if (source) rememberSource(nextSources, input.sessionId, source, artifact.handle);
        nextAliases.set(artifact.handle, artifact.handle);
        nextPersistedByCurrent.set(artifact.handle, artifact.handle);
        nextIdAliases.set(artifact.id, artifact.id);
        nextPersistedIdByCurrent.set(artifact.id, artifact.id);
      }

      // A batch has exactly one bounded prune and exactly one metadata/ledger
      // checkpoint while the same store lock still protects the disk snapshot.
      fresh.prune();
      const remaining = (fresh as BoundedContextBroker & { [CONTEXT_BROKER_PERSISTENCE_SNAPSHOT](): ContextArtifact[] })[CONTEXT_BROKER_PERSISTENCE_SNAPSHOT]();
      const keptSha256 = new Set<string>();
      const records: StoredRecord[] = [];
      for (const artifact of remaining) {
        ensureBlob(dir, artifact);
        keptSha256.add(artifact.sha256);
        const persistedHandle = nextPersistedByCurrent.get(artifact.handle) ?? artifact.handle;
        const persistedId = nextPersistedIdByCurrent.get(artifact.id) ?? artifact.id;
        records.push(storedRecord(artifact, snapshotInput(artifact), persistedHandle, persistedId));
      }
      checkpointPersistedState(dir, records, nextSources);
      removeUnreferencedBlobs(dir, keptSha256);

      broker = fresh;
      persistedSources.clear(); handleAliases.clear(); persistedHandleByCurrent.clear(); idAliases.clear(); persistedIdByCurrent.clear();
      for (const [key, value] of nextSources) persistedSources.set(key, value);
      for (const [key, value] of nextAliases) handleAliases.set(key, value);
      for (const [key, value] of nextPersistedByCurrent) persistedHandleByCurrent.set(key, value);
      for (const [key, value] of nextIdAliases) idAliases.set(key, value);
      for (const [key, value] of nextPersistedIdByCurrent) persistedIdByCurrent.set(key, value);
      const after = fresh.status().records;
      const retained = artifacts.filter((artifact) => fresh.lookup({ id: artifact.id, limit: 1 }).length > 0).map(externalizeArtifact);
      return { artifacts: retained, scanned: inputs.length, duplicateSources, published: inputs.length - duplicateSources, pruned: Math.max(0, before + inputs.length - duplicateSources - after) };
    });
  }

  return {
    publish,
    publishBatch,
    sourceSeen,
    lookup(query?: ContextLookupQuery): ContextArtifact[] {
      return refreshed(() => {
        const mappedHandle = query?.handle ? handleAliases.get(query.handle) : undefined;
        const mappedId = query?.id ? idAliases.get(query.id) : undefined;
        return broker.lookup({ ...query, ...(mappedHandle ? { handle: mappedHandle } : {}), ...(mappedId ? { id: mappedId } : {}) }).map(externalizeArtifact);
      });
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
    status(): ContextBrokerStatus { return refreshed(() => broker.status()); },
    renderBrief(query?: ContextLookupQuery & { budgetBytes?: number }): string {
      return refreshed(() => {
        const mappedHandle = query?.handle ? handleAliases.get(query.handle) : undefined;
        const mappedId = query?.id ? idAliases.get(query.id) : undefined;
        let brief = broker.renderBrief({ ...query, ...(mappedHandle ? { handle: mappedHandle } : {}), ...(mappedId ? { id: mappedId } : {}) });
        const replacements = [...persistedHandleByCurrent].filter(([current, persisted]) => current !== persisted);
        replacements.forEach(([current], index) => { brief = brief.replaceAll(current, `__PI_ROGUE_HANDLE_${index}__`); });
        replacements.forEach(([, persisted], index) => { brief = brief.replaceAll(`__PI_ROGUE_HANDLE_${index}__`, persisted); });
        return brief;
      });
    },
  };
}

export function contextBrokerStoreDirForSession(baseDir: string, sessionId: string): string {
  return join(baseDir, safeName(sessionId));
}
