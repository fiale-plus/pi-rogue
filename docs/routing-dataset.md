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

See `docs/routing-binary-gate.md` for the candidate-training runbook, guard slices, promotion bar, and evidence policy.

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

## Benchmark

```bash
npm run binary:benchmark
```

### Terminal-Bench 2.1/2.0 core slice workflow (reproducible)

For an external, task-style stress set:

1. Install Harbor CLI (temporary, from pip install path):

```bash
uv tool install terminal-bench
```

2. Download a pinned dataset version (no runtime execution required for data-only lane):

```bash
tb datasets download --dataset terminal-bench-core==0.1.1 --output-dir /tmp/terminal-bench-core-0.1.1
```

3. Build a labeled benchmark slice from task metadata (easy=>continue, non-easy=>escalate):

```bash
python3 - <<'PY'
import pathlib, re, json, random, hashlib
random.seed(42)
rows=[]
for p in pathlib.Path('/tmp/terminal-bench-core-0.1.1').rglob('task.yaml'):
    t=p.read_text()
    m_dif=re.search(r'^difficulty:\s*(\S+)', t, re.M)
    d=(m_dif.group(1) if m_dif else 'medium').strip().lower()
    m_inst=re.search(r'^instruction:\s*\|-\n([\s\S]*?)\n\S', t, re.M)
    instr=(m_inst.group(1) if m_inst else '').replace('\n  ','\n').strip()
    if not instr:
        text=f"Terminal-Bench task: {p.parent.name}."
    else:
        text=f"Terminal-Bench task: {p.parent.name}. {instr[:900]}"
    n=' '.join(text.lower().split())
    rows.append({'id': hashlib.md5(n.encode()).hexdigest()[:16], 'text': text, 'label': 'continue' if d=='easy' else 'escalate', 'source':'terminal-bench-core-0.1.1', 'sourceLabel': d})

easy=[r for r in rows if r['label']=='continue']
hard=[r for r in rows if r['label']=='escalate']
sel=random.sample(easy, min(12,len(easy))) + random.sample(hard, min(20,len(hard)))
out=pathlib.Path('data/routing/binary-gate-bench-terminal-core-small.jsonl')
out.write_text('\n'.join(json.dumps(r) for r in sel)+'\n')
print('rows',len(sel),'easy',len([r for r in sel if r['label']=='continue']),'escalate',len([r for r in sel if r['label']=='escalate']))
PY
```

4. Evaluate candidate vs shipped model on that slice:

```bash
npm run binary:eval-file -- --input data/routing/binary-gate-bench-terminal-core-small.jsonl --model data/routing/binary-gate-bench-terminal-core-model.json
```

```bash
npm run binary:eval-file -- --input data/routing/binary-gate-bench-terminal-core-small.jsonl
```

### Execute official Terminal-Bench run (when Docker is available)

```bash
tb run --agent oracle --dataset terminal-bench-core==0.1.1 --n-tasks 1 --output-path /tmp/tb_run_oracle --no-upload-results
```

### Promote benchmark-trained gate model to runtime (optional, explicit)

If this lane has passed your acceptance checks and you want to activate the enhanced model in production:

```bash
RUNTIME="$HOME/.pi/agent/fiale-plus/advisor/binary-gate-model.json"
CANDIDATE="data/routing/binary-gate-bench-terminal-core-model.json"
BACKUP="${RUNTIME}.bak.$(date +%Y%m%d_%H%M%S)"

cp "$RUNTIME" "$BACKUP"                             # rollback target
cp "$CANDIDATE" "$RUNTIME"

echo "promoted $CANDIDATE -> $RUNTIME"
echo "rollback: cp \"$BACKUP\" \"$RUNTIME\""
```

Verify after promotion with an explicit full-file sanity check:

```bash
npm run binary:eval-file -- --input data/routing/binary-gate.jsonl
```

If needed, rollback with:

```bash
cp "$BACKUP" "$RUNTIME"
```

Notes:
- Candidate artifacts are intentionally untracked (`data/routing/*.jsonl` / `data/routing/*.json`) and meant for reproducible local operations.
- `#65` currently contains the hardened benchmark lane; model-file promotion is an operational step performed in your runtime profile, not a committed repo artifact.

## Training gate

Train only after gold data exists. Evaluate on held-out labels with macro-F1 and per-class recall.
