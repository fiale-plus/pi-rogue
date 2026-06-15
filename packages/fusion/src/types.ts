export type FusionReasoningEffort = "low" | "medium" | "high";

export interface FusionRecipe {
  schema: "pi-rogue.fusion.recipe.v1";
  kind: "fusion";
  id: string;
  /** Judge and final synthesis model. */
  model: string;
  /** Comparable independent attempts. Same task, no role prompts. */
  analysis_models: string[];
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

export interface FusionFailedModel {
  model: string;
  error: string;
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
