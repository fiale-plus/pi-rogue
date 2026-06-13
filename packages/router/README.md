# Pi-Rogue Router

Local-only offline trajectory router experiments for Pi-Rogue.

This package intentionally does **not** change live advisor or orchestration behavior. It reads existing Pi session JSONL files, derives compact checkpoints, and computes cheap progress/loop signals without copying raw transcript content into derived artifacts.

```bash
npm run router:rebuild -- --session ~/.pi/agent/sessions/.../session.jsonl --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session-dir ~/.pi/agent/sessions/... --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session ./current-session.jsonl --workspace-diff --output .pi/router/checkpoints-with-live-diff.jsonl
npm run router:decide -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl
npm run router:cards -- --events .pi/router/events.jsonl --output .pi/router/model-cards.jsonl
npm run router:outcomes -- --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --output .pi/router/outcomes.jsonl
npm run router:outcome-enrich -- --outcomes .pi/router/outcomes.jsonl --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --output .pi/router/outcomes.enriched.jsonl
npm run router:teacher-requests -- --checkpoint-file .pi/router/checkpoints.jsonl --output .pi/router/teacher-requests.jsonl --teacher openai-codex/gpt-5.5
npm run router:teacher-label -- --requests .pi/router/teacher-requests.jsonl --teacher-output .pi/router/teacher-decisions.jsonl --labels .pi/router/labels/teacher-labels.jsonl --teacher openai-codex/gpt-5.5
npm run router:reflect -- --checkpoint-file .pi/router/checkpoints.jsonl --labels .pi/router/labels/teacher-labels.jsonl --reflection .pi/router/reflections/session.md --teacher openai-codex/gpt-5.5 --teacher-output .pi/router/teacher-decisions.jsonl
npm run router:dataset -- --checkpoint-file .pi/router/checkpoints.jsonl --events .pi/router/events.jsonl --outcomes .pi/router/outcomes.jsonl --labels .pi/router/labels/teacher-labels.jsonl --output .pi/router/training.jsonl
npm run router:gate-train -- --dataset .pi/router/training.train.jsonl --eval-dataset .pi/router/training.eval.jsonl --artifact .pi/router/binary-gate.json --report .pi/router/binary-gate-report.json
npm run router:shadow -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl --output .pi/router/shadow-report.json

# Live observe-only extension commands:
# /router on|off|status|profile|profiles|models|configure|cycle
# ctrl+alt+p cycles router profiles (Ctrl-P is reserved by Pi model cycling).
```

## V1 telemetry notes

Router v1 is still observe-only. It adds outcome skeletons, stronger diff/error fingerprints, teacher-label request export, binary gate dataset export, and subagent-aware telemetry schemas. It does not switch models, spawn agents, or promote policies automatically.

Live config is repo-global at `.pi/router/config.json`, while mutable live state and route ledgers are isolated per Pi session under `.pi/router/sessions/<session-key>/state.json` and `events.jsonl`.

- Diff telemetry stores counts and hashes from `git diff`, not raw patches. Offline rebuilds remain deterministic by default; use `--workspace-diff` only with one current live session/worktree snapshot.
- `router:outcome-enrich` upgrades conservative outcome skeletons with checkpoint/event-derived verifier, rework, interruption, override, and accepted-diff signals.
- Error fingerprints normalize paths, line numbers, timestamps, UUIDs, ports, and object ids before hashing.
- `router:teacher-requests` writes local JSONL requests for an explicit teacher model; `router:teacher-label` calls the explicitly configured teacher and writes decision/label JSONL artifacts.
- `router:dataset` excludes `local-rule` labels by default so a future model does not merely imitate the current rules.
- `router:gate-train` trains a local binary continue-vs-intervene gate and evaluates it on a distinct labeled eval dataset; local-rule labels are rejected as training/eval truth and promotion remains manual/eval-gated.
- Subagent route/ledger schemas describe parent-child evidence flow, but live autonomous spawning remains out of scope.
