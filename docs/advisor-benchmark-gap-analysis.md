# Advisor benchmark gap analysis (gpt-5.5 vs gpt-5.3-codex-spark)

This artifact tracks the **largest observed gap** between 5.5 and 5.3 variants from available `/tmp` benchmark summaries.

## Durable command

```bash
npm run benchmark:advisor-gap -- \
  --summaries /tmp/bench-hard/summary.json,/tmp/bench-guided/summary.json,/tmp/bench-guided2/summary.json,/tmp/bench-modes/summary.json,/tmp/bench-modes-v2/summary.json
```

By default, the script also writes:
- `data/routing/advisor-benchmark-gap-report.json`
- `data/routing/advisor-benchmark-gap-report.md`

(`data/routing/*` artifacts are generated outputs and ignored by git in this repo.)

## Current measurable result

From the latest run artifacts:

- **No gap on strict regular no-advisor tasks**
  - `5.3_spark_no_advisor` vs `5.5_no_advisor` = **90.0% vs 90.0%** (`+0.000 abs`)
  - across `bench-hard`, `bench-modes`, `bench-modes-v2`.
- **Largest observed task-mode gap (latest)**
  - `5.3_spark_advised_by_5.5` = **80.0%** vs `5.3_spark_no_advisor` = **90.0%** (`+0.100 abs` absolute gain for plain; 12.50% relative)
  - same result appears in the hard + modes + modes-v2 harness.
- **Clean-task gap**
  - `5.3_clean` vs `5.5_clean` = **0.80 vs 0.90** (`+0.100 abs`, `+12.50% rel`) from the latest `bench-guided2` rerun.
  - prior snapshot had 0.70 vs 0.90 in `bench-guided2`; rerunning this lane shows variability from execution drift.
- **Advised mode signal**
  - In strict-task hard run, advisory assistance under-performed (`5.3_spark_advised_by_5.5` = **80.0%**).

## Failure pattern signal (actionable for binary advisor training)

Primary recurring misses are **format-sensitive strict-output errors**, not broad reasoning collapse:
- regex string quoting mismatch (`t7`, many modes)
- integer/ arithmetic representation mismatch in strict math format tasks
- one downstream failure where advised target was not copied exactly in `t10`

## Advisor-assisted ROI demo lane

The demo goal is not to expose how the advisor works internally. The demo goal is:

> can a 5.3 Spark session assisted only at key points by 5.5 get close to 5.5-only quality while costing meaningfully less than running the whole session on 5.5?

Durable commands:

```bash
npm run advisor-value:build
npm run advisor-demo:roi
npm run advisor-value:train
npm run advisor-value:eval
```

Outputs are generated under `data/routing/`:
- `advisor-value-benchmark.jsonl` — binary rows where `continue` means run 5.3 directly and `escalate` means call 5.5 advisor/teacher.
- `advisor-value-benchmark-report.json` — per-source oracle sparse-advisor metrics and call rates.
- `advisor-value-train-balanced.jsonl` — generated training set with rare advisor-help rows oversampled for the local gate.
- `advisor-value-model.json` / `advisor-value-training-report.json` — trained local binary gate artifacts.
- `advisor-value-eval-report.json` — self-eval report on the generated value-of-advice dataset.

Current demo success criteria:
- Sparse Spark+5.5 reaches **>=95% of 5.5-only quality** on the benchmark/demo slice.
- Sparse Spark+5.5 costs **less than 5.5-only** on the benchmark/demo slice.
- Preferred cost target: **<=80% of 5.5-only** and **<=25% incremental over Spark**.
- Regular-session budget: **1–5% no-tool 5.5 advisor turns** and **<=10% no-tool 5.5 token ratio**.

Current ROI report from `npm run advisor-demo:roi`:
- Spark: **84.0%** aggregate quality at **$0.004016/task**.
- 5.5-only: **88.0%** aggregate quality at **$0.006760/task**.
- Sparse Spark+5.5 oracle: **94.0%** aggregate quality at **$0.004699/task**.
- Sparse quality vs 5.5-only: **106.8%**.
- Sparse cost vs 5.5-only: **69.5%**.
- Sparse cost vs Spark: **117.0%**.
- Advisor call rate in this stress/demo slice: **10.0%**.

Current direction:
- Use 5.3 Spark by default.
- Call 5.5 sparsely on observed “advisor helps” families.
- Penalize advisor calls on strict-output/copy/schema tasks where the hard harness showed advisor-induced harm.
- Report ROI as quality/cost vs 5.5-only, not as advisor internals.

## Suggested follow-up

If we want true benchmark evidence for DeepPlanning-style long-horizon planning gaps, add a DeepPlanning snapshot into the same command shape and compare:
- `5.3_spark_no_advisor`
- `5.5_no_advisor`
- `5.3_spark_advised_by_5.5`

Then rebuild the advisor-value dataset so DeepPlanning-derived “5.3 missed, 5.5/guided succeeded” rows become direct sparse-advisor training signal.