# Pi-Rogue Router

Local-only offline trajectory router experiments for Pi-Rogue.

This package intentionally does **not** change live advisor or orchestration behavior. It reads existing Pi session JSONL files, derives compact checkpoints, and computes cheap progress/loop signals without copying raw transcript content into derived artifacts.

The CLI examples below deliberately write repo-local `.pi/router/*` experiment outputs. Live extension state is separate and user-scoped under `~/.pi/agent/pi-rogue/router/`.

```bash
npm run router:rebuild -- --session ~/.pi/agent/sessions/.../session.jsonl --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session-dir ~/.pi/agent/sessions/... --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session ./current-session.jsonl --workspace-diff --output .pi/router/checkpoints-with-live-diff.jsonl
npm run router:decide -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl
npm run router:cards -- --events .pi/router/events.jsonl --output .pi/router/model-cards.jsonl
npm run router:outcomes -- --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --output .pi/router/outcomes.jsonl
npm run router:outcome-enrich -- --outcomes .pi/router/outcomes.jsonl --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --output .pi/router/outcomes.enriched.jsonl
npm run router:teacher-requests -- --checkpoint-file .pi/router/checkpoints.jsonl --output .pi/router/teacher-requests.jsonl --teacher openai-codex/gpt-5.5
npm run router:teacher-label -- --requests .pi/router/teacher-requests.jsonl --teacher-output .pi/router/teacher-decisions.jsonl --labels .pi/router/labels/teacher-labels.jsonl --failures .pi/router/teacher-failures.jsonl --teacher openai-codex/gpt-5.5 --max-attempts 2
npm run router:reflect -- --checkpoint-file .pi/router/checkpoints.jsonl --labels .pi/router/labels/teacher-labels.jsonl --reflection .pi/router/reflections/session.md --teacher openai-codex/gpt-5.5 --teacher-output .pi/router/teacher-decisions.jsonl
npm run router:dataset -- --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --outcomes .pi/router/outcomes.jsonl --labels .pi/router/labels/teacher-labels.jsonl --output .pi/router/training.jsonl
npm run router:gate-train -- --dataset .pi/router/training.train.jsonl --eval-dataset .pi/router/training.eval.jsonl --artifact .pi/router/binary-gate.json --report .pi/router/binary-gate-report.json
npm run router:report -- --events .pi/router/events.jsonl --outcomes .pi/router/outcomes.jsonl --dataset .pi/router/training.eval.jsonl --gate-report .pi/router/binary-gate-report.json --output .pi/router/report.json --markdown .pi/router/report.md
npm run router:sharpen -- --events .pi/router/events.jsonl --outcomes .pi/router/outcomes.jsonl --cards .pi/router/model-cards.jsonl --output .pi/router/sharpening-hints.json
npm run router:shadow -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl --output .pi/router/shadow-report.json

# Live router extension commands:
# /pi-rogue-router status|help|on|off|mode|profile|print|profiles|models|configure|cycle
# /pi-rogue-router mode observe      # default: recommendations only
# /pi-rogue-router mode auto_model   # explicit: apply model switches only
# /pi-rogue-router profile spark-smart
# /pi-rogue-router print mismatch_only|all|off
# ctrl+alt+p cycles router profiles (Ctrl-P is reserved by Pi model cycling).
# Auto-model flip policy lives in `~/.pi/agent/pi-rogue/router/config.json` under `autoModel` and currently defaults to:
#   minConfidence: 0.7
#   requiredConsecutiveMismatches: 2
#   minCooldownSeconds: 30
#   maxSwitchesPerWindow: 3
#   switchWindowSeconds: 300
```

## V1 telemetry notes

Router v1 defaults to observe-only. It adds outcome skeletons, stronger diff/error fingerprints, teacher-label request export, binary gate dataset export, and subagent-aware telemetry schemas. It does not spawn agents/subagents or promote policies automatically. The explicit `auto_model` mode may only switch the active model for future turns.

Live config is user-global at `~/.pi/agent/pi-rogue/router/config.json`, while mutable live state and route ledgers are isolated per Pi session under `~/.pi/agent/pi-rogue/router/sessions/<session-key>/state.json` and `events.jsonl`. The default `mode` is `observe`; `auto_model` must be explicitly selected and does not alter agents, subagents, tools, or execution paths.

- Diff telemetry stores counts and hashes from `git diff`, not raw patches. Offline rebuilds remain deterministic by default; use `--workspace-diff` only with one current live session/worktree snapshot.
- `router:outcome-enrich` upgrades conservative outcome skeletons with checkpoint/event-derived verifier, rework, interruption, override, and accepted-diff signals.
- Error fingerprints normalize paths, line numbers, timestamps, UUIDs, ports, and object ids before hashing.
- `router:teacher-requests` writes local JSONL requests for an explicit teacher model; `router:teacher-label` calls the explicitly configured teacher and writes decision/label JSONL artifacts. Invalid teacher responses are isolated per request, can be retried with `--max-attempts`, and can be written to `--failures` without persisting raw model output.
- `router:dataset` excludes `local-rule` labels by default so a future model does not merely imitate the current rules.
- `router:gate-train` trains a local binary continue-vs-intervene gate and evaluates it on a distinct labeled eval dataset; local-rule labels are rejected as training/eval truth and promotion remains manual/eval-gated.
- `router:report` writes JSON plus optional Markdown summaries across route ledgers, enriched outcomes, dataset labels, and gate evaluation reports.
- `router:sharpen` writes local-only `pi-router.sharpening-hints.v1` recommendations from route ledgers, optional outcomes, and optional capability cards. Hints include sample-size/confidence/auto-use guardrails, repo-local learning policy, and provenance, but never mutate config or promote policy automatically.

### Automated, upgrade-safe sharpening persistence

Use this one-shot command for cron/background automation:

```bash
npm run router:sharpen:auto -- --workspace .
```

By default it stores artifacts at:

- Linux/BSD: `<XDG_DATA_HOME || ~/.local/share>/pi-rogue-router/learning/<repo-name>-<hash>/`
- macOS: `~/Library/Application Support/pi-rogue-router/learning/<repo-name>-<hash>/`

The script:
- writes `latest.json` and `history/*.json` artifacts;
- writes `manifest.json` with source fingerprints for change detection;
- skips re-computation if inputs are unchanged (unless `--force`);
- migrates legacy `.pi/router/sharpening-hints.json` into the stable learning directory when present.

Cron example:

```bash
*/30 * * * * cd /path/to/pi-rogue && npm run router:sharpen:auto -- --workspace /path/to/pi-rogue
```

- Subagent route/ledger schemas describe parent-child evidence flow, but live autonomous spawning remains out of scope.
