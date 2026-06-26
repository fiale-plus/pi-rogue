# Advisor Board replay PoC

**Status:** PoC design for [#220](https://github.com/fiale-plus/pi-rogue/issues/220)  
**Parent:** [#218](https://github.com/fiale-plus/pi-rogue/issues/218)  
**Depends on:** [#219](https://github.com/fiale-plus/pi-rogue/issues/219)

## Scope

This PoC is intentionally cold and boring. It does not implement a live Advisor Board product.

It proves whether saved/local session evidence can be reduced into a compact board ledger and deterministic edge-moment decisions.

## Hard constraints

- no live session integration
- no model calls
- no specialist dispatch
- no head-of-board calls
- no live whispers or steering
- no mutating tools
- no role catalog loading
- no personal specialist discovery

The output is structured data only.

## Router/checkpoint boundary

`packages/router` already owns raw Pi session reading and trajectory-oriented signals. In particular, router code already contains:

- session JSONL reading helpers
- checkpoint iteration
- progress/loop signals such as repeated command/error pressure and verifier usage
- outcome mining scripts used for routing datasets

The board PoC should not replace those primitives.

Recommended boundary:

```text
packages/router:
  raw session -> compact checkpoint/event extraction where possible

packages/advisor/src/board.ts:
  board ledger, board risk semantics, board decisions, eval report rows
```

In this first PoC, `BoardEvent` is deliberately small and fixture-oriented. It is a board-facing event shape, not a new full session parser. Future live or bulk-mining work should reuse router checkpoint/session primitives when converting raw sessions into `BoardEvent` slices.

## Core types

The PoC defines:

- `BoardEvent`: compact event input for fixtures/replay
- `BoardLedger`: compact state derived from events
- `BoardRisk`: deterministic risk emitted from the ledger
- `BoardDecision`: what the board would do, without live action
- `BoardEvalReportRow`: fixture-level eval output with false-positive/false-negative notes

## Deterministic triggers

Implemented trigger families:

1. **stale evidence** — older red evidence exists before newer terminal green evidence
2. **repeated failure** — same tool/failure key repeats at least three times
3. **missing validation** — files changed after the latest validation evidence
4. **no progress** — many turns since last progress signal
5. **subagent contradiction** — read-only summaries disagree on the same topic

These are intentionally simple. The goal is to create a deterministic baseline before adding model gates, role catalogs, specialists, or head-of-board escalation.

## Fixture strategy

Use both real-session mining and synthetic fixtures, but in this order:

1. Mine local sessions / processed outcomes to find candidate edge-moment slices.
2. Redact and hand-curate compact `BoardEvent` fixtures.
3. Use synthetic fixtures only for missing cases or exact semantic tests.

`./scripts/select-board-fixtures.ts` is a non-production helper for candidate selection. By default it writes to the OS temp directory, not the repository, so local-session-derived data is not accidentally left as an untracked worktree file. Its output should be reviewed before anything is committed as a stable fixture.

Tests must not depend on local `~/.pi/agent/sessions`; checked-in tests use deterministic in-code fixtures.

## Eval report shape

Every curated fixture can produce:

```yaml
fixtureId: string
expectedEdgeMoment: string
detectedRisk: string | null
decision: silent | ledger_update | would_whisper
evidencePointer: string
falsePositiveNotes: string
falseNegativeNotes: string
```

False positives and false negatives should remain visible. The PoC must not hide uncertainty.

## Why #221-#225 wait

Do not start role catalog, specialist dispatch, head-of-board isolation, live shadow mode, or personal specialist discovery until this PoC shows useful low-noise signal.

If deterministic replay cannot detect stale evidence, repeated failure, and missing validation on compact fixtures, the larger Advisor Board architecture should pause.
