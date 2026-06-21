export type FusionReasoningEffort = "low" | "medium" | "high";

export interface FusionRecipe {
  schema: "pi-rogue.fusion.recipe.v1";
  kind: "fusion";
  id: string;
  /** Judge and final synthesis model. */
  model: string;
  /** Comparable independent attempts. Same task, no role prompts. */
  analysis_models: string[];
  /**
   * Optional explicit minimum number of successful panel responses required to continue.
   * Defaults to ceil(2/3 * analysis_models.length), with a minimum of 1.
   */
  min_panel_success?: number;
  max_tool_calls?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning?: {
    effort?: FusionReasoningEffort;
    max_tokens?: number;
  };
  timeout_ms?: number;
  per_model_timeout_ms?: number;
  allow_partial_panel?: boolean;
}

export interface FusionJudgeAnalysis {
  consensus: string[];
  contradictions: string[];
  partial_coverage: string[];
  unique_insights: string[];
  blind_spots: string[];
  unsupported_claims?: string[];
  confidence: "low" | "medium" | "high";
}

export interface FusionPanelResponse {
  model: string;
  content: string;
  wall_ms: number;
}

export type FusionFailureCategory =
  | "usage_limit_reached"
  | "rate_limit"
  | "auth_error"
  | "network_error"
  | "context_length_exceeded"
  | "timeout"
  | "aborted"
  | "provider_error"
  | "unknown";

export interface FusionFailureMeta {
  category: FusionFailureCategory;
  type?: string;
  code?: string;
  status_code?: number;
  reset_in_seconds?: number;
  reset_at?: number;
  retry_after?: number;
  plan_type?: string;
}

export interface FusionFailedModel {
  model: string;
  error: string;
  details?: FusionFailureMeta;
}

export interface FusionRunResult {
  status: "ok" | "error";
  recipe_id: string;
  run_id: string;
  final_text?: string;
  analysis?: FusionJudgeAnalysis;
  responses: FusionPanelResponse[];
  failed_models: FusionFailedModel[];
  degraded?: "judge_failed" | "panel_partial" | "panel_only" | "synthesis_failed";
  judge_error?: string;
  /** Local trace-only diagnostic; broker payloads must not publish this raw text. */
  judge_raw?: string;
  requested_params: unknown;
  effective_params?: unknown;
  trace_path?: string;
  error?: string;
}

export interface ParsedModelRef {
  provider: string;
  model: string;
}
