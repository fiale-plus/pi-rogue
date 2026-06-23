import type {
  AssetRegistry,
  QuoteRequest,
  RouteEconomicsInput,
  RoutePlanChoice,
  RouteKind,
  RouteSavings,
  RouteGuards,
  QuoteResult,
} from "./types.js";

const DEFAULT_TREATED_TOKENS_FOR_TYPED_LENS = 30_000;
const DEFAULT_ROUTE_TPS = 40;
const DEFAULT_MAX_PREMIUM_INPUT_TOKENS = 100_000;
const PROFILE_UNKNOWN: "local-first-economy" = "local-first-economy";

export interface RoutePlanContext {
  request: QuoteRequest;
  registry: AssetRegistry;
  now?: () => string;
}

type ScoredPlan = {
  choice: RoutePlanChoice;
  allowed: boolean;
  reasonBlocked?: string;
  routeScore: number;
};

function asNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRouteTyped(route: RouteKind): boolean {
  return route === "local_first_typed_lens" || route === "cheap_remote_typed_lens" || route === "premium_sealed_packet";
}

function normalizeProfile(profile: string): string {
  return String(profile || PROFILE_UNKNOWN).trim() || PROFILE_UNKNOWN;
}

function typedPolicyScore(profile: string, route: RouteKind): number {
  switch (profile) {
    case "local-only": {
      return route === "local_first_typed_lens" ? 0 : 1.2;
    }
    case "premium-surgical": {
      if (route === "premium_raw_oracle_eval_only") return 0;
      if (route === "premium_sealed_packet") return 0.2;
      if (route === "subscription_hard_call") return 0.3;
      if (route === "cheap_remote_typed_lens") return 0.45;
      return 0.6;
    }
    case "fast-but-not-crazy": {
      if (route === "cheap_remote_typed_lens") return 0;
      if (route === "premium_sealed_packet") return 0.25;
      if (route === "subscription_hard_call") return 0.45;
      if (route === "premium_raw_oracle_eval_only") return 0.95;
      return 0.35;
    }
    default:
      return profile === "local-first-economy" && route === "local_first_typed_lens"
        ? 0
        : profile === "local-first-economy" && route === "cheap_remote_typed_lens"
          ? 0.25
          : 0.5;
  }
}

function routeOrderPenalty(route: RouteKind): number {
  switch (route) {
    case "local_first_typed_lens":
      return 0;
    case "cheap_remote_typed_lens":
      return 1;
    case "subscription_hard_call":
      return 2;
    case "premium_sealed_packet":
      return 3;
    case "premium_raw_oracle_eval_only":
      return 4;
    default:
      return 5;
  }
}

function isProfileAllowsPremiumRaw(profile: string, req: QuoteRequest): boolean {
  if (req.evalOnly) return true;
  return profile === "premium-surgical" && (req.repeatedFailureHint ?? 0) >= 2;
}

function estimateTokensForRoute(
  route: RouteKind,
  request: QuoteRequest,
): {
  input: number;
  forwardedSavings: number;
} {
  const rawInput = Math.max(0, Math.floor(request.rawInputTokensApprox));
  const forwardedInput =
    request.contextPolicy === "typed_lens"
      ? Math.max(0, Math.floor(request.forwardedInputTokensApprox))
      : rawInput;
  const typedInput =
    request.contextPolicy === "typed_lens"
      ? Math.min(forwardedInput, rawInput)
      : rawInput;

  const fallbackTypedInput = Math.min(rawInput, rawInput - DEFAULT_TREATED_TOKENS_FOR_TYPED_LENS);
  const typedSavings = rawInput - typedInput;

  if (route === "premium_raw_oracle_eval_only") {
    return {
      input: rawInput,
      forwardedSavings: Math.max(0, 0),
    };
  }

  if (route === "subscription_hard_call") {
    return {
      input: request.contextPolicy === "typed_lens" ? typedInput : rawInput,
      forwardedSavings: Math.max(0, typedSavings),
    };
  }

  if (route === "premium_sealed_packet" || isRouteTyped(route)) {
    const effectiveInput = request.contextPolicy === "typed_lens" ? typedInput : rawInput;
    return {
      input: effectiveInput,
      forwardedSavings: typedSavings > 0 ? typedSavings : fallbackTypedInput,
    };
  }

  return {
    input: rawInput,
    forwardedSavings: 0,
  };
}

