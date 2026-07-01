export const ROGUE_GATEWAY_SCHEME = "pi-rogue-gateway.v0" as const;

export type AssetClass =
  | "owned_capacity"
  | "metered_api"
  | "subscription_quota"
  | "composite_fusion"
  | "mock";

export type QualityTier = "cheap" | "mid" | "smart" | "frontier";

export type PrivacyClass = "local" | "remote";

export interface GatewayAsset {
  class: AssetClass;
  substrate: string;
  model: string;
  contextWindow?: number;
  observedTps?: number;
  inputCostPerMTok?: number;
  cachedInputCostPerMTok?: number;
  outputCostPerMTok?: number;
  quotaRemaining?: number;
  quotaResetHours?: number;
  privacy: PrivacyClass;
  qualityTier: QualityTier;
  tags?: string[];
}

export interface AssetRegistry {
  assets: Record<string, GatewayAsset>;
}

export type RouterProfile =
  | "local-only"
  | "local-first-economy"
  | "fast-but-not-crazy"
  | "premium-surgical"
  | string;

export type ContextPolicy = "typed_lens" | "raw_forward" | "none" | string;

export type RouteKind =
  | "local_first_typed_lens"
  | "cheap_remote_typed_lens"
  | "subscription_hard_call"
  | "premium_sealed_packet"
  | "premium_raw_oracle_eval_only";

export interface QuoteRequest {
  profile: RouterProfile;
  taskKind: string;
  rawInputTokensApprox: number;
  forwardedInputTokensApprox: number;
  expectedOutputTokensApprox: number;
  contextPolicy: ContextPolicy;
  candidateAssets: string[];
  repeatedFailureHint?: number;
  evalOnly?: boolean;
  latencyPreference?: "latency" | "quality" | "cost";
}

export interface RouteEconomicsInput {
  asset: string;
  route: RouteKind;
  runId: string;
  candidateAssets: string[];
  selected: RoutePlanChoice;
  alternatives: RoutePlanChoice[];
  savings: RouteSavings;
  guards: RouteGuards;
}

export interface RoutePlanChoice {
  asset: string;
  route: RouteKind;
  estimatedWallTimeMs: number;
  estimatedMeteredUsd: number;
  estimatedQuotaCost: number;
  estimatedTotalTokenCostUsd: number;
  reason: string;
  rawInputTokensApprox?: number;
  forwardedInputTokensApprox?: number;
  reasonNotChosen?: string;
}

export interface RouteSavings {
  tokensAvoidedByContextLens: number;
  premiumRawVsPremiumSealedUsdSaved: number;
  premiumRawVsSelectedUsdSaved: number;
  cacheSavingsEstimatedUsd: number;
  localFirstSavingsEstimatedUsd: number;
}

export interface RouteGuards {
  rawFullContextToPremium: boolean;
  maxPremiumInputTokens: number;
  premiumRequires: string[];
}

export interface QuoteResult {
  selected: RoutePlanChoice;
  alternatives: RoutePlanChoice[];
  savings: RouteSavings;
  guards: RouteGuards;
}

export interface RoutePlanCandidate {
  asset: string;
  route: RouteKind;
  forwardedInputTokensApprox: number;
  rawInputTokensApprox: number;
  outputTokensApprox: number;
  estimatedWallTimeMs: number;
  estimatedMeteredUsd: number;
  estimatedQuotaCost: number;
  estimatedTotalTokenCostUsd: number;
  reason: string;
  allowed: boolean;
  reasonBlocked?: string;
}

export interface EventRecord {
  eventId: string;
  runId: string;
  type:
    | "request_received"
    | "profile_resolved"
    | "artifact_detected"
    | "context_lens_created"
    | "economics_quoted"
    | "route_planned"
    | "upstream_call_started"
    | "upstream_call_finished"
    | "cache_estimated"
    | "context_lookup"
    | "response_returned";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface RunRecord {
  runId: string;
  request: QuoteRequest;
  createdAt: string;
}
