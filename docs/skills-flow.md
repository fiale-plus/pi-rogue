# Skills-to-flow map

This repo keeps the existing skill logic intact and routes it into the orchestration stack without flattening it into generic templates.

## Advisory

- `skill:advisor`
- Feeds `packages/advisor`
- Role: strategic advice, routing, preflight, and session guidance

## Orchestration core

- `loop` → primitive tick/heartbeat layer
- `goal` → session objective, retargeting, side-quest recovery, completion; owns advisor check-in lifecycle while active

## Research

### `autoresearch`

- Source skill: iterative optimization with measurement, implementation, checks, and stall detection
- In flow: `packages/orchestration` command `/autoresearch`
- Role: single-agent optimization over a measurable target
- Runtime: facade over `/goal` + `/loop`; starting autoresearch writes a research-shaped goal, starts a 5m loop, enables advisor check-ins while active, queues the first cycle immediately, records cycle/result status, and clears stale status/check-ins when the backing goal or loop is cleared
- Preserved goodness:
  - metric-first workflow
  - measurement + checks
  - backpressure / stall checks
  - resume support
  - explicit logging

### `autoresearch-lab`

- Source skill: parallel multi-agent research
- In flow: `packages/orchestration` command `/autoresearch-lab`
- Role: split the work into independent areas and run them in parallel worktrees
- Runtime: facade over `/goal` + `/loop`; starting lab mode writes a lab-shaped goal, starts a 5m loop, and queues the first cycle immediately
- Preserved goodness:
  - isolated worktrees
  - evaluator checkpoint
  - merge/cherry-pick discipline
  - wave-based redesign when plateauing

## Auto-detection and confirmation

- Auto-detect candidate orchestration modes from the user request and project context.
- Present a proposal first (`goal`, `autoresearch`, or `autoresearch-lab`) instead of silently starting a long run.
- In interactive mode, ask for explicit confirmation before writing or launching a long-lived flow.
- In unattended mode, only auto-run if policy explicitly allows the detected command.
- Never auto-escalate from `autoresearch` to `autoresearch-lab` without approval.

## No flattening guarantee

The commands remain distinct:

- `/autoresearch` = solo optimization
- `/autoresearch-lab` = parallel research lab

They are not collapsed into a single generic research template.
