# Fusion budget policy

Fusion is a self-contained Pi-Rogue feature. Its recipes, runtime behavior, policy, and maintainer checklists must live in this repository unless a maintainer explicitly approves an external dependency.

Fusion is also expensive by design: one request can run panel models, a judge, and a synthesizer. Treat it as a bounded, opt-in decision aid, not a retry engine.

## Policy

1. **Opt in deliberately**
   - Do not add hidden or automatic Fusion paths.
   - New Fusion entry points must be explicit command/model paths or clearly documented orchestration choices.

2. **Preflight before spending**
   - Validate required inputs exist before invoking Fusion.
   - Validate model/agent references before invoking Fusion.
   - Skip instead of retrying when quota or auth is known unavailable.

3. **Cap every Fusion path**
   - Name the maximum panel size.
   - Name the maximum judge/synthesis attempts.
   - Name the fallback behavior.
   - Fusion must not run inside unbounded retry, review, check-in, or fallback loops.

4. **Short-circuit low-value output**
   - Stop on empty, intent-only, or non-evidence panel responses.
   - Stop on `usage_limit_reached` or equivalent provider quota failures.
   - Prefer returning a clear degraded result over launching another expensive call.

5. **Fallback cheaply**
   - Use panel-only output, a single-model summary, or a user-facing warning.
   - Do not recursively invoke Fusion as a fallback for Fusion.

## PR checklist for Fusion changes

For any PR that adds or changes a Fusion path, confirm:

- [ ] The change is self-contained in this repo.
- [ ] Fusion remains explicit/opt-in.
- [ ] Required inputs are preflighted before model calls.
- [ ] Model/agent references are validated before model calls.
- [ ] Panel, judge, synthesis, and fallback attempts are capped.
- [ ] Fusion is not invoked from an unbounded retry/fallback loop.
- [ ] Quota/provider failures short-circuit without extra expensive calls.
- [ ] Degraded/fallback behavior is clear to the user.
- [ ] Tests or documented validation cover the budget behavior, or N/A is explained.

## Default stance

If a Fusion change cannot answer “what is the maximum number of expensive calls this top-level operation can make?”, do not merge it.
