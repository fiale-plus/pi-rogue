# Pi-Rogue Fusion

Opt-in OpenRouter-style Fusion composite model provider for Pi-Rogue.

Fusion is a **comparable panel + judge-and-synthesis** flow:

1. `analysis_models` run the same task independently.
2. The judge compares panel responses and emits structured analysis: `consensus`, `contradictions`, `partial_coverage`, `unique_insights`, `blind_spots`, and optional `unsupported_claims`.
3. The synthesis model writes the final user-facing answer from the judge analysis and panel responses.

In v1, `analysis_models` are plain model refs, not role prompts. Critic/researcher/verifier role passes are a separate future recipe family, not Fusion.

Pi agents/subagents and pi-intercom fit this concept well, but they should not be smuggled into `analysis_models`. Treat them as an **agentic panel** extension: same comparable-task semantics, different execution substrate.

## Enable

Fusion is disabled by default.

```bash
PI_ROGUE_FUSION_ENABLED=1 pi
```

You can also load/reload explicitly during a trusted session:

```text
/fusion reload
/fusion status
```

## Recipe file

Pi-Rogue searches the first existing file from:

1. `$PI_ROGUE_FUSION_RECIPES`
2. `.pi-rogue/fusion/recipes.json`
3. `.pi/fusion/recipes.json`
4. `~/.pi/agent/pi-rogue/fusion/recipes.json`

Shape:

```json
{
  "recipes": [
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
  ]
}
```

When loaded, recipes appear as normal models:

```text
fusion/local-self2
```

## Safety and limits

- Partial panel failure is recoverable by default if at least one panel model succeeds.
- Judge JSON failure is non-fatal; synthesis falls back to panel-only context.
- Recursive `fusion/*` member refs are rejected by recipe validation.
- Full run traces are written to `.pi/fusion/runs/*.json` by default.
- If the context broker is enabled, only a compact `fusion_result` artifact is published; raw panel outputs stay in the trace file.
- Streaming is completion-first for now: the provider emits once Fusion completes rather than interleaving panel/judge streams.

Cost/latency scales with panel size: `N` panel calls + judge call + synthesis call.

## Local benchmark preset

Before adding agentic/subagent orchestration, compare model-only Fusion against a single strong model:

```bash
npm run fusion:bench -- --init
npm run fusion:bench -- --print-cases
```

This writes a local-only preset under `.pi/fusion/benchmarks/hard-tasks/` with:

- baseline to run manually: `openai-codex/gpt-5.5`
- `fusion/hard-55-spark`: `gpt-5.5 + gpt-5.3-codex-spark -> gpt-5.5`
- `fusion/hard-55x2-spark`: `gpt-5.5 x2 + gpt-5.3-codex-spark -> gpt-5.5`

Run Pi locally with the generated recipes:

```bash
PI_ROGUE_FUSION_ENABLED=1 \
PI_ROGUE_FUSION_RECIPES=.pi/fusion/benchmarks/hard-tasks/recipes.json \
pi
```

Or run the independent case × variant matrix non-interactively with bounded parallelism, which avoids waiting on unrelated benchmark arms:

```bash
npm run fusion:bench -- --run --concurrency 2
npm run fusion:bench -- --run --dry-run --case architecture-tradeoff --variant baseline-55
```

The parallel runner writes raw answers and run metadata under `.pi/fusion/benchmarks/hard-tasks/outputs/` only. Record manual score rows in `.pi/fusion/benchmarks/hard-tasks/runs.jsonl`, then summarize:

```bash
npm run fusion:bench -- --report
```

Do not infer Fusion quality from one cherry-picked prompt. Look for repeated wins on hard prompts, acceptable latency, and fewer missed risks/unsupported claims than the baseline.

## Future: agentic panels with pi-agents + pi-intercom

A natural next layer is an agent-backed council that uses Pi subagents for panel attempts and pi-intercom for coordination/progress. Keep the language parallel to OpenRouter while naming the substrate honestly:

```json
{
  "schema": "pi-rogue.fusion.recipe.v1",
  "kind": "agent_fusion",
  "id": "council/subagents3",
  "model": "openai-codex/gpt-5.5",
  "analysis_agents": [
    { "agent": "reviewer", "model": "openai-codex/gpt-5.5" },
    { "agent": "delegate", "model": "openai-codex/gpt-5.3-codex-spark" },
    { "agent": "delegate", "model": "local/qwen3.6-35b-a3b-128k" }
  ],
  "coordination": "pi-intercom",
  "max_parallel": 3
}
```

Rules for that future family:

- `analysis_agents` means comparable independent agent attempts on the same task.
- It can use pi-subagents parallel execution and pi-intercom progress/status channels.
- The judge schema can stay OpenRouter-like if the agents are roleless comparable attempts.
- Role prompts (`critic`, `researcher`, `verifier`) still belong to a separate `deliberation`/role-pass recipe with a different judge schema.
- Agentic Fusion should run from an orchestration command or workflow, not invisibly inside the model-provider stream, because agents can use tools, worktrees, and long-running coordination.
