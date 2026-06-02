---
name: orchestration
description: Session orchestration for Pi; use when you want to manage loop cadence, goals, or opt-in autoresearch in the current session.
---

# Pi-Rogue Orchestration

Use this skill to run measurable, bounded workflow loops inside a Pi session.

## Command surface

| Command | What it does |
|---|---|
| `/goal set <text>` | Set or update the current goal |
| `/goal show` | Show current goal |
| `/goal clear` | Clear goal |
| `/goal list` | Show recent goal history |
| `/loop <interval> <instruction>` | Run periodic checks (`1m` minimum) |
| `/loop status` | Show current loop |
| `/loop off` / `/loop clear` / `/loop stop` | Stop and clear loop |
| `/autoresearch <instruction>` | Solo iterative research on top of `/goal + /loop` |
| `/autoresearch status` | Show research counters and backing state |
| `/autoresearch clear` | Clear research and stop backing loop |
| `/autoresearch-lab <instruction>` | Parallel research mode (lab) |
| `/autoresearch-lab status` | Show lab state |
| `/autoresearch-lab clear` | Clear lab and stop backing loop |

## Behavior rules

- `loop` is the primitive; `goal` is the execution intent.
- Goal completion is explicit through `GOAL_DONE` / `GOAL_CONTINUE` in loop checks.
- `autoresearch` / `autoresearch-lab` are facades over goal+loop.
- Goal or loop activation enables scheduled advisor check-ins; stopping or clearing either disables them.
- Check-ins belong to orchestration lifecycle, not the advisor command surface, and use higher/advanced advisor models first, with regular model fallback enabled by default.
- `autoresearch` enforces multi-cycle + evidence-aware completion.
- Clearing goal/loop clears stale autoresearch state.

## Safety and agentic flow

- Auto-detect opportunities are proposals first, not silent launches.
- `autoresearch-lab` requires explicit confirmation for escalation.
- Commands remain distinct:
  - `/autoresearch` = solo optimization
  - `/autoresearch-lab` = parallel lab mode