function buildPlanChoice(
  route: RouteKind,
  assetId: string,
  request: QuoteRequest,
  asset: AssetRegistry["assets"][string],
): RoutePlanChoice {
  const { input, forwardedSavings } = estimateTokensForRoute(route, request);
  const output = Math.max(0, Math.floor(request.expectedOutputTokensApprox));
  const tps = Math.max(0.0001, asNumber(asset.observedTps) || DEFAULT_ROUTE_TPS);
  const wallTime = Math.max(1, (input + output) / tps);
  const wallTimeMs = Math.max(1, Math.round(wallTime * 1000));

  const cacheSavedUsd =
    isRouteTyped(route) && forwardedSavings > 0
      ? (asNumber(asset.cachedInputCostPerMTok) * forwardedSavings) / 1_000_000
      : 0;

  const inputCost = asNumber(asset.inputCostPerMTok);
  const outputCost = asNumber(asset.outputCostPerMTok);
  const metered =
    (input * inputCost) / 1_000_000 +
    (output * outputCost) / 1_000_000 -
    Math.max(0, cacheSavedUsd);

  const quotaCost =
    asset.class === "subscription_quota" && route === "subscription_hard_call"
      ? Math.max(0, (asNumber(asset.quotaResetHours) ? asNumber(asset.quotaResetHours) / 24_000 : 0))
      : 0;

  const total = metered + quotaCost;

  return {
    asset: assetId,
    route,
    estimatedWallTimeMs: wallTimeMs,
    estimatedMeteredUsd: metered,
    estimatedQuotaCost: quotaCost,
    estimatedTotalTokenCostUsd: total,
    reason:
      asset.class === "owned_capacity"
        ? "owned local capacity route"
        : asset.class === "subscription_quota"
          ? "quota-bounded route"
          : "metered route with policy-aware context shaping",
    rawInputTokensApprox: request.rawInputTokensApprox,
    forwardedInputTokensApprox: request.forwardedInputTokensApprox,
  };
}

function routeAllowed(route: RouteKind, asset: AssetRegistry["assets"][string], request: QuoteRequest): string | null {
  switch (route) {
    case "local_first_typed_lens":
      if (asset.privacy !== "local") return "local_first_typed_lens requires local asset";
      if (request.contextPolicy !== "typed_lens") return "local-first typed-lens route requires typed lens context";
      return null;

    case "cheap_remote_typed_lens":
      if (asset.privacy !== "remote") return "cheap_remote_typed_lens requires remote candidate";
      if (asset.class === "subscription_quota") return "subscription assets are not eligible for cheap-tunnel lane";
      if (request.contextPolicy !== "typed_lens") return "typed-lens route requires typed context";
      if (request.taskKind && /oracle|eval/i.test(request.taskKind) && request.evalOnly !== true) {
        return "oracle/eval tasks should route to premium only when evalOnly is set";
      }
      return null;

    case "subscription_hard_call":
      if (asset.class !== "subscription_quota") return "subscription hard-call requires subscription_quota asset class";
      if ((asset.quotaRemaining ?? 0) <= 0) return "subscription_quota depleted";
      return null;

    case "premium_sealed_packet":
      if (asset.privacy !== "remote") return "sealed premium route expects remote privacy class";
      if (asset.qualityTier === "cheap") return "cheap assets cannot satisfy sealed premium route";
      if (request.expectedOutputTokensApprox <= 0) return "output estimate required for premium sealed route";
      return null;

    case "premium_raw_oracle_eval_only":
      if (!isProfileAllowsPremiumRaw(normalizeProfile(request.profile), request)) {
        return "premium raw oracle requires evalOnly or premium-surgical repeated failure mode";
      }
      if (asset.privacy !== "remote") return "premium raw oracle requires remote asset";
      if ((asNumber(request.rawInputTokensApprox) || 0) > DEFAULT_MAX_PREMIUM_INPUT_TOKENS) {
        return `raw premium payload above guard (${DEFAULT_MAX_PREMIUM_INPUT_TOKENS} tokens)`;
      }
      return null;

    default:
      return `unsupported route ${route}`;
  }
}

