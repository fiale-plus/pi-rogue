# Fusion composite model provider (OpenRouter-style comparable panels)

**Type:** Feature / research spike
**Area:** `packages/bundle`, new `packages/fusion` or bundle-local provider, `packages/core`, `packages/context-broker`, local AI lab
**Date:** 2026-06-15
**Priority:** High-impact experiment, active command surface with recipe-driven model registration

## Summary

Add a Pi-Rogue `fusion/*` composite model surface inspired by OpenRouter Fusion: run multiple comparable model attempts in parallel, judge the responses, and return one final assistant answer plus trace metadata.

The key product rule for v1:

> `analysis_models` means comparable independent attempts on the same task. Do not mix critic/researcher/verifier role semantics into this schema.

Role-based deliberation can be a later, separate recipe family with a different judge schema.

## Why now

OpenRouter has published a Fusion pipeline where a panel of models answers in parallel and a **judge** compares outputs for consensus, contradictions, partial coverage, unique insights, and blind spots. In that flow, OpenRouter returns structured analysis from the judge, and then the outer model performs **synthesis** into the final answer. Their docs describe:

- panel + judge calls, not simple majority voting;
- web search/fetch available to panel and judge in their hosted environment;
- recoverable partial panel failures when at least one panel model succeeds;
- judge degradation as non-fatal: return raw panel responses even if judge JSON fails;
- recursion protection via Fusion depth;
- cost scaling roughly linearly with panel size (`N` panel calls + judge + outer request).

This is directly relevant to Pi-Rogue because current local/SOTA routing work already optimizes when to spend expensive model calls, and the local AI lab can benchmark whether cheap local/self-fusion provides enough diversity to be useful.

## Current repo context

This ticket should be shaped against the current repository, not older router assumptions:

- There is no current `packages/router` package in this workspace.
- The public artefact is the single bundled package `@fiale-plus/pi-rogue` in `packages/bundle`.
- `packages/bundle/src/extension.ts` currently registers:
  - context broker beta (unless disabled),
  - advisor,
  - orchestration.
- Advisor model choice is currently simple:
  - `AdvisorConfig.model?: string` accepts `<provider>/<model>` overrides.
  - `resolveModelCandidates()` finds models through `ctx.modelRegistry.find(provider, modelId)` and uses `completeSimple()`.
  - fallback chain is hardcoded SOTA models plus regular text models.
- Pi supports extension-registered custom providers through `pi.registerProvider()` with optional custom `streamSimple`.
- Context broker artifact kinds currently are:
  - `tool_output`, `diff`, `file_snapshot`, `subagent_result`, `advisor_brief`, `memory_note`.
- The local AI lab already has an opt-in benchmarking harness at `scripts/bench-local-ai-platform.ts` and `docs/local-ai-platform-lab.md`.

Implication: implement Fusion as a Pi model provider / composite model surface, not as a router-profile feature. Existing consumers should be able to refer to `fusion/<recipe-id>` anywhere they can already select a model.

## Proposed v1 shape

### Recipe schema

Keep the public recipe schema OpenRouter-compatible and model-centric:

```ts
type FusionRecipe = {
  schema: "pi-rogue.fusion.recipe.v1";
  kind: "fusion";
  id: string;

  // Judge/final synthesis model.
  model: string;

  // Comparable independent analysis-only attempts. Same task, no role prompts, no tool calls, no writes.
  analysis_models: string[];

  max_tool_calls?: number; // v1 may accept but ignore unless tool forwarding exists.
  max_completion_tokens?: number;
  temperature?: number;
  reasoning?: {
    effort?: "low" | "medium" | "high";
    max_tokens?: number;
  };

  timeout_ms?: number;
  per_model_timeout_ms?: number;
  allow_partial_panel?: boolean; // default true if >=1 success.
};
```

Example recipes:

```json
{
  "schema": "pi-rogue.fusion.recipe.v1",
  "kind": "fusion",
  "id": "local-self2",
  "model": "local/qwen3.6-35b-a3b-128k",
  "analysis_models": [
    "local/qwen3.6-35b-a3b-128k",
    "local/qwen3.6-35b-a3b-128k"
  ],
  "max_completion_tokens": 900,
  "temperature": 0.5,
  "timeout_ms": 90000
}
```

