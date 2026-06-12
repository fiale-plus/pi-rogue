import { readFileSync } from "node:fs";
import { hashText } from "./hash.js";
import type { AdviceShape, ContextPolicy, RouteAction, RouteDecision, RouterCheckpoint } from "./types.js";

export const ROUTER_POLICY_VERSION = "pi-router.rule-policy.v0";
export const ROUTER_DECISION_SCHEMA = "pi-router.decision.v1" as const;

export interface DecideOptions {
  policyVersion?: string;
}

interface RuleResult {
  action: RouteAction;
  adviceShape: AdviceShape;
  contextPolicy: ContextPolicy;
  confidence: number;
  reason: string;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function hasLargeDiff(checkpoint: RouterCheckpoint): boolean {
  return checkpoint.features.diffLines >= 400;
}

function isContextPressure(checkpoint: RouterCheckpoint): boolean {
  const tokens = checkpoint.features.contextTokensApprox;
  return typeof tokens === "number" && tokens >= 100_000;
}

function ruleFor(checkpoint: RouterCheckpoint): RuleResult {
  const { features, phase } = checkpoint;

  if (features.loopScore >= 0.9) {
    return {
      action: "stop_and_ask_user",
      adviceShape: "none",
      contextPolicy: "minimal",
      confidence: clampConfidence(0.82 + features.loopScore * 0.12),
      reason: "high loop score; stop before compounding repeated failures",
    };
  }

  if (isContextPressure(checkpoint)) {
    return {
      action: "summarize_context",
      adviceShape: "none",
      contextPolicy: "session_summary",
      confidence: 0.78,
      reason: "context token pressure is high; summarize before continuing or escalating",
    };
  }

  if (phase === "review" && hasLargeDiff(checkpoint)) {
    return {
      action: "escalate_diff_review",
      adviceShape: "diff_review",
      contextPolicy: "diff_only",
      confidence: 0.76,
      reason: "review phase with large diff; request focused diff review",
    };
  }

  if (phase === "debug" && features.sameErrorRepeatedCount >= 2) {
    return {
      action: "escalate_debug_diagnosis",
      adviceShape: "debug_diagnosis",
      contextPolicy: "focused_error_and_diff",
      confidence: clampConfidence(0.72 + Math.min(features.sameErrorRepeatedCount, 4) * 0.05),
      reason: "same error repeated in debug phase; ask stronger/different model for diagnosis",
    };
  }

  if (features.noVerifierUsed) {
    return {
      action: "run_verifier",
      adviceShape: "none",
      contextPolicy: "minimal",
      confidence: 0.74,
      reason: "multiple tool steps without verifier; run tests/checks before more edits",
    };
  }

  if (features.loopScore >= 0.65) {
    return {
      action: "ask_micro_hint",
      adviceShape: "micro_hint",
      contextPolicy: "recent_events",
      confidence: clampConfidence(0.62 + features.loopScore * 0.18),
      reason: "moderate loop signal; request a cheap micro-hint while staying local-first",
    };
  }

  return {
    action: checkpoint.activeModel ? "continue_current" : "continue_local",
    adviceShape: "none",
    contextPolicy: "none",
    confidence: clampConfidence(0.66 + features.progressScore * 0.18),
    reason: "progress signals are acceptable; continue with the current/local worker",
  };
}

export function decideRoute(checkpoint: RouterCheckpoint, options: DecideOptions = {}): RouteDecision {
  const result = ruleFor(checkpoint);
  return {
    schema: ROUTER_DECISION_SCHEMA,
    checkpointId: checkpoint.checkpointId,
    action: result.action,
    adviceShape: result.adviceShape,
    contextPolicy: result.contextPolicy,
    confidence: result.confidence,
    reason: result.reason,
    policyVersion: options.policyVersion ?? ROUTER_POLICY_VERSION,
  };
}

export function readCheckpointJsonl(path: string): RouterCheckpoint[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RouterCheckpoint);
}

export function selectCheckpoint(checkpoints: RouterCheckpoint[], checkpointId?: string): RouterCheckpoint {
  const checkpoint = checkpointId
    ? checkpoints.find((candidate) => candidate.checkpointId === checkpointId)
    : checkpoints.at(-1);
  if (!checkpoint) {
    throw new Error(checkpointId ? `checkpoint not found: ${checkpointId}` : "checkpoint file contains no checkpoints");
  }
  return checkpoint;
}

export function decisionId(decision: RouteDecision, checkpoint: RouterCheckpoint): string {
  return hashText(decision.policyVersion, decision.checkpointId, decision.action, checkpoint.rawSessionRef.contentHash);
}
