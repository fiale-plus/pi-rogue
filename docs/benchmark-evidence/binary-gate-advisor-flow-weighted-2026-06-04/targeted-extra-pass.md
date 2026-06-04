# Binary gate weighted advisor-flow retrain (2026-06-04)

## Final status

Promoted the extra targeted recall-recovery candidate to `packages/advisor/assets/binary-gate-model.json`.

Training composition:

- Base: `data/routing/binary-gate-augmented-terminal-core-full-dup-escalate.jsonl`
- Advisor-flow pass: 85 non-overlapping rows with `weight: 2` in `train-weighted.jsonl`
- Extra targeted recall pass: 6 escalate rows with `weight: 4` in `targeted-recall-addendum.jsonl`
  - 5 rows are duplicate/upweighted examples already present in the base corpus.
  - 1 row is a synthetic post-turn-review variant.
  - Exact overlap with advisor-flow holdout: 0

Residual tradeoff: compared with the old shipped model, canonical and terminal-merged escalate recall remain about 1.2pp lower, but the targeted model improves the recall-recovery slices vs the first promoted candidate with no material guard-slice regressions.

## Data checks

Initial advisor-flow split:

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

Targeted addendum:

```json
{
  "targetedAddendumRows": 6,
  "targetedAddendumLabelCounts": {
    "escalate": 6
  },
  "targetedAddendumWeightCounts": {
    "4": 6
  },
  "addendumHoldoutExactOverlap": 0,
  "addendumExistingAdvisorTrainExactOverlap": 0,
  "addendumBaseExactOverlap": 5,
  "finalAdvisorTrainRows": 85,
  "holdoutRows": 21
}
```

## Metrics

| Slice | Old acc | First-pass acc | Final acc | Δ final vs first | Old esc recall | First-pass esc recall | Final esc recall | Δ final vs first |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Advisor-flow holdout | 66.7% | 90.5% | 90.5% | +0.000 | 70.0% | 80.0% | 90.0% | +0.100 |
| Canonical binary-gate | 97.2% | 97.5% | 97.5% | -0.000 | 98.6% | 97.3% | 97.4% | +0.002 |
| Hard holdout | 88.9% | 93.3% | 93.3% | +0.000 | 90.7% | 93.0% | 93.0% | +0.000 |
| Conflict holdout | 86.7% | 91.7% | 93.3% | +0.017 | 88.9% | 92.6% | 96.3% | +0.037 |
| Terminal small | 84.4% | 87.5% | 87.5% | +0.000 | 95.0% | 95.0% | 95.0% | +0.000 |
| Terminal merged | 96.3% | 96.5% | 96.5% | +0.001 | 97.4% | 95.8% | 96.2% | +0.004 |
| Terminal heldout split | 100.0% | 96.9% | 100.0% | +0.031 | 100.0% | 96.6% | 100.0% | +0.034 |

## Training report excerpt

- Rows: 2752 (weighted rows: 2855, train 2202, test 550)
- Accuracy: 88.5%
- Escalate F1: 0.888
- Continue F1: 0.883
- Best epoch: 39

## Advisor-flow holdout misses (final)

- `continue` → `escalate` (0.603): don't leak raw clipboard paths in advisor review output
- `escalate` → `continue` (0.714): Check whether this candidate is safe to promote to runtime default or hold back for more rows.

## Determinism SHA256

```text
165e5e0692dd929306a743087614da6fe5439ff04d725506bf7cd02a38e92a9b  /tmp/pi-rogue-binary-extra-final/targeted-model-a.json
165e5e0692dd929306a743087614da6fe5439ff04d725506bf7cd02a38e92a9b  /tmp/pi-rogue-binary-extra-final/targeted-model-b.json
```

## Model SHA256

```text
1e5491eb4b571521d8fce3ca96384fd284a5f291ce0f62d4bc02dfd8b93a729d  data/routing/binary-gate-model-terminal-core-full.json
d5336ca3cc5b5bc733c22b38a5fe8f3dac8f2232c897267644bf7220fdf6b456  /tmp/pi-rogue-binary-extra-final/current-promoted-before-extra.json
165e5e0692dd929306a743087614da6fe5439ff04d725506bf7cd02a38e92a9b  packages/advisor/assets/binary-gate-model.json
```

## Benchmark

```text
> pi-rogue@0.1.0 binary:benchmark
> npx tsx scripts/benchmark-binary-gate.ts

Model file: 538KB, features: 6000, labels: continue, escalate

--- Performance ---
Cold load: 1.5ms
Single prediction (TTFS): 0.031ms
Average per prediction: 0.025ms
Throughput: 40783 predictions/sec
Batch: 2000 predictions in 49ms
Sample: continue (95.3%)
```

## Validation

- `npm run test --workspace packages/advisor` ✅
- `npm run check` ✅