```json
{
  "schema": "pi-rogue.fusion.recipe.v1",
  "kind": "fusion",
  "id": "research-budget",
  "model": "anthropic/claude-opus-4.8",
  "analysis_models": [
    "google/gemini-3-flash-preview",
    "moonshotai/kimi-k2.6",
    "deepseek/deepseek-v4-pro"
  ],
  "max_completion_tokens": 4096,
  "temperature": 0.4,
  "reasoning": { "effort": "medium", "max_tokens": 2048 }
}
```

### Model/provider surface

Register a dynamic provider named `fusion` so recipes appear as normal model ids:

```txt
fusion/local-self2
fusion/research-budget
fusion/review-budget
```

Potential config path:

```txt
~/.pi/agent/pi-rogue/fusion/recipes.json
```

or repo/dev override:

```txt
.pi-rogue/fusion/recipes.json
```

The `/fusion` command is part of Pi-Rogue by default. The provider registers `fusion/<recipe-id>` models when recipes exist; when no recipes are present, no Fusion models are added.

### Runtime behavior

For a `fusion/<recipe-id>` completion:

1. Resolve recipe by id.
2. Reject recursive/cyclic fusion unless an explicit experimental flag is set.
3. Resolve each `analysis_models[]` entry through `modelRegistry.find(provider, modelId)`.
4. Run panel completions in parallel against the same prompt/context.
5. Treat panel failures as recoverable when at least one panel response succeeds.
6. Run judge model with raw panel outputs and request strict JSON analysis:

```ts
type FusionJudgeAnalysis = {
  consensus: string[];
  contradictions: string[];
  partial_coverage: string[];
  unique_insights: string[];
  blind_spots: string[];
  unsupported_claims?: string[];
  confidence: "low" | "medium" | "high";
};
```

7. If judge JSON fails, return a panel-only degraded answer rather than failing the whole request.
8. Synthesize final assistant response from judge analysis + panel responses (this synthesis is the outer model, not a separate Fusion stage).
9. Persist rich trace metadata outside prompt context.

### Context broker integration

Add one new artifact kind:

```ts
"fusion_result"
```

Do **not** add `fusion_pass` in v1. Raw panel responses can be large and should not become hot prompt context by default.

Suggested storage split:

```txt
.pi/fusion/runs/<runId>.json
  full trace: recipe, panel responses, judge analysis, failures, timings, tokens, costs, params

context broker fusion_result artifact
  compact summary: consensus, contradictions, blind spots, unsupported claims,
  unique insights, final answer summary, trace path/handle
```

Default tier: `warm`; use `hot` only when the run has failures/contradictions relevant to the active turn.

## Non-goals for v1

- No role-based passes in the `fusion` schema.
- No `critic` / `researcher` / `optimizer` role prompts under `analysis_models`.
- No silent context middle-out compression.
- No recursive `fusion/*` inside `fusion/*` by default.
- No mandatory public command surface beyond model registration/config docs.
- Streaming aggregation may be explicitly deferred; if unsupported, fail clearly instead of pretending to stream.
- Do not publish separate user-facing packages; ship only through canonical `@fiale-plus/pi-rogue` bundle policy.

## Implementation plan

### Phase 0 — API feasibility spike

- Confirm the custom provider `streamSimple(model, context, options)` path can access or close over the live `modelRegistry` needed to resolve member models and auth.
- If provider-level access is insufficient, define an advisor-only fallback path first, but keep the public recipe/schema provider-shaped.
- Confirm cancellation/timeout behavior with `SimpleStreamOptions.signal`.

### Phase 1 — Core recipe + runner

Create a small internal module, preferably `packages/fusion` if the workspace wants separation, otherwise bundle-local first:

- `loadFusionRecipes()` with schema validation and clear errors.
- `parseModelRef("provider/model")`.
- `validateFusionRecipe()` including:
  - nonempty `analysis_models`,
  - no direct recursion/cycles,
  - bounded panel size,
  - bounded token/time settings.
- `runFusionCompletion()` that returns:

