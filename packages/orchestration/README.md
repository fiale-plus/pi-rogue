# @fiale-plus/pi-rogue-orchestration

> **Releases paused.** This package is now internal. All usage and updates are via the consolidated `@fiale-plus/pi-rogue` artefact (see root README, `docs/release.md`, and AGENTS.md). Direct installs and independent releases are on pause; the package is marked private. Code here continues to evolve and ships inside the canonical package release.

## What this package is

Session orchestration for Pi-Rogue built around three primitives:

1. `goal` — define and track what success looks like
2. `loop` — periodic execution with explicit start/stop
3. `autoresearch` / canonical `lab` — goal+loop facades for iterative or parallelized optimization

## Install

**For users:** Use the canonical package (releases for this package are paused):

```bash
pi install npm:@fiale-plus/pi-rogue
```

**For local development (monorepo only):**

```bash
npm install --workspace packages/orchestration
```

(See root README and docs/release.md for the consolidated policy.)

## Commands

| Command | What it does |
|---|---|
| `/pi-rogue-orchestration goal set <text>` (or `/goal set <text>`) | Set/update current goal and re-arm check-ins |
| `/pi-rogue-orchestration goal show` (or `/goal show`) | Show current goal |
| `/pi-rogue-orchestration goal clear` (or `/goal clear`) | Clear active goal |
| `/pi-rogue-orchestration goal list` (or `/goal list`) | Show recent goal history |
| `/pi-rogue-orchestration loop <interval> <instruction>` (or `/loop <interval> <instruction>`) | Create or reset periodic loop (`1m` minimum) |
| `/pi-rogue-orchestration loop status` (or `/loop status`) | Show current loop state |
| `/pi-rogue-orchestration loop off` / `clear` / `stop` (or `/loop off` / `/loop clear` / `/loop stop`) | Clear loop |
| `/pi-rogue-orchestration autoresearch <instruction>` (or `/autoresearch <instruction>`) | Start/update solo research flow |
| `/pi-rogue-orchestration autoresearch status` (or `/autoresearch status`) | Show autoresearch state |
| `/pi-rogue-orchestration autoresearch clear` (or `/autoresearch clear`) | Clear solo research + underlying loop |
| `/pi-rogue-orchestration lab <instruction>` | Start/update parallel research mode |
| `/pi-rogue-orchestration lab status` | Show lab state |
| `/pi-rogue-orchestration lab clear` | Clear lab + underlying loop |

## Behavior notes

- `loop` supports minimum interval `1m`.
- Active goals can be completed with the model-callable `goal_complete` tool, which requires a summary and verification evidence; `GOAL_DONE` / `GOAL_CONTINUE` sentinel loop checks are preserved for compatibility.
- `/autoresearch` and `/pi-rogue-orchestration lab` are thin facades over goal + loop.
- Entering lab from an inactive state requires confirmation before any goal/research/loop write or queued turn; no `/autoresearch-lab` root is registered.
- A goal or loop activation enables scheduled advisor check-ins; stopping or clearing the active goal/loop disables them again.
- Check-ins are part of orchestration lifecycle, not a standalone advisor command. They use the advisor interval, higher/advanced advisor models first, and regular model fallback by default.
- A bounded no-progress guard detects repeated assistant output or repeated planning-only turns during active orchestration, then nudges one concrete alternative action and eventually stops retry churn instead of stacking recovery prompts.
- There are no hidden flow budgets. Long loops run until `/pi-rogue-orchestration loop off`, `/pi-rogue-orchestration goal clear`, `goal_complete`, or a `GOAL_DONE` response clears the active goal and loop.
- Stale research state is cleared when `goal` or `loop` are cleared.