function scoreCandidate(route: RouteKind, choice: RoutePlanChoice, profile: string, request: QuoteRequest): number {
  const base = typedPolicyScore(profile, route) * 10;
  const routePenalty = routeOrderPenalty(route) * 75;
  const wallPenalty = choice.estimatedWallTimeMs / 1000;
  const costPenalty = Math.max(0, choice.estimatedTotalTokenCostUsd) * 1000;
  const repeatedPenalty =
    (request.repeatedFailureHint ?? 0) > 1 && !route.startsWith("premium")
      ? ((request.repeatedFailureHint ?? 0) - 1) * 125
      : 0;

  return base + routePenalty + wallPenalty + costPenalty + repeatedPenalty;
}

function toSavingsValue(candidate: RoutePlanChoice | undefined): number {
  return candidate ? Math.max(0, candidate.estimatedTotalTokenCostUsd) : 0;
}

export function quoteRoute(context: RoutePlanContext): QuoteResult {
  const request = context.request;
  const profile = normalizeProfile(request.profile);

  const requestedAssetIds =
    request.candidateAssets.length > 0
      ? request.candidateAssets
      : Object.keys(context.registry.assets);

  const routeOptions: RouteKind[] = [
    "local_first_typed_lens",
    "cheap_remote_typed_lens",
    "subscription_hard_call",
    "premium_sealed_packet",
    "premium_raw_oracle_eval_only",
  ];

  const ranked: ScoredPlan[] = [];
  for (const assetId of requestedAssetIds) {
    const asset = context.registry.assets[assetId];
    if (!asset) {
      const reason = `candidate asset '${assetId}' not found in registry`;
      ranked.push({
        choice: {
          asset: assetId,
          route: "cheap_remote_typed_lens",
          estimatedWallTimeMs: Number.POSITIVE_INFINITY,
          estimatedMeteredUsd: 0,
          estimatedQuotaCost: 0,
          estimatedTotalTokenCostUsd: Number.POSITIVE_INFINITY,
          reason,
        },
        allowed: false,
        reasonBlocked: reason,
        routeScore: Number.POSITIVE_INFINITY,
      });
      continue;
    }

    for (const route of routeOptions) {
      const reasonBlocked = routeAllowed(route, asset, request);
      const choice = buildPlanChoice(route, assetId, request, asset);
      const allowed = reasonBlocked === null;
      const routeScore = scoreCandidate(route, choice, profile, request) + (allowed ? 0 : 1_000_000);
      ranked.push({ choice, allowed, reasonBlocked: reasonBlocked ?? undefined, routeScore });
    }
  }

  const sorted = ranked
    .slice()
    .sort((a, b) => {
      if (a.routeScore !== b.routeScore) return a.routeScore - b.routeScore;
      return a.choice.route.localeCompare(b.choice.route) || a.choice.asset.localeCompare(b.choice.asset);
    });

  const selectedPlan = sorted.find((entry) => entry.allowed) ?? sorted[0];
  if (!selectedPlan) {
    throw new Error("no route candidates available");
  }

  const selected = { ...selectedPlan.choice, reasonNotChosen: undefined };

  const alternatives: RoutePlanChoice[] = sorted
    .filter((entry) => entry !== selectedPlan)
    .map((entry) => {
      const reasonNotChosen = entry.reasonBlocked
        ? entry.reasonBlocked
        : `score worse than selected (${(entry.routeScore - (selectedPlan?.routeScore ?? 0)).toFixed(3)})`;

      return {
        ...entry.choice,
        reasonNotChosen,
      };
    });

  const premiumRaw = sorted.find((entry) => entry.choice.route === "premium_raw_oracle_eval_only" && Number.isFinite(entry.choice.estimatedTotalTokenCostUsd));
  const premiumSealed = sorted.find((entry) => entry.choice.route === "premium_sealed_packet" && Number.isFinite(entry.choice.estimatedTotalTokenCostUsd));
  const localFirst = sorted.find((entry) => entry.choice.route === "local_first_typed_lens" && Number.isFinite(entry.choice.estimatedTotalTokenCostUsd));

  const savings: RouteSavings = {
    tokensAvoidedByContextLens: Math.max(
      0,
      (context.request.contextPolicy === "typed_lens")
        ? Math.max(0, context.request.rawInputTokensApprox - context.request.forwardedInputTokensApprox)
        : Math.min(DEFAULT_TREATED_TOKENS_FOR_TYPED_LENS, context.request.rawInputTokensApprox),
    ),
    premiumRawVsPremiumSealedUsdSaved: toSavingsValue(premiumRaw?.choice) - toSavingsValue(premiumSealed?.choice),
    premiumRawVsSelectedUsdSaved: toSavingsValue(premiumRaw?.choice) - toSavingsValue(selectedPlan?.choice),
    cacheSavingsEstimatedUsd:
      selectedPlan.choice.estimatedTotalTokenCostUsd /
      (selectedPlan.choice.estimatedWallTimeMs > 0 ? selectedPlan.choice.estimatedWallTimeMs : 1),
    localFirstSavingsEstimatedUsd:
      toSavingsValue(localFirst?.choice) - toSavingsValue(selectedPlan?.allowed ? selectedPlan.choice : undefined),
  };

  const premiumRequirements: string[] = [];
  if (!isProfileAllowsPremiumRaw(profile, context.request)) {
    premiumRequirements.push("set evalOnly=true for premium_raw_oracle_eval_only");
  }

  const guards: RouteGuards = {
    rawFullContextToPremium: !isProfileAllowsPremiumRaw(profile, context.request),
    maxPremiumInputTokens: DEFAULT_MAX_PREMIUM_INPUT_TOKENS,
    premiumRequires: premiumRequirements,
  };

  const now = context.now ? context.now() : new Date().toISOString();
  void now;

  return {
    selected,
    alternatives,
    savings,
    guards,
  };
}

