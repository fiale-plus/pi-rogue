# PiRogue agent usage playbook

This guide is for running PiRogue in agentic workflows.

## 0) Start with orientation

Run:

- `/pi-rogue`

This gives the current status of advisor mode, check-ins, and orchestration pointers in one place.

## 1) Advisory-first tasks

Use advisor for architecture/tradeoff-heavy changes:

1. `/advisor status` (or just `/pi-rogue`) to see current policy
2. `/advisor <question>` when decision support is needed
3. Optionally pin model: `/advisor model <provider>/<model>`

When the task is finished or escalated, return to normal command flow with no extra state.

## 2) Deterministic work with goals and loops

For bounded workflow execution, keep the surface explicit:

1. Define the objective: `/goal set <goal>`
2. Add cadence: `/loop 5m <instruction>` (minimum is `1m`)
3. Use periodic assistant-driven checks: status is visible via `/loop status`
4. Finish only when `GOAL_DONE` is ready by explicit check result logic
5. Clear intentionally when done: `/goal clear` (or `/loop off`)

## 3) Autoresearch mode

Use `/autoresearch` when the work has a measurable cycle:

- Start: `/autoresearch <instruction>`
- Observe: `/autoresearch status`
- Stop: `/autoresearch clear`

The flow:
- writes a research-shaped goal
- starts a 5m loop
- queues the first cycle immediately
- requires multiple/evidence-backed steps before completion

## 4) Lab mode (`/autoresearch-lab`)

Use only after explicit confirmation for broader parallel exploration.

- `/autoresearch-lab <instruction>` starts parallel lanes.
- `/autoresearch-lab status` reports state.
- `/autoresearch-lab clear` stops lab-backed loop.

## 5) Check-ins and session hygiene

Default check-ins are `mid-hour` and interval-gated.

- Enable/disable: `/advisor checkins on` / `/advisor checkins off`
- Set explicit cadence: `/advisor checkins 15`
- Inspect: `/advisor config`

This is intentionally lightweight; there is no long-running daemon.

## Recommended command set for day-to-day agent work

- `/pi-rogue`
- `/advisor` / `/advisor status`
- `/goal`
- `/loop status|off`
- `/autoresearch`
- `/autoresearch-lab`

Keep every long loop command explicit. If command intent is uncertain, run status commands first and confirm before starting a long-running mode.

## What to avoid (to keep it clean)

- Don’t rely on implicit defaults for critical production edits.
- Don’t run autoresearch modes in silent background without a declared objective.
- Don’t collapse `/autoresearch` and `/autoresearch-lab` into one behavior.
