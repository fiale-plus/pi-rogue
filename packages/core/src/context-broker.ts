export type ContextArtifactKind =
  | "tool_output"
  | "diff"
  | "file_snapshot"
  | "subagent_result"
  | "advisor_brief"
  | "memory_note"
  | "fusion_result";

export type ContextArtifactTier = "hot" | "warm" | "cold";

export interface ContextArtifactInput {
  sessionId: string;
  kind: ContextArtifactKind;
  payload: string | Buffer;
  summary?: string;
  tags?: string[];
  paths?: string[];
  command?: string;
  branch?: string;
  tier?: ContextArtifactTier;
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
  tier: ContextArtifactTier;
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
  tier?: ContextArtifactTier;
  text?: string;
  limit?: number;
}

export interface ContextBrokerStatus {
  records: number;
  bytes: number;
  pinnedRecords: number;
  pinnedBytes: number;
  hotRecords: number;
  hotBytes: number;
  warmRecords: number;
  warmBytes: number;
  coldRecords: number;
  coldBytes: number;
  maxRecords: number;
  maxBytes: number;
  globalMaxRecords: number;
  globalMaxBytes: number;
}

export interface ContextBrokerOptions {
  maxRecords?: number;
  maxBytes?: number;
  globalMaxRecords?: number;
  globalMaxBytes?: number;
  defaultTtlMs?: number;
  hotTtlMs?: number;
  warmTtlMs?: number;
  coldTtlMs?: number;
  hotMaxRecords?: number;
  warmMaxRecords?: number;
  coldMaxRecords?: number;
  hotMaxBytes?: number;
  warmMaxBytes?: number;
  coldMaxBytes?: number;
  hotToWarmMs?: number;
  warmToColdMs?: number;
  summaryBytes?: number;
  briefBytes?: number;
}

export interface ContextPurgeOptions {
  sessionId?: string;
  keepPinned?: boolean;
}

export interface BoundedContextBroker {
  publish(input: ContextArtifactInput): ContextArtifact;
  lookup(query?: ContextLookupQuery): ContextArtifact[];
  pin(idOrHandle: string, pinned?: boolean): ContextArtifact | null;
  prune(now?: number): ContextBrokerStatus;
  purge(options?: ContextPurgeOptions): ContextBrokerStatus;
  status(): ContextBrokerStatus;
  renderBrief(query?: ContextLookupQuery & { budgetBytes?: number }): string;
}
