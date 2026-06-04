# Binary gate training runbook

The advisor binary gate is a tiny local classifier that decides whether a user turn should `continue` locally or `escalate` to advisor review.

## Runtime asset

- Shipped model: `packages/advisor/assets/binary-gate-model.json`
- Runtime/training feature extractor: `packages/advisor/src/binary-gate-features.ts`
- Labels: `continue`, `escalate`

Keep runtime and training feature extraction shared. Do not add training-only cues that runtime cannot compute.

## Training data

Rows are JSONL objects with at least:

```json
{ "id": "row-id", "text": "user turn", "label": "escalate", "source": "manual" }
```

Optional `weight` can upweight a row without duplicating it:

```json
{ "id": "row-id", "text": "review this before release", "label": "escalate", "source": "manual", "weight": 2 }
```

Use `/tmp` for generated combined datasets and reports unless the user explicitly approves committing durable artifacts.

## Train a candidate

```bash
npx tsx scripts/train-binary-gate.ts \
  --input /tmp/binary-gate-train.jsonl \
  --model /tmp/binary-gate-model.json \
  --report /tmp/binary-gate-train-report.json
```

Determinism check before promotion:

```bash
npx tsx scripts/train-binary-gate.ts --input /tmp/binary-gate-train.jsonl --model /tmp/model-a.json --report /tmp/report-a.json
npx tsx scripts/train-binary-gate.ts --input /tmp/binary-gate-train.jsonl --model /tmp/model-b.json --report /tmp/report-b.json
shasum -a 256 /tmp/model-a.json /tmp/model-b.json
cmp /tmp/model-a.json /tmp/model-b.json
```

## Evaluate a candidate

Evaluate the candidate and the currently shipped/PR model on the same slices.

```bash
npx tsx scripts/eval-binary-gate-file.ts \
  --input data/routing/binary-gate.jsonl \
  --model /tmp/binary-gate-model.json \
  --report /tmp/eval-canonical.json \
  --top-misses 100
```

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

Promote only after explicit approval and only if the candidate is promotion-safe on evaluated slices:

- No runtime/training feature mismatch.
- No exact train/holdout leakage for PR-specific holdouts.
- Overall accuracy is maintained or improved on canonical, hard, conflict, and terminal slices.
- `escalate` recall is preserved on safety-sensitive slices, especially terminal-small.
- Hard/conflict accuracy does not regress materially.
- Any residual recall tradeoff vs the old shipped model is explicitly documented.
- Same-input retraining is deterministic or the difference is explained.

## Evidence policy

Default evidence location is `/tmp`, not the repository.

Do not commit raw generated eval JSON, benchmark text, model candidates, or bulky evidence folders unless explicitly requested. Prefer a concise PR summary or an external note with:

- training composition
- data hygiene checks
- metric table vs current shipped/PR model
- residual tradeoffs
- model SHA256
- validation commands
