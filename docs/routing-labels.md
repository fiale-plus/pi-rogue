# Routing labels for issue #8

This is the first-pass label set for the tiny local classifier.

## Labels

- `planning` — asking what to do next, scope, design, architecture, strategy
- `implementation` — coding/building/editing/refactoring work
- `debugging` — fixing errors, broken flows, failing tests, weird behavior
- `review` — checking PRs, validating changes, asking if something is correct
- `research` — reading docs, comparing options, looking up behavior
- `ops` — install/config/theme/shell/terminal/workspace setup
- `handoff` — compact/resume/continue-move-on style handoffs

## Label rules

Use the broadest useful label. If a prompt could fit multiple labels, pick the one that best matches the *user's immediate intent*.

Examples:
- “what should we do next?” → `planning`
- “fix this error” → `debugging`
- “review this PR” → `review`
- “set up local package install” → `ops`
- “continue after compact” → `handoff`

`check` is not a review label by itself. Route by object:
- “check diff / PR / code / my work” → `review`
- “check stats / status / logs / config” → `ops`
- “check why this failed / error / broken flow” → `debugging`
- “check what this tool is / is it safe / GitHub package” → `research`

Command-like prompts (`run`, `test`, `build`, `deploy`, `status`, `logs`) are `ops` unless the user asks for judgment on the result.

## Output format

The miner writes JSONL rows:

```json
{
  "text": "user turn...",
  "label": "planning",
  "confidence": 0.8,
  "confidenceSource": "heuristic",
  "reason": "planning signal",
  "sessionFile": "...",
  "sessionId": "...",
  "cwd": "...",
  "turnIndex": 12
}
```

## Run

```bash
npm run routing:mine
npm run routing:queue
npm run routing:autolabel
npm run routing:advisor-log
npm run routing:eval
```

Defaults:
- input: `~/.pi/agent/sessions`
- output: `./data/routing/`
- writes `examples.jsonl` and `unlabeled.jsonl`
