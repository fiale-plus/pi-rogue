# Commodity Gateway Substrate Check (Issue #207)

## 1) Which parts would be duplicated if Rogue built everything from scratch?
- Auth/key tenanting + provider credential flows
- OpenAI-compatible request/response normalization and protocol compatibility matrix
- Retry/circuit-breaker/failover logic
- Rate limiting, budget enforcement, and usage/cost accounting logic
- Caching, retries, load balancing, and failover orchestration
- Operational observability layers (dashboards, hooks, request tracing)

## 2) Which parts can LiteLLM/Portkey own?
- Commodity gateway concerns above (key handling, retries, policy config, routing policies, budget/rate-limit enforcement, usage telemetry, failover/fallbacks, etc.)
- In practice, these are best delegated to avoid reimplementation in Rogue and keep this package focused.

## 3) Can Rogue sit in front of a generic OpenAI-compatible substrate?
**Yes.** `OpenAICompatibleSubstrate` intentionally implements a minimal adapter that calls `GET /models` and `POST /chat/completions` over a configurable base URL and optional API key, so Rogue can evaluate routing decisions without assuming a specific gateway vendor.

## 4) Does Rogue require substrate-specific code for the tokenomics/context logic?
**No.** Routing/tokenomics decisions are computed in `src/planner.ts` using normalized `GatewayAsset` metadata and context-profile + task heuristics (no vendor-specific branch logic).

## 5) What minimal substrate interface was enough?
The minimal interface was:
- `listModels()`
- `callChat(req)`
- optional `estimateCost(req)`
- optional `getUsage(runId)`

This has been sufficient for deterministic planning and explainable alternatives in the spike.

## 6) What would be painful to outsource?
- Rogue’s own policy semantics: local-first preference, context-lens scoring, deterministic alternatives/reasons, and explanation-ready savings calculations.
- If these are moved into external gateways, we lose the same decision traceability and control Rogue needs for policy-level policy evolution.

## Notes
- This spike does not include LiteLLM/Portkey as hard dependencies (matching the requested scope).
- Live LiteLLM/Portkey runtime checks are out-of-scope for this PR and remain optional follow-up validations.
