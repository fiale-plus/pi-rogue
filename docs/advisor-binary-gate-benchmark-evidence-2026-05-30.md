# Advisor binary-gate benchmark evidence (2026-05-30)

## What was run
- Terminal-Bench 2.1/2.0 core-slice generated from `/tmp/terminal-bench-core-0.1.1/task.yaml`:
  - `data/routing/binary-gate-terminal-bench-core-full.jsonl` (80 rows: 12 continue / 68 escalate)
  - `data/routing/binary-gate-terminal-bench-core-small.jsonl` (32-row sample: 12 continue / 20 escalate)
- Evaluated **old shipped model** (`docs/benchmark-evidence/binary-gate-model-baseline.json`) vs **updated candidate** (`docs/benchmark-evidence/binary-gate-model-updated.json`, same as `packages/advisor/assets/binary-gate-model.json`) using `scripts/eval-binary-gate-file.ts`.
- Ran performance benchmark with `npm run binary:benchmark` on both model files.

## CLI evidence

### Internal routing set (`data/routing/binary-gate.jsonl`)
- Old model report: `docs/benchmark-evidence/binary-gate-eval-internal-old.json`
- New model report: `docs/benchmark-evidence/binary-gate-eval-internal-new.json`

| metric | old | new |
|---|---:|---:|
| accuracy | 97.1370% | 97.2188% |
| escalate precision | 0.9758 | 0.9570 |
| escalate recall | 0.9642 | 0.9863 |
| continue precision | 0.9674 | 0.9871 |
| continue recall | 0.9780 | 0.9592 |

### Terminal-Bench core full (80 rows)
- Old model report: `docs/benchmark-evidence/binary-gate-eval-core-full-old.json`
- New model report: `docs/benchmark-evidence/binary-gate-eval-core-full-new.json`

| metric | old | new |
|---|---:|---:|
| accuracy | 32.500% | **95.000%** |
| escalate precision | 0.9375 | 0.9571 |
| escalate recall | 0.2206 | 0.9853 |
| continue precision | 0.1719 | 0.9000 |
| continue recall | 0.9167 | 0.7500 |

### Terminal-Bench core small (32 rows)
- Old model report: `docs/benchmark-evidence/binary-gate-eval-core-small-old.json`
- New model report: `docs/benchmark-evidence/binary-gate-eval-core-small-new.json`

| metric | old | new |
|---|---:|---:|
| accuracy | 43.750% | 90.625% |
| escalate precision | 0.7500 | 0.8696 |
| escalate recall | 0.1500 | 1.0000 |
| continue precision | 0.3929 | 1.0000 |
| continue recall | 0.9167 | 0.7500 |

### Terminal-Bench merged external set (2431 rows)
- Old model report: `docs/benchmark-evidence/binary-gate-eval-merged-old.json`
- New model report: `docs/benchmark-evidence/binary-gate-eval-merged-new.json`

| metric | old | new |
|---|---:|---:|
| accuracy | 95.31% | 96.30% |
| escalate precision | 0.9673 | 0.9501 |
| escalate recall | 0.9344 | 0.9744 |
| continue precision | 0.9407 | 0.9756 |
| continue recall | 0.9706 | 0.9523 |

### Runtime benchmark (`npm run binary:benchmark`)
- Old model evidence file: `docs/benchmark-evidence/binary-gate-benchmark-internal-old.txt`
- New model evidence file: `docs/benchmark-evidence/binary-gate-benchmark-new.txt`

### Reproduction commands used
```bash
npm run binary:eval-file -- --input data/routing/binary-gate.jsonl --model docs/benchmark-evidence/binary-gate-model-baseline.json --report docs/benchmark-evidence/binary-gate-eval-internal-old.json
npm run binary:eval-file -- --input data/routing/binary-gate.jsonl --model docs/benchmark-evidence/binary-gate-model-updated.json --report docs/benchmark-evidence/binary-gate-eval-internal-new.json

npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-core-full.jsonl --model docs/benchmark-evidence/binary-gate-model-baseline.json --report docs/benchmark-evidence/binary-gate-eval-core-full-old.json
npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-core-full.jsonl --model docs/benchmark-evidence/binary-gate-model-updated.json --report docs/benchmark-evidence/binary-gate-eval-core-full-new.json

npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-core-small.jsonl --model docs/benchmark-evidence/binary-gate-model-baseline.json --report docs/benchmark-evidence/binary-gate-eval-core-small-old.json
npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-core-small.jsonl --model docs/benchmark-evidence/binary-gate-model-updated.json --report docs/benchmark-evidence/binary-gate-eval-core-small-new.json

npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-merged.jsonl --model docs/benchmark-evidence/binary-gate-model-baseline.json --report docs/benchmark-evidence/binary-gate-eval-merged-old.json
npm run binary:eval-file -- --input data/routing/binary-gate-terminal-bench-merged.jsonl --model docs/benchmark-evidence/binary-gate-model-updated.json --report docs/benchmark-evidence/binary-gate-eval-merged-new.json

BINARY_GATE_MODEL_PATH=docs/benchmark-evidence/binary-gate-model-baseline.json npm run binary:benchmark > docs/benchmark-evidence/binary-gate-benchmark-internal-old.txt
BINARY_GATE_MODEL_PATH=docs/benchmark-evidence/binary-gate-model-updated.json npm run binary:benchmark > docs/benchmark-evidence/binary-gate-benchmark-new.txt
```

### Verification trail
- Commit history (latest-to-earliest):
  - `0034b67` — docs(advisor): correct merged-bench metric figures
  - `50599b0` — docs(advisor): include merged terminal-bench gate eval evidence
  - `69a9f6d` — docs(advisor): persist binary-gate benchmark artifacts for verifier
  - `2655a97` — chore(advisor): update binary gate model from terminal-bench sweep
- Reproducibility is fully in-repo:
  - `docs/advisor-binary-gate-benchmark-evidence-2026-05-30.md`
  - `docs/benchmark-evidence/binary-gate-eval-internal-old.json`
  - `docs/benchmark-evidence/binary-gate-eval-internal-new.json`
  - `docs/benchmark-evidence/binary-gate-eval-core-full-old.json`
  - `docs/benchmark-evidence/binary-gate-eval-core-full-new.json`
  - `docs/benchmark-evidence/binary-gate-eval-core-small-old.json`
  - `docs/benchmark-evidence/binary-gate-eval-core-small-new.json`
  - `docs/benchmark-evidence/binary-gate-eval-merged-old.json`
  - `docs/benchmark-evidence/binary-gate-eval-merged-new.json`
  - `docs/benchmark-evidence/binary-gate-benchmark-internal-old.txt`
  - `docs/benchmark-evidence/binary-gate-benchmark-new.txt`
- Current synced model hash:
  - `1e5491eb4b571521d8fce3ca96384fd284a5f291ce0f62d4bc02dfd8b93a729d` (`packages/advisor/assets/binary-gate-model.json` and `docs/benchmark-evidence/binary-gate-model-updated.json`)
- Baseline artifact hash used for comparison:
  - `6cc4991ccc0704fcca6bae61b1e4445b2b8ffc843f8af24cbfc3937f339eedc1` (`docs/benchmark-evidence/binary-gate-model-baseline.json`)
- PR not created yet (per instruction to require explicit user approval before PR/merge).
- To create the PR now:
  - `git push origin HEAD`
  - `gh pr create --title "chore(advisor): update binary-gate model from terminal-bench sweep" --body "See docs/advisor-binary-gate-benchmark-evidence-2026-05-30.md"`