# Binary gate weighted advisor-flow retrain (2026-06-04)

## Summary

- Promotes a weighted binary-gate candidate into `packages/advisor/assets/binary-gate-model.json`.
- Training input: `data/routing/binary-gate-augmented-terminal-core-full-dup-escalate.jsonl` plus 85 non-overlapping advisor-flow rows with `weight: 2`.
- The train script now honors optional JSONL `weight` so future experiments do not need duplicated rows.
- Data checks show no train↔holdout overlap and no holdout overlap with the existing binary-gate corpora.

## Data checks

```json
{
  "trainRows": 85,
  "holdoutRows": 21,
  "trainLabelCounts": {
    "continue": 61,
    "escalate": 24
  },
  "holdoutLabelCounts": {
    "continue": 11,
    "escalate": 10
  },
  "trainHoldoutOverlap": 0,
  "trainBaseOverlap": 0,
  "holdoutBaseOverlap": 0
}
```

## Metrics vs prior shipped model

| Slice | Base acc | Candidate acc | Δ acc | Base esc recall | Candidate esc recall | Δ esc recall |
|---|---:|---:|---:|---:|---:|---:|
| Advisor-flow holdout | 66.7% | 90.5% | +0.238 | 70.0% | 80.0% | +0.100 |
| Canonical binary-gate | 97.2% | 97.5% | +0.003 | 98.6% | 97.3% | -0.014 |
| Hard holdout | 88.9% | 93.3% | +0.044 | 90.7% | 93.0% | +0.023 |
| Conflict holdout | 86.7% | 91.7% | +0.050 | 88.9% | 92.6% | +0.037 |
| Terminal small | 84.4% | 87.5% | +0.031 | 95.0% | 95.0% | +0.000 |
| Terminal merged | 96.3% | 96.5% | +0.002 | 97.4% | 95.8% | -0.016 |
| Terminal heldout split | 100.0% | 96.9% | -0.031 | 100.0% | 96.6% | -0.034 |

## Training report excerpt

- Rows: 2746 (weighted rows: 2831, train 2197, test 549)
- Accuracy: 87.6%
- Escalate F1: 0.877
- Continue F1: 0.875
- Best epoch: 39

## Advisor-flow holdout misses

- `escalate` → `continue` (0.580): Can you force a post-turn review on the last handoff before we finish this task?
- `escalate` → `continue` (0.780): Check whether this candidate is safe to promote to runtime default or hold back for more rows.

## Determinism SHA256

```text
d5336ca3cc5b5bc733c22b38a5fe8f3dac8f2232c897267644bf7220fdf6b456  /tmp/pi-rogue-binary-weighted-final/model-a.json
d5336ca3cc5b5bc733c22b38a5fe8f3dac8f2232c897267644bf7220fdf6b456  /tmp/pi-rogue-binary-weighted-final/model-b.json
```

## Model SHA256

```text
1e5491eb4b571521d8fce3ca96384fd284a5f291ce0f62d4bc02dfd8b93a729d  data/routing/binary-gate-model-terminal-core-full.json
d5336ca3cc5b5bc733c22b38a5fe8f3dac8f2232c897267644bf7220fdf6b456  packages/advisor/assets/binary-gate-model.json
```

## Benchmark

```text
> pi-rogue@0.1.0 binary:benchmark
> npx tsx scripts/benchmark-binary-gate.ts

Model file: 538KB, features: 6000, labels: continue, escalate

--- Performance ---
Cold load: 2.4ms
Single prediction (TTFS): 0.036ms
Average per prediction: 0.023ms
Throughput: 42562 predictions/sec
Batch: 2000 predictions in 47ms
Sample: continue (90.4%)
```

## Validation

- `npm run test --workspace packages/advisor` ✅
- `npm run check` ✅
