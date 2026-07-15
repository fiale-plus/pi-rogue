# @fiale-plus/pi-rogue-advisor

> **Releases paused.** This package is now internal. All usage and updates are via the consolidated `@fiale-plus/pi-rogue` artefact (see root README, `docs/release.md`, and AGENTS.md). Direct installs and independent releases are on pause; the package is marked private. Code here continues to evolve and ships inside the canonical package release.

## What this package is

Strategic advisor for Pi sessions with low-overhead preflight/post-review routing, model auto-detection, session memory, and orchestration-managed mid-session check-ins.

- SOTA-first model fallback: `gpt-5.5`/`claude-opus-4-6`/`claude-sonnet-4-6` where available.
- Keeps command-level behavior simple and explicit.
- Router/binary-gate policy escalates architecture/refactor/tradeoff/security/high-uncertainty and material stuck/no-progress work, while tiny edits, direct answers, docs/formatting cleanup, and other low-risk reactive tasks continue without advisor noise.

## Install

**For users:** Use the canonical package (releases for this package are paused):

```bash
pi install npm:@fiale-plus/pi-rogue
```

**For local development (monorepo only):**

```bash
npm install --workspace packages/advisor
```

(See root README and docs/release.md for the consolidated policy.)

## Commands

| Command | What it does |
|---|---|
| `/pi-rogue` | Show the Pi-Rogue cockpit + command pointers |
| `/pi-rogue-advisor` | Show status (`/pi-rogue-advisor status`) and quick hint |
| `/pi-rogue-advisor status` | Show mode, review policy, check-in status, model selection, counters |
| `/pi-rogue-advisor settings` | Show full local configuration without a model call |
| `/pi-rogue-advisor config` | Alias for local `settings` |
| `/pi-rogue-advisor on` | Converge off/manual/auto to auto mode locally |
| `/pi-rogue-advisor off` | Disable advisor locally |
| `/pi-rogue-advisor mode auto\|manual\|off` | Change routing behavior |
| `/pi-rogue-advisor review light\|strict\|off` | Change review strictness |
| `/pi-rogue-advisor model <provider>/<model>` | Set explicit model override |
| `/pi-rogue-advisor gate status` | Inspect the trained binary-gate artifact |
| `/pi-rogue-advisor profile status\|budget-board\|off` | Inspect or control the explicit profile |
| `/pi-rogue-advisor checkins` | Explain orchestration-managed check-ins |
| `/pi-rogue-advisor pause <N>` | Pause advisor auto-runs for the next N turns |
| `/pi-rogue-advisor unpause` | Resume advisor auto-runs immediately |
| `/pi-rogue-advisor board status` | Inspect Advisor Board controls and status |
| `/pi-rogue-advisor <question>` | Get one-shot advisory response |

## Notes on defaults

- `mode`: `auto`
- `review`: `light`
- `checkins`: `off` (orchestration turns them on when a goal or loop is active)
- `checkinIntervalMinutes`: `30`
- `model`: not set (auto-detected)
- Advisor model resolution/completion work: bounded to `60_000ms` per session-owned work item (not user-configurable)
- Successful `on_track` review verdicts are recorded silently instead of displayed as follow-up messages.

Check-ins gate on session activity and `checkinIntervalMinutes`, avoid overlapping calls, and use higher/advanced advisor models first with regular model fallback enabled by default. Model work has one per-session owner: newer work supersedes stale work, shutdown aborts it, and the fixed 60-second deadline prevents a non-settling provider or credential lookup from holding a review/check-in lock. Explicit user cancellation is passed through unchanged. Check-ins are lifecycle-managed by orchestration: activating a goal or `/pi-rogue-orchestration loop` enables them, and clearing either disables them.

## Stability guarantees

- No flattening: the advisor remains its own surface and does not hide orchestration commands.
- Cockpit is simple and explicit: `/pi-rogue` is the top-level status view.
