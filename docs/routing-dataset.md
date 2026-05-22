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
- `data/routing/advisor-router-examples.jsonl` — real advisor router decisions from local logs
- `data/routing/advisor-router-report.json` — real-log diagnostics and trainability summary

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

## Convert reviewed queue to gold

If labels are manually filled in `label-queue.jsonl`:

```bash
npm run routing:gold
npm run routing:eval -- --input data/routing/gold.jsonl
```

If manual labeling is unavailable, run a provenance-marked model-assisted pass:

```bash
npm run routing:autolabel
npm run routing:eval -- --input data/routing/gold.jsonl
```

Use `npm run routing:gold -- --allow-partial` while labeling to get progress counts before the minimum viable set is complete.

## Mine real advisor router log

```bash
npm run routing:advisor-log
```

This reads `~/.pi/agent/fiale-plus/advisor/evals/advisor-router.jsonl` and writes advisor-specific examples. These labels are **not** the same taxonomy as task-intent labels; use them for advisor phase/decision training and diagnostics only.

Current finding: failed-turn closeout rows like `Turn reported failure.` are diagnostic examples, not task-intent training examples.

## Training gate

Train only after `gold.jsonl` exists with at least 120 validated rows. Evaluate on hand labels with macro-F1 and per-class recall. Heuristic-vs-heuristic accuracy is only a consistency check.
