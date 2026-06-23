# @fiale-plus/pi-rogue-gateway

Spike package for the **Rogue Gateway** prototype.

This package is intentionally scoped to three concerns:

- gateway substrate boundary (`GatewaySubstrate`, `substrate-mock`, `substrate-openai-compatible`)
- tokenomics planner (`quoteRoute`, `RoutePlanChoice`, `QuoteResult`, route selection)
- event ledger hooks for run-level explainability (`events.ts`)

The code is intentionally conservative and deterministic, designed to prove that
Rogue can own **routing/policy/tokenomics** without reimplementing commodity
provider/gateway plumbing.

## Commodity Gateway Substrate Check

Issue #207 requires an explicit check against LiteLLM/Portkey-style commodities. This spike’s scope is intentionally narrow and the results are:

1. **Which parts would be duplicated if Rogue built everything from scratch?**
   - Provider auth/key/tenant wiring, protocol drift handling (OpenAI-compatible endpoints/headers), retries, circuit-breaking, and fallbacks.
   - Budget/rate-limit enforcement, spend/usage accounting, audit trails, and production-grade observability.
   - Retry policy DSLs, multi-endpoint failover/load-balancing, and gateway caching/normalization layers.

2. **Which parts can LiteLLM/Portkey own?**
   - Those commodity runtime concerns above (routing rules, retries, budgets, key management, provider fan-out/failover, cost metrics, dashboarding).
   - In a full product shape, these can remain delegated so Rogue does not become another gateway implementation.

3. **Can Rogue sit in front of a generic OpenAI-compatible substrate?**
   - **Yes (within this spike).**
   - `OpenAICompatibleSubstrate` in `src/substrate-openai-compatible.ts` only assumes a base URL + optional API key and `/models`, `/v1/models`, and `/chat/completions`-style flows.
   - Local smoke tests verify model listing and chat-call plumbing against a mock compatible endpoint.

4. **Does Rogue require substrate-specific code for tokenomics/context logic?**
   - **No.**
   - Routing/tokenomics policy is driven by the provided `GatewayAsset`/candidate metadata (`quoteRoute` in `src/planner.ts`) and is decoupled from any provider API details.
   - The planner operates on normalized assets + route heuristics (`local_first`, raw/sealed/context-lens variants), not on vendor SDK semantics.

5. **What minimal substrate interface was enough?**
   - `GatewaySubstrate` (`src/substrate.ts`) with `listModels`, `callChat`, optional `estimateCost`, and optional `getUsage`.
   - This was sufficient to validate deterministic planning plus route observability without hard binding to any vendor.

6. **What is painful to outsource?**
   - Anything tied to Rogue’s own product semantics: task/profile-specific scoring, local-first policy, context-lens savings accounting, and deterministic explainable route reasons.
   - Those are explicitly implemented in Rogue to keep behavior explainable, while gateway plumbing remains external.

### Explicitly out-of-scope for this spike

- No hard dependency on LiteLLM or Portkey in-package (consistent with the issue request).
- No production gateway execution path (no claim to own full retry/key/dashboard/resilience stack).
- Optional non-blocking manual checks remain pending (e.g., live LiteLLM Proxy and Portkey runs) and were not a CI requirement for this PR.

Full written answers for the ticket’s required Commodity Gateway Substrate Check (including the 1..6 questions) are in:
`packages/rogue-gateway/COMMODITY_GATEWAY_SUBSTRATE_CHECK.md`.
