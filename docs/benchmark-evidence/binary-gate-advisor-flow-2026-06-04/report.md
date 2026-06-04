# Binary gate retrain candidate: advisor-flow handoff slice (2026-06-04)

## Summary

- Built a curated advisor-flow training augmentation (`train-augment.jsonl`, 46 rows) plus separate holdout (`holdout.jsonl`, 14 rows).
- Trained candidate models from the current terminal-core-full binary-gate base plus advisor-flow augmentation.
- Best targeted candidate used augmentation repeated 3x (`k=3`) and improved the advisor-flow holdout from 71.4% to 92.9%.
- **Promotion decision: candidate only, not shipped.** Advisor review flagged the repeated 3x augmentation and terminal-small escalate-recall drop as enough uncertainty to avoid replacing the shipped asset in this PR pass.
- The committed runtime asset `packages/advisor/assets/binary-gate-model.json` is unchanged; this PR only publishes the retrain/eval evidence.

## Commands

```bash
cat data/routing/binary-gate-augmented-terminal-core-full.jsonl train-augment.jsonl train-augment.jsonl train-augment.jsonl > /tmp/.../combined-final-k3.jsonl
npx tsx scripts/train-binary-gate.ts --input /tmp/.../combined-final-k3.jsonl --model /tmp/.../model-final-k3.json --report candidate-k3-training-report.json
npx tsx scripts/eval-binary-gate-file.ts --input <slice> --model /tmp/.../model-final-k3.json --report candidate-k3-<slice>-report.json
BINARY_GATE_MODEL_PATH=/tmp/.../model-final-k3.json npm run binary:benchmark
npm run test --workspace packages/advisor
npm run check
```

## Metrics

| Slice | Baseline acc | Candidate acc | Δ acc | Baseline esc recall | Candidate esc recall | Δ esc recall |
|---|---:|---:|---:|---:|---:|---:|
| Advisor-flow holdout | 71.4% | 92.9% | +0.214 | 60.0% | 100.0% | +0.400 |
| Canonical binary-gate | 97.2% | 97.1% | -0.001 | 98.6% | 97.4% | -0.012 |
| Hard holdout | 88.9% | 90.0% | +0.011 | 90.7% | 95.3% | +0.047 |
| Conflict holdout | 86.7% | 88.3% | +0.017 | 88.9% | 96.3% | +0.074 |
| Terminal small | 84.4% | 84.4% | +0.000 | 95.0% | 90.0% | -0.050 |
| Terminal merged | 96.3% | 96.1% | -0.002 | 97.4% | 96.0% | -0.014 |

## K sweep on terminal-core-full base

```csv
k,holdout_acc,holdout_esc_recall,hard_acc,conflict_acc,terminal_small_acc,terminal_merged_acc,canonical_acc
1,0.8571,0.8,0.9222,0.9167,0.8125,0.965,0.9759
2,0.7857,0.8,0.9556,0.9333,0.75,0.9617,0.9718
3,0.9286,1,0.9,0.8833,0.8438,0.9605,0.9714
4,0.7857,0.8,0.9556,0.95,0.8438,0.9642,0.9734
5,0.8571,1,0.8778,0.85,0.8125,0.9515,0.9607
6,0.7857,0.8,0.9,0.8667,0.875,0.9601,0.9701
```

## Base comparison sweep

```csv
base,k,holdout_acc,holdout_esc_recall,hard_acc,conflict_acc,terminal_small_acc,terminal_small_esc_recall,terminal_merged_acc,canonical_acc
full,1,0.8571,0.8,0.9222,0.9167,0.8125,0.9,0.965,0.9759
full,2,0.7857,0.8,0.9556,0.9333,0.75,1,0.9617,0.9718
full,3,0.9286,1,0.9,0.8833,0.8438,0.9,0.9605,0.9714
dup,1,0.7857,0.8,0.9,0.8667,0.8125,1,0.9622,0.9722
dup,2,0.7857,0.8,0.8333,0.7833,0.7188,1,0.9375,0.9464
dup,3,0.8571,0.8,0.8111,0.75,0.8125,1,0.9515,0.9599
```

## Candidate training report excerpt

- Rows: 2663 (train 2131, test 532)
- Accuracy: 87.4%
- Escalate F1: 0.870
- Continue F1: 0.878
- Best epoch: 24

## Advisor-flow holdout misses

- `continue` → `escalate` (0.987): merge the UX PR, release the bundle, reinstall it, and report

## Benchmark

```text
> pi-rogue@0.1.0 binary:benchmark
> npx tsx scripts/benchmark-binary-gate.ts

Model file: 538KB, features: 6000, labels: continue, escalate

--- Performance ---
Cold load: 1.4ms
Single prediction (TTFS): 0.032ms
Average per prediction: 0.020ms
Throughput: 49967 predictions/sec
Batch: 2000 predictions in 40ms
Sample: continue (92.6%)
```

## Model SHA256

```text
1e5491eb4b571521d8fce3ca96384fd284a5f291ce0f62d4bc02dfd8b93a729d  packages/advisor/assets/binary-gate-model.json
d0be5a983659c7fea3a2625df8e7b8f2359c07397d03bced2db0098cf39cd716  /tmp/pi-rogue-binary-flow-2026-06-04/model-final-k3.json
```

## Follow-up recommendation

Do another data pass before promotion: add more non-duplicated advisor-flow rows, especially merge/release/install negatives and advisor-promotion positives, then require advisor-flow improvement while preserving terminal-small escalate recall.
