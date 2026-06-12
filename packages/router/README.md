# Pi-Rogue Router

Local-only offline trajectory router experiments for Pi-Rogue.

This package intentionally does **not** change live advisor or orchestration behavior. It reads existing Pi session JSONL files, derives compact checkpoints, and computes cheap progress/loop signals without copying raw transcript content into derived artifacts.

```bash
npm run router:rebuild -- --session ~/.pi/agent/sessions/.../session.jsonl --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session-dir ~/.pi/agent/sessions/... --output .pi/router/checkpoints.jsonl
npm run router:decide -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl
npm run router:cards -- --events .pi/router/events.jsonl --output .pi/router/model-cards.jsonl
npm run router:reflect -- --checkpoint-file .pi/router/checkpoints.jsonl --labels .pi/router/labels/teacher-labels.jsonl --reflection .pi/router/reflections/session.md --teacher local-rule
npm run router:shadow -- --checkpoint-file .pi/router/checkpoints.jsonl --ledger .pi/router/events.jsonl --output .pi/router/shadow-report.json

# Live observe-only extension commands:
# /router on|off|status|profile|profiles|models|configure|cycle
# ctrl+alt+p cycles router profiles (Ctrl-P is reserved by Pi model cycling).
```
