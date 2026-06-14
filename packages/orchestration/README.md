# @fiale-plus/pi-rogue-orchestration

> **Releases paused.** This package is now internal. All usage and updates are via the consolidated `@fiale-plus/pi-rogue` artefact (see root README, `docs/release.md`, and AGENTS.md). Direct installs and independent releases are on pause; the package is marked private. Code here continues to evolve and ships inside the canonical package release.

## What this package is

Session orchestration for Pi-Rogue built around three primitives:

1. `goal` — define and track what success looks like
2. `loop` — periodic execution with explicit start/stop
3. `autoresearch` / `autoresearch-lab` — goal+loop facades for iterative or parallelized optimization

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
| `/goal set <text>` | Set/update current goal and re-arm check-ins |
| `/goal show` | Show current goal |
| `/goal clear` | Clear active goal |
| `/goal list` | Show recent goal history |
| `/loop <interval> <instruction>` | Create or reset periodic loop (`1m` minimum) |
| `/loop status` | Show current loop state |
| `/loop off` / `clear` / `stop` | Clear loop |
| `/autoresearch <instruction>` | Start/update solo research flow |
| `/autoresearch status` | Show autoresearch state |
| `/autoresearch clear` | Clear solo research + underlying loop |
| `/autoresearch-lab <instruction>` | Start/update parallel research mode |
| `/autoresearch-lab status` | Show lab state |
| `/autoresearch-lab clear` | Clear lab + underlying loop |

## Behavior notes

- `loop` supports minimum interval `1m`.
- Active goals can be completed with the model-callable `goal_complete` tool, which requires a summary and verification evidence; `GOAL_DONE` / `GOAL_CONTINUE` sentinel loop checks are preserved for compatibility.
- `autoresearch` and `autoresearch-lab` are thin facades over `/goal + /loop`.
- A goal or loop activation enables scheduled advisor check-ins; stopping or clearing the active goal/loop disables them again.
- Check-ins are part of orchestration lifecycle, not a standalone advisor command. They use the advisor interval, higher/advanced advisor models first, and regular model fallback by default.
- A bounded no-progress guard detects repeated assistant output or repeated planning-only turns during active orchestration, then nudges one concrete alternative action and eventually stops retry churn instead of stacking recovery prompts.
- There are no hidden flow budgets. Long loops run until `/loop off`, `/goal clear`, `goal_complete`, or a `GOAL_DONE` response clears the active goal and loop.
- Stale research state is cleared when `goal` or `loop` are cleared.
