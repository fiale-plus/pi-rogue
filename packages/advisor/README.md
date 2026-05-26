# @fiale-plus/pi-rogue-advisor

## What this package is

Strategic advisor for Pi sessions with low-overhead preflight/post-review routing, model auto-detection, session memory, and optional mid-session check-ins.

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
| `/advisor checkins on\|off\|<minutes>` | Enable/disable low-cost mid-hour check-ins |
| `/advisor config` | Show current config |
| `/advisor model <provider>/<model>` | Set explicit model override |
| `/advisor <question>` | Get one-shot advisory response |

## Notes on defaults

- `mode`: `auto`
- `review`: `light`
- `checkins`: `mid-hour`
- `checkinIntervalMinutes`: `30`
- `model`: not set (auto-detected)

Check-ins gate on session activity, are bounded, and avoid overlapping calls.

## Stability guarantees

- No flattening: the advisor remains its own surface and does not hide orchestration commands.
- Cockpit is simple and explicit: `/pi-rogue` is the top-level status view.

