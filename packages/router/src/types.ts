export const ROUTER_CHECKPOINT_SCHEMA = "pi-router.checkpoint.v1" as const;
export const RAW_SESSION_REF_SCHEMA = "pi-router.raw-session-ref.v1" as const;

export type SessionRole = "user" | "assistant" | "toolResult" | "system" | "unknown";
export type RouteAction =
  | "continue_current"
  | "continue_local"
  | "summarize_context"
  | "run_verifier"
  | "ask_micro_hint"
  | "escalate_plan_critique"
  | "escalate_debug_diagnosis"
  | "escalate_diff_review"
  | "delegate_full_step"
  | "spawn_subagent"
  | "merge_subagent_result"
  | "stop_and_ask_user";

export type SubagentRole = "explore" | "debug_diagnose" | "implement" | "review" | "verify";
export type SubagentToolPolicy = "read_only" | "test_only" | "edit_in_worktree" | "edit_main";
export type SubagentReturnContract = "evidence_summary_v1";
export type TaskStatus = "success" | "partial" | "failed" | "abandoned" | "unknown";
export type TaskType = "implementation" | "debug" | "review" | "research" | "ops" | "planning" | "unknown";

export type AdviceShape =
  | "none"
  | "micro_hint"
  | "plan_critique"
  | "debug_diagnosis"
  | "diff_review"
  | "full_delegation";

export type ContextPolicy =
  | "none"
  | "minimal"
  | "recent_events"
  | "focused_error_and_diff"
  | "diff_only"
  | "session_summary"
  | "full_context";

export interface RawSessionRef {
  schema: typeof RAW_SESSION_REF_SCHEMA;
  path: string;
  fromEvent: number;
  toEvent: number;
  fromByte: number;
  toByte: number;
  contentHash: string;
}

export interface SessionEventPointer {
  index: number;
  byteStart: number;
  byteEnd: number;
  id?: string;
  timestamp?: string;
  type: string;
  role: SessionRole;
}

export interface SessionCommandEvent {
  eventIndex: number;
  toolCallId?: string;
  toolName: string;
  commandHash?: string;
  normalizedCommandHash?: string;
  isVerifier: boolean;
}

export interface SessionToolResultEvent {
  eventIndex: number;
  toolCallId?: string;
  toolName?: string;
  isError: boolean;
  outputHash?: string;
  normalizedOutputHash?: string;
  errorHash?: string;
  errorFingerprintHash?: string;
  exitCode?: number;
  failingTestHash?: string;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  totalLines: number;
  fileHashes: string[];
  shortStatHash?: string;
}

export interface ProgressSignals {
  sameCommandRepeatedCount: number;
  sameErrorRepeatedCount: number;
  errorChanged: boolean;
  testsImproved: boolean | null;
  filesTouched: number;
  diffLines: number;
  diffFilesChanged: number;
  diffLinesAdded: number;
  diffLinesDeleted: number;
  diffChurnScore: number;
  toolThrashScore: number;
  goalDriftScore: number;
  loopScore: number;
  progressScore: number;
  verifierUsed: boolean;
  noVerifierUsed: boolean;
  toolCallsLast10Turns: number;
}

export interface RouterCheckpoint {
  schema: typeof ROUTER_CHECKPOINT_SCHEMA;
  sessionId: string;
  checkpointId: string;
  createdAt: string;
  rawSessionRef: RawSessionRef;
  harness: "pi";
  repoHash?: string;
  goalHash?: string;
  phase: "planning" | "implementation" | "debug" | "review" | "research" | "ops" | "unknown";
  activeModel?: string;
  provider?: string;
  features: ProgressSignals & {
    turnIndex: number;
    contextTokensApprox: number | null;
    gitDirty: boolean | null;
  };
  recent: {
    lastUserGoalHash?: string;
    lastCommandHash?: string;
    lastErrorHash?: string;
    lastErrorFingerprintHash?: string;
    touchedFileHashes: string[];
    diffFileHashes?: string[];
  };
  sourceEvent: SessionEventPointer;
}

export interface RouteDecision {
  schema: "pi-router.decision.v1";
  checkpointId: string;
  action: RouteAction;
  adviceShape: AdviceShape;
  contextPolicy: ContextPolicy;
  confidence: number;
  reason: string;
  policyVersion: string;
}
