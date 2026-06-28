# Advisor Board specialist taxonomy spike

## Recommendation

Use a **small set of broad, capability-based read-only specialists** rather than issue-specific personas.

Suggested baseline roles:

- **reviewer** — general code review, regressions, test gaps
- **security** — secrets, auth, permissions, data-loss risk
- **debugger** / **stack-ace** — failures, stack traces, runtime issues, tool loops
- **architecture** — design, decomposition, API shape, refactor guidance
- **reliability/perf** — loops, timeouts, cost drift, repeated failure, throughput
- **research** (optional) — repository/docs lookup and cross-checking

## Why this shape works

Common multi-agent guidance in the wild converges on:

- planner/orchestrator + specialists
- critic/reviewer as a separate role
- read-only, least-privilege specialists
- human approval for high-impact actions
- separate guardrails/policy for escalation, cost, and autonomy

That pattern is a better fit than a large set of niche, issue-specific specialists.

## What should *not* be a specialist role

Keep these in policy/ledger logic instead of creating separate specialist personas:

- loop prevention
- stale evidence detection
- cost control / call budgets
- escalation thresholds
- approval gates

Those belong in the board policy layer because they are cross-cutting rules, not subject-matter expertise.

## Effect on Head-of-Board

This taxonomy change should **not** change Head-of-Board into a broader role.

Head-of-Board should remain:

- separate from specialists
- expensive and gated
- consuming compact board ledger + specialist summaries only
- invoked on material or user-requested escalation

The taxonomy affects the **inputs** Head-of-Board sees, not the head role’s core behavior.

## Pi-Rogue-specific mapping

Current issue-specific concepts map cleanly to broader roles:

- `test-reviewer` -> `reviewer`
- `stale-evidence-auditor` -> policy trigger, not a specialist
- future loop/risk watchers -> policy/ledger, not specialist
- architecture/design concerns -> `architecture`
- runtime/test stack issues -> `debugger`
- security concerns -> `security`

## Implementation direction

The follow-up ticket should:

1. update the role catalog to the broad taxonomy
2. alias or retire niche specialist concepts cleanly
3. keep specialists read-only and explicit-call/suggest-gated
4. keep Head-of-Board unchanged except for consuming the new summaries
5. add tests for taxonomy normalization and no role explosion

## Bottom line

Yes, this taxonomy makes sense here.
It is simpler, more durable, and easier to gate than a proliferation of narrow specialists.
