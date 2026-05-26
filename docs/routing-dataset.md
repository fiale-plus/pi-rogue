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

By default this scans all local advisor router logs matching `~/.pi/agent/*/advisor/evals/advisor-router.jsonl` and writes advisor-specific examples. Pass `-- --input <file>` (or comma-separated files) to narrow the source. These labels are **not** the same taxonomy as task-intent labels; use them for advisor phase/decision training and diagnostics only.

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

## Mine session model outcomes

```bash
npm run sessions:model-outcomes
npm run sessions:model-outcomes -- --cwd-contains pi-rogue
npm run sessions:model-outcomes -- --model-contains gpt-5.3-codex-spark
```

This is a read-only session miner for advisor-model research. It scans local Pi session JSONL files, extracts assistant model calls, stop reasons, tool-call counts, token/cost usage, nearby user intent, and context-length errors. It writes generated outputs under `data/routing/session-model-outcomes*.{json,jsonl}` for analysis only; it does not mutate session files or change routing behavior.

Use this lane to evaluate when fast models such as `gpt-5.3-codex-spark` are good enough versus when larger advisor models are safer because of context pressure, length stops, or error patterns.

## Train the binary gate

```bash
npm run binary:build
npm run binary:train
```

Builds the binary gate dataset from gold + Pi + Claude sessions, then trains TF-IDF + logistic regression. Model saved to `data/routing/binary-gate-model.json`.

## Evaluate source holdout

```bash
npm run binary:eval-sources
```

This trains the binary gate on all but one data source and tests on the held-out source. Use this before replacing the shipped gate: random splits can look strong while source splits reveal overfitting to `gold`, `pi_session`, or `claude_history` wording.

## Review exact binary conflicts

```bash
npm run binary:review-conflicts
```

Exports exact gold-vs-heuristic conflicts to ignored JSON/Markdown reports and evaluates an explicit source-priority review overlay against gold holdout. This is diagnostic only: it does not mutate gold labels, generated datasets, shipped model assets, or runtime routing.

## Evaluate candidate training matrix

```bash
npm run binary:eval-candidates
```

This is an eval-only candidate matrix for advisor binary-gate training. It compares non-gold baseline, curated-gold calibration, and source-priority conflict weighting on held-out gold, held-out conflict rows, and random session-derived rows. Generated reports stay ignored under `data/routing/`; no shipped model or runtime routing is changed.

## Evaluate Q1-Q10 conflict augmentation

```bash
npm run binary:eval-q1-q10
```

This converts the Q1-Q10 conflict-labeling interview into resolved conflict examples with rule provenance, then evaluates whether adding those examples helps the binary model. The rules are used as labeling metadata only; this is not a runtime policy overlay and does not replace shipped advisor assets.

To evaluate reviewed augmentation rows from JSONL files, pass one or more paths:

```bash
npm run binary:eval-q1-q10 -- --reviewed /tmp/q1-q10-reviewed-batch-1.jsonl,/tmp/q1-q10-reviewed-batch-2.jsonl
```

## Build Q1-Q10 conflict-like review queue

```bash
npm run binary:q1-q10-queue
```

This scans unlabeled and weakly labeled routing rows for Q1-Q10-like boundary cases and writes an ignored JSONL/Markdown review queue. Use it to add reviewed conflict-like examples so future binary-gate candidates can learn the policy from data rather than runtime rules.

## Benchmark

```bash
npm run binary:benchmark
```

## Training gate

Train only after gold data exists. Evaluate on held-out labels with macro-F1 and per-class recall.
