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
