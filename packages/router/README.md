# Pi-Rogue Router

Local-only offline trajectory router experiments for Pi-Rogue.

This package intentionally does **not** change live advisor or orchestration behavior. It reads existing Pi session JSONL files, derives compact checkpoints, and computes cheap progress/loop signals without copying raw transcript content into derived artifacts.

```bash
npm run router:rebuild -- --session ~/.pi/agent/sessions/.../session.jsonl --output .pi/router/checkpoints.jsonl
npm run router:rebuild -- --session-dir ~/.pi/agent/sessions/... --output .pi/router/checkpoints.jsonl
```
