# @fiale-plus/pi-rogue-advisor

## What this package is

Strategic advisor for Pi sessions with low-overhead preflight/post-review routing, model auto-detection, session memory, and orchestration-managed mid-session check-ins.

- SOTA-first model fallback: `gpt-5.5`/`claude-opus-4-6`/`claude-sonnet-4-6` where available.
- Keeps command-level behavior simple and explicit.

## Install

```bash
# Published package (recommended)
pi install npm:@fiale-plus/pi-rogue-advisor

# Local package development
npm install --workspace packages/advisor
```

## Commands

| Command | What it does |
|---|---|
| `/pi-rogue` | Show the Pi-Rogue cockpit + command pointers |
| `/advisor` | Show status (`/advisor status`) and quick hint |
| `/advisor status` | Show mode, review policy, check-in status, model selection, counters |
| `/advisor on` | Enable advisor (auto mode) |
| `/advisor off` | Disable advisor |
| `/advisor mode auto\|manual\|off` | Change routing behavior |
| `/advisor review light\|strict\|off` | Change review strictness |
| `/advisor pause <N>` | Pause advisor auto-runs for the next N turns |
| `/advisor unpause` | Resume advisor auto-runs immediately |
| `/advisor config` | Show current config |
| `/advisor model <provider>/<model>` | Set explicit model override |
| `/advisor <question>` | Get one-shot advisory response |

## Notes on defaults

- `mode`: `auto`
- `review`: `light`
- `checkins`: `off` (orchestration turns them on when a goal or loop is active)
- `checkinIntervalMinutes`: `30`
- `model`: not set (auto-detected)
- Successful `on_track` review verdicts are recorded silently instead of displayed as follow-up messages.

Check-ins gate on session activity and `checkinIntervalMinutes`, avoid overlapping calls, and use higher/advanced advisor models first with regular model fallback enabled by default. They are lifecycle-managed by orchestration: activating a goal or `/loop` enables them, and clearing either disables them.

## Stability guarantees

- No flattening: the advisor remains its own surface and does not hide orchestration commands.
- Cockpit is simple and explicit: `/pi-rogue` is the top-level status view.
