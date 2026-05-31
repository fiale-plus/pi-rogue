# @fiale-plus/pi-rogue-orchestration

## What this package is

Session orchestration for Pi-Rogue built around three primitives:

1. `goal` — define and track what success looks like
2. `loop` — periodic execution and backpressure-safe scheduling
3. `autoresearch` / `autoresearch-lab` — goal+loop facades for iterative or parallelized optimization

## Install

```bash
# Published package
pi install npm:@fiale-plus/pi-rogue-orchestration

# Local package development
npm install --workspace packages/orchestration
```

## Commands

| Command | What it does |
|---|---|
| `/goal set <text>` | Set/update current goal (auto-starts a first check when loop exists) |
| `/goal show` | Show current goal |
| `/goal clear` | Clear active goal |
| `/goal list` | Show recent goal history |
| `/loop <interval> <instruction>` | Create or reset periodic loop (`1m` minimum) |
| `/loop status` | Show current loop state |
| `/loop off` / `clear` / `stop` | Clear loop |
| `/autoresearch <instruction>` | Start/update solo research flow (1+ cycles required before completion) |
| `/autoresearch status` | Show autoresearch state/counters/status |
| `/autoresearch clear` | Clear solo research + underlying loop |
| `/autoresearch-lab <instruction>` | Start/update parallel research mode |
| `/autoresearch-lab status` | Show lab state |
| `/autoresearch-lab clear` | Clear lab + underlying loop |

## Behavior notes

- `loop` supports minimum interval `1m`.
- `goal` checks are done through assistant loop ticks; `GOAL_DONE` / `GOAL_CONTINUE` are preserved.
- `autoresearch` and `autoresearch-lab` are thin facades over `/goal + /loop`.
- Loop activation enables scheduled advisor check-ins; stopping the active loop disables them again.
- Check-ins are part of orchestration lifecycle, not a standalone advisor command. They use higher/advanced advisor models first, with regular model fallback enabled by default.
- A conversation novelty guard suppresses repeated status-confirmation prompts before they can re-enter advisor/model flow, and asks for clarification on truncated prompts.
- `goal` and `autoresearch` flows enforce budgets (turns, wall time, advisor check-ins) so local-model runs cannot spin forever or keep draining advisor capacity.
- Stale research state is cleared when `goal` or `loop` are cleared.
