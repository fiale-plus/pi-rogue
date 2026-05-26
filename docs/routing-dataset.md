# Routing dataset workflow

Issue #8 needs a small **local** classifier. The training set must not be only heuristic labels; otherwise the model learns rule imitation rather than advisor-routing intent.

## Files

Generated files are ignored by git:

- `data/routing/examples.jsonl` — weak heuristic labels from local Pi sessions
- `data/routing/unlabeled.jsonl` — skipped/ambiguous user turns
- `data/routing/label-queue.jsonl` — hand-label queue; fill `goldLabel`
- `data/routing/label-queue.md` — Obsidian-friendly review view
- `data/routing/gold.jsonl` — final gold/model-gold set from reviewed queue rows
- `data/routing/model-label-queue.jsonl` — model-assisted labels with provenance
- `data/routing/advisor-router-examples.jsonl` — real advisor router decisions

## Build the queue

```bash
npm run routing:mine
npm run routing:queue -- --per-label 50 --ambiguous 150
```

The queue builder:

- dedupes normalized user turns
- samples up to N rows per heuristic label
- oversamples rare/high-value labels such as `planning` and `debugging`
- includes ambiguous rows that look like command/status/debug/research boundary cases
- keeps heuristic labels only as hints (`heuristicLabel`), never as gold truth

## Annotation rules

Fill `goldLabel` with exactly one of:

- `planning`
- `implementation`
- `debugging`
- `review`
- `research`
- `ops`
- `handoff`
- `drop`

Use `drop` for rows that are too short, accidental, duplicate, or not a real routing decision.

Do not blindly copy `heuristicLabel`. Label from the raw user text and immediate intent.

## Quality targets before model training

Minimum viable gold set:

- 120–160 hand-labeled rows
- at least 15 rows each for `review`, `research`, `ops`, `implementation`, `handoff`
- include all real `planning` and `debugging` rows found in the queue
- at least 40 rows from ambiguous/skipped turns

Better first training set:

- 250–350 hand-labeled rows
- 25+ rows per stable class
- explicit `drop` examples for exit/no-op/too-short commands

## Mine real advisor router log

```bash
npm run routing:advisor-log
```

This reads `~/.pi/agent/fiale-plus/advisor/evals/advisor-router.jsonl` and writes advisor-specific examples. These labels are **not** the same taxonomy as task-intent labels; use them for advisor phase/decision training and diagnostics only.

Current finding: failed-turn closeout rows like `Turn reported failure.` are diagnostic examples, not task-intent training examples.

## Train the first baseline

```bash
npm run routing:train
```

This trains TF-IDF + multinomial logistic regression on `data/routing/gold.jsonl`, saves `data/routing/routing-model.json`, and writes a training report with accuracy, macro-F1, weighted-F1, per-class recall, and confusion matrix.

## Score active-learning queue

```bash
npm run routing:score
```

This ranks `data/routing/unlabeled.jsonl` by model uncertainty and writes `data/routing/active-learning-queue.jsonl` plus a report. Use this to pull the hardest examples back into gold if manual review becomes available.

## Train the binary gate

```bash
npm run binary:build
npm run binary:train
```

Builds the binary gate dataset from gold + Pi + Claude sessions, then trains TF-IDF + logistic regression. Model saved to `data/routing/binary-gate-model.json`.

## Evaluate conflict ablation

```bash
npm run binary:eval-conflicts
```

This is a read-only ablation for label-noise analysis. It finds exact prompts that conflict between curated gold and heuristic Pi examples, removes those prompts from the binary dataset, and reruns gold/source holdout diagnostics. Use it to decide whether training weakness is mostly conflict-driven or whether broader feature/label work is needed.

## Benchmark

```bash
npm run binary:benchmark
```

## Training gate

Train only after gold data exists. Evaluate on held-out labels with macro-F1 and per-class recall.