export function buildRouteEconomicsInput(selected: RoutePlanChoice, alternatives: RoutePlanChoice[]): RouteEconomicsInput {
  const candidateAssets = [selected, ...alternatives].map((item) => item.asset);
  const uniqueAssets = Array.from(new Set(candidateAssets));

  const baseline = alternatives.find((item) => item.route === "premium_raw_oracle_eval_only") ?? selected;
  const savings: RouteSavings = {
    tokensAvoidedByContextLens: Math.max(0, selected.rawInputTokensApprox ?? 0),
    premiumRawVsPremiumSealedUsdSaved: (baseline.estimatedTotalTokenCostUsd || 0) - (selected.estimatedTotalTokenCostUsd || 0),
    premiumRawVsSelectedUsdSaved: (baseline.estimatedTotalTokenCostUsd || 0) - (selected.estimatedTotalTokenCostUsd || 0),
    cacheSavingsEstimatedUsd: selected.estimatedWallTimeMs > 0 ? (selected.estimatedMeteredUsd / 10_000) : 0,
    localFirstSavingsEstimatedUsd: alternatives
      .filter((item) => item.route !== selected.route)
      .reduce((acc, item) => acc + Math.max(0, (item.estimatedTotalTokenCostUsd || 0) - (selected.estimatedTotalTokenCostUsd || 0)), 0),
  };

  const guards: RouteGuards = {
    rawFullContextToPremium: false,
    maxPremiumInputTokens: DEFAULT_MAX_PREMIUM_INPUT_TOKENS,
    premiumRequires: [],
  };

  return {
    asset: selected.asset,
    route: selected.route,
    runId: "prototype-run",
    candidateAssets: uniqueAssets,
    selected,
    alternatives,
    savings,
    guards,
  };
}
