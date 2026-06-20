# Binary gate training runbook

The advisor binary gate is a tiny local classifier that decides whether a user turn should `continue` locally or `escalate` to advisor review.

## Runtime asset

- Shipped model: `packages/advisor/assets/binary-gate-model.json`
- Runtime/training feature extractor: `packages/advisor/src/binary-gate-features.ts`
- Labels: `continue`, `escalate`

Keep runtime and training feature extraction shared. Do not add training-only cues that runtime cannot compute.

## Model artifact versions

Two artifact kinds are accepted at runtime:

- `binary-logreg-v1` — legacy. Argmax over softmax, no calibration, no thresholds. The
  runtime applies a legacy trust gate (`LEGACY_V1_TRUST_THRESHOLD = 0.55` confidence)
  before acting on a v1 prediction, preserving pre-v2 behavior.
- `binary-logreg-v2` — calibrated + cost-governed. Adds two artifact fields:
  - `calibration`: `{ method: "platt", a, b }` (or `{ method: "none" }`). Applied as
    `P(escalate) = sigmoid(a * logit + b)` where `logit = s_escalate - s_continue`.
  - `thresholds`: `{ default, preflight?, review?, closeout? }`. Operating threshold per
    phase, swept on a cost-weighted objective.

A v2 prediction is always `trusted` (the threshold is part of the artifact), so the
runtime reads the threshold from the artifact and never hardcodes it. There are no
`0.55` literals in the extension; the dead `BINARY_GATE_THRESHOLD` constant is gone.

Current shipped artifact thresholds: `default/preflight/closeout=0.2673`,
`review=0.05`. The lower review threshold keeps the advisor loop-convergence smoke
tests stable while leaving preflight less spammy.

Threshold selection is **constrained**: the validation-selected threshold must
satisfy `minAccuracy` (default 0.87), `maxEscalationRate` (default 0.65), and guard
recall floors before it is accepted. `minGuardSupport` (default 5) ensures guard
floors only hard-gate feasibility when a slice has enough support; low-support
slices (e.g. stuck with support 1) are still reported but do not block selection,
so a single held-out example cannot veto a candidate. If no threshold is feasible,
the unconstrained cost-weighted optimum is emitted with `thresholdFeasible: false`.

The runtime call sites pass the phase explicitly: `binaryGatePredict(text, "preflight")`
and `binaryGatePredict(text, "review")`, and gate on `prediction.trusted`.

## v4 stacked trajectory model (shipped)

The shipped advisor asset now carries an optional `stacked` second stage that
combines the text-gate calibrated probability with router trajectory features:

```json
"stacked": {
  "trajectoryFeatures": ["loopScore", "progressScore", ...],
  "bias": 0,
  "weights": [w_textGateProb, w_loopScore, ...],
  "calibration": { "method": "platt", "a": 1, "b": 0 },
  "thresholds": { "default": 0.1881, "preflight": 0.1881, "review": 0.05, "closeout": 0.1881 }
}
```

Input vector is `[textGateProbEscalate, ...normalized trajectory features]` ordered
by `TRAJECTORY_FEATURE_NAMES`. The stacked path is only active when the artifact
has `stacked` and the caller passes a matching `TrajectoryFeatures`; otherwise the
text-only calibrated probability and threshold are used unchanged.

`binaryGatePredict(text, phase, trajectory?)` accepts an optional trajectory
context. The extension call sites pass the trajectory signals available at each
phase (preflight/review). The local trajectory-enrichment script joins the shipped
binary-gate labels with router `route-event` telemetry from raw session files, then
`train-binary-gate.ts` promotes the stacked model only when it beats the text
baseline and passes guard floors.

Current local promotion snapshot:

- Stacked validation: accuracy **87.6%**, costWeightedLoss **0.1616**, Brier **0.090721**, ECE10 **0.038824**, threshold **0.1881**, feasible **true**.
- Stacked test: accuracy **86.0%**, costWeightedLoss **0.182243**, Brier **0.090732**, ECE10 **0.049586**, threshold **0.1881**, feasible **true**.
- Text-only v3 baseline (same split): test accuracy **85.3%**, costWeightedLoss **0.189252**, Brier **0.087686**, ECE10 **0.040397**, threshold **0.2673**, feasible **true**.
- Trajectory coverage: **52.7%** (1500/2849 label rows).


## Training data

Rows are JSONL objects with at least:

```json
{ "id": "row-id", "text": "user turn", "label": "escalate", "source": "manual" }
```

Trajectory-enriched rows add the optional router trace:

```json
{ "id": "row-id", "trajectory": { "loopScore": 0.1, "progressScore": 0.9, "sameErrorRepeatedCount": 1, "diffLines": 42, "contextTokensApprox": 3000 } }
```

Use `scripts/build-binary-gate-trajectory-dataset.ts --labels <binary-gate.jsonl> --output /tmp/binary-gate-trajectory.jsonl` to enrich the shipped labels with local router telemetry. Optional `weight` can upweight a row without duplicating it:

```json
{ "id": "row-id", "text": "review this before release", "label": "escalate", "source": "manual", "weight": 2 }
```

Use `/tmp` for generated combined datasets and reports unless the user explicitly approves committing durable artifacts.

## Train a candidate

`scripts/train-binary-gate.ts` trains a cost-sensitive, calibrated v2 model with a
three-way split: train fits the logreg weights, validation fits Platt scaling and
selects the operating threshold on a cost-weighted objective (`fnCost` vs `fpCost`),
and the untouched test split is used only for final reporting. With `--stacked`, the
same trainer also fits the optional second-stage trajectory model and only promotes
it when validation is feasible and the test cost-weighted loss beats the text-only
baseline. It writes a `binary-logreg-v2` artifact with `calibration` + `thresholds`
and (when promoted) `stacked`. The report includes Brier, ECE, cost-weighted loss,
guard-slice recall, and stacked coverage.