```ts
type FusionRunResult = {
  status: "ok" | "error";
  recipe_id: string;
  run_id: string;
  final_text?: string;
  analysis?: FusionJudgeAnalysis;
  responses: Array<{ model: string; content: string; wall_ms: number }>;
  failed_models: Array<{ model: string; error: string }>;
  degraded?: "judge_failed" | "panel_partial" | "panel_only";
  requested_params: unknown;
  effective_params?: unknown;
};
```

### Phase 2 — Provider registration

- Register `fusion` provider from `packages/bundle/src/extension.ts` only when enabled.
- Each recipe becomes a model in `/model`, e.g. `fusion/local-self2`.
- Use custom `streamSimple` to emit a normal assistant text response and attach metadata where possible.
- If true streaming is deferred, document that the provider emits only after completion.

### Phase 3 — Context broker + traces

- Extend `ContextArtifactKind` in `packages/core/src/context-broker.ts` with `fusion_result`.
- Update context broker tests for kind filtering/rendering if needed.
- Write full run traces to a local path and publish compact broker summaries.
- Ensure raw panel bodies are not injected into broker briefs by default.

### Phase 4 — Local AI lab benchmark

Extend `scripts/bench-local-ai-platform.ts` or add a sibling fusion benchmark to compare:

```txt
direct-local
fusion/local-self2-roleless
fusion/local-self3-roleless
fusion/mixed-budget-roleless
```

Track at least:

```ts
type FusionBenchMetric = {
  recipe_id: string;
  score: number;
  major_error: boolean;
  wall_ms: number;
  json_valid: boolean;
  judge_analysis_present: boolean;
  failed_models: string[];
  panel_similarity: number;
  final_accept: boolean;
};
```

Same-model local Fusion needs `panel_similarity`; if repeated local passes are >95% similar, try temperature/seed/retrieval variation before adding role prompts.

## Acceptance criteria

- `/fusion` is available by default, and configured `fusion/<recipe-id>` models register when recipes exist.
- If no recipes exist, no Fusion models are registered.
- `/fusion configure` can create at least one roleless recipe from scoped session-visible text models.
- A roleless recipe with two local or configured models can complete a prompt and return a final assistant answer.
- Partial panel failure succeeds when at least one panel model succeeds and records `failed_models`.
- Judge failure is non-fatal and produces a clearly marked degraded result.
- Recursive `fusion/*` model refs are rejected by default with a clear error.
- Full trace is written to disk; context broker stores only compact `fusion_result` summary plus trace reference.
- Tests cover recipe validation, model-ref parsing, default command/provider behavior, configure add/remove basics, partial failures, judge JSON repair/failure, recursion rejection, and context artifact kind support.
- Docs explain cost/latency multiplication, analysis-only/no-side-effect panel semantics, and the distinction between Fusion and role-based deliberation.

## Open questions

- Should the first implementation live as `packages/fusion` or inside `packages/bundle` until proven?
- What is the best user config location for recipes: `~/.pi/agent/pi-rogue/fusion/recipes.json`, `~/.pi/agent/fiale-plus/fusion/recipes.json`, or `.pi-rogue/fusion/recipes.json` for repo-local experiments?
- Can provider metadata include `fusion_run_id`, `recipe_id`, and `analysis_models` without placing them in the assistant body?
- Is there a stable way to pass per-call temperature through Pi `completeSimple()` for arbitrary providers, or should v1 record requested temperature but accept provider-dependent behavior?
- Should web/search/tool fanout stay entirely outside panel models, with write-capable work reserved for explicit Pi tools/agents after synthesis?

## Suggested first PR scope

Keep the first PR small:

1. Add recipe types/validation and a pure runner test harness with fake member completions.
2. Add `fusion_result` artifact kind and tests.
3. Add docs with example recipes and explicit non-goals.

Then follow with provider registration once the Pi provider API feasibility is proven.

## Terminology (for broad readers)

Use OpenRouter-native wording where possible:

- **panel**: `analysis_models` runs.
- **judge**: structured comparison step producing `analysis` (`consensus`, `contradictions`, `partial_coverage`, `unique_insights`, `blind_spots`).
- **synthesis**: the final model composing the user-visible answer from judge analysis + panel responses.

So the short phrase in docs should be **“judge-and-synthesis”** (or just “judge + synthesis”), not a replacement term.

