---
name: orchestration
description: Session orchestration for Pi; use when you want to manage loop cadence, goals, or opt-in autoresearch in the current session.
---

# Orchestration

Use this skill to manage the current session workflow.

## Core shape

- `loop` is the primitive: interval / tick / cancel / stop
- `goal` is the wrapper: target, retarget, progress, completion criteria
- `autoresearch` is iterative optimization on top of goal/loop
- `autoresearch-lab` is parallel multi-agent research on top of autoresearch
- extra prompts become explicit side quests, not goal loss

## Goal

- `/goal` — show current goal (and refresh the goal status badge)
- `/goal set <text>` — set the goal; if a loop is active, the first completion check starts immediately
- `/goal clear` — clear it
- `/goal list` — recent history

## Loop

- `/loop <interval> <instruction>` — record a loop cadence and instruction; minimum interval is 1m; the extension schedules the first tick after the interval and uses goal checks on each tick when a goal is active
- `/loop status` — show loop status
- `/loop off` — clear the loop

## Autoresearch

Use when you want to systematically improve a measurable metric through automated experiment cycles.

Key behaviors to preserve:
- metric-first workflow
- measurement command outputs a number
- identify → implement → build/check → test → sanity → log → repeat
- backpressure and stall detection
- resume from `.autoresearch/` state when present
- keep the benchmark/evaluation script as the product

Commands:
- `/autoresearch <instruction>` — start or update the solo research flow; this creates a research goal, starts a 5m loop, queues the first cycle immediately, and requires multiple/evidence-backed cycles before auto-completion
- `/autoresearch status` — show research status, underlying goal/loop backing, cycle count, done attempts, and last goal-check result
- `/autoresearch clear` — clear it and stop its underlying loop; matching `/goal clear` or `/loop off` also clears stale autoresearch status

## Autoresearch lab

Use when the scope can be split into independent areas and you want parallel researchers.

Key behaviors to preserve:
- isolated worktrees per researcher
- split scope into independent areas with no file overlap
- evaluator checkpoint before merge
- cherry-pick non-conflicting improvements
- revert on checks failure
- wave-based redesign when plateauing

Commands:
- `/autoresearch-lab <instruction>` — start or update the lab flow; this creates a lab-shaped goal, starts a 5m loop, and queues the first cycle immediately
- `/autoresearch-lab status` — show lab status and the underlying goal/loop backing
- `/autoresearch-lab clear` — clear it and stop its underlying loop

## Auto-detection and safety

- Detect likely `goal`, `autoresearch`, or `autoresearch-lab` opportunities from the user request and project context.
- Present a proposal first instead of silently starting a long run.
- In interactive mode, ask for explicit confirmation before launching long-running flows.
- In unattended mode, only auto-run if policy explicitly allows the detected command and budget.
- Never auto-escalate from solo research to lab mode without approval.

## Notes

- Keep the loop primitive minimal.
- Put deviation, retargeting, and recovery in goal state.
- Keep autoresearch as an opt-in layer; do not flatten it into a generic template.