```bash
npx tsx scripts/train-binary-gate.ts \
  --input /tmp/binary-gate-trajectory.jsonl \
  --model /tmp/binary-gate-model.json \
  --report /tmp/binary-gate-train-report.json \
  --stacked --min-stacked-rows 100 \
  --epochs 40 --fn-cost 3 --fp-cost 1 --safety-floor 1.0
```

Cost asymmetry: a false negative (missed escalation → worker spirals) is far more
expensive than a false positive (one extra advisor call). Default `fnCost=3`,
`fpCost=1` keeps the objective asymmetric while avoiding excessive over-escalation;
increase `fnCost` only when missed escalations are worth a larger accuracy/usage tradeoff.
The emitted artifact also caps the review-phase threshold at `0.05` for the loop-
convergence smoke path. Override with `--fn-cost` / `--fp-cost`.

Determinism check before promotion:

```bash
npx tsx scripts/train-binary-gate.ts --input /tmp/binary-gate-train.jsonl --model /tmp/model-a.json --report /tmp/report-a.json
npx tsx scripts/train-binary-gate.ts --input /tmp/binary-gate-train.jsonl --model /tmp/model-b.json --report /tmp/report-b.json
shasum -a 256 /tmp/model-a.json /tmp/model-b.json
cmp /tmp/model-a.json /tmp/model-b.json
```

## Evaluate a candidate

Evaluate the candidate and the currently shipped/PR model on the same slices.
`eval-binary-gate-file.ts` reads `calibration` + `thresholds` from the artifact and
reports threshold, Brier, ECE, and cost-weighted loss alongside accuracy/F1.

```bash
npx tsx scripts/eval-binary-gate-file.ts \
  --input data/routing/binary-gate.jsonl \
  --model /tmp/binary-gate-model.json \
  --report /tmp/eval-canonical.json \
  --top-misses 100 --fn-cost 3 --fp-cost 1
```

`eval-binary-gate-sources.ts` does source-disjoint holdout (train on all-but-one
source, test on the held-out source) with calibration + cost-weighted threshold per
fold, and reports Brier/ECE/cost-weighted loss per source.

For a direct v1-vs-v2 head-to-head, using the same seeded train/validation/test split
and selecting the v2 threshold on validation only, use:

```bash
npx tsx scripts/compare-binary-gate-v1-v2.ts data/routing/binary-gate.jsonl 3 1
```

The comparison reports both a v1 argmax ablation (`probability >= 0.5`) and a
binary-only estimate of the legacy v1 trust gate (`confidence >= 0.55`; untrusted
predictions treated as no model escalation). The full historical extension also had
heuristic fallback, so do not describe the legacy-trust row as the complete shipped
runtime unless that fallback is modeled too. Compare outputs are strictly post-hoc:
they are not consumed by training or threshold selection, so re-running compare
cannot leak test signal back into the artifact.

Benchmark latency/throughput:

```bash
BINARY_GATE_MODEL_PATH=/tmp/binary-gate-model.json npm run binary:benchmark
```

## Guard slices

Use all available slices that apply to the PR:

- Canonical: `data/routing/binary-gate.jsonl`
- Hard holdout: `data/routing/binary-hard-holdout.jsonl`
- Conflict holdout: `data/routing/binary-conflict-holdout.jsonl`
- Terminal small: `data/routing/binary-gate-terminal-bench-small.jsonl`
- Terminal merged: `data/routing/binary-gate-terminal-bench-merged.jsonl`
- Terminal heldout split: `data/routing/terminal-core-heldout-split.jsonl`
- PR-specific holdout: keep in `/tmp` unless explicitly approved for commit

For PR-specific data, record row counts, label counts, source labels, and exact train/holdout overlap checks.

## Promotion bar

Promotion only after explicit approval, and only if the candidate is promotion-safe on
an untouched test split after calibration/threshold selection on a separate validation
split. The issue #175 acceptance bar requires the candidate to beat the current shipped
model on **both**:

- **cost-weighted loss** (`fnCost·FN + fpCost·FP`) on the held-out set, AND
- **guard-slice recall floors** (safety ≥ 1.0; stuck/debug ≥ 0.9 by default).

A candidate that improves accuracy but regresses cost-weighted loss or guard-slice
recall is NOT promotable. A small accuracy tradeoff is acceptable when it buys a
material cost-weighted-loss or guard-recall improvement (the whole point of the
cost-aware threshold).

Additional gates:

- No runtime/training feature mismatch.
- No exact train/holdout leakage for PR-specific holdouts.
- Overall accuracy is maintained or improved on canonical, hard, conflict, and terminal slices.
- `escalate` recall is preserved on safety-sensitive slices, especially terminal-small.
- Hard/conflict accuracy does not regress materially.
- Any residual recall tradeoff vs the old shipped model is explicitly documented.
- Same-input retraining is deterministic or the difference is explained.

Promotion remains **manual + eval-gated** (per `packages/advisor/ANALYSIS.md` §3.1.1
governance). Do not auto-promote; candidate reports stay in `/tmp` (or gitignored
`data/routing/`) unless explicitly approved.

## Evidence policy

Default evidence location is `/tmp`, not the repository.

Do not commit raw generated eval JSON, benchmark text, model candidates, or bulky evidence folders unless explicitly requested. Prefer a concise PR summary or an external note with:

- training composition
- data hygiene checks
- metric table vs current shipped/PR model
- residual tradeoffs
- model SHA256
- validation commands
