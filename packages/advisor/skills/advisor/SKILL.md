---
name: advisor
description: Zero-config strategic advisor for Pi. Auto-detects best model, phase-aware routing, preflight + post-review + cache. Use for architecture, tradeoffs, planning.
---

# Pi-Rogue Advisor

Use this skill for non-trivial decisions before/after significant edits.

## Quick start

- `/pi-rogue` — open cockpit and command pointers
- `/advisor status` — show current advisor settings and model route
- `/advisor <question>` — ask immediate advice
- Check-ins are lifecycle-managed by orchestration, not by the advisor command surface

## Command surface

| Command | What it does |
|---|---|
| `/advisor` | Show status + config summary |
| `/advisor status` | Same as `/advisor` |
| `/advisor on` | Enable auto mode |
| `/advisor off` | Disable advisor |
| `/advisor mode auto\|manual\|off` | Control when advisor auto-runs |
| `/advisor review light\|strict\|off` | Set review threshold |
| `/advisor config` | Dump full config |
| `/advisor pause <N>` | Pause advisor auto-runs for the next N turns |
| `/advisor unpause` | Resume advisor auto-runs immediately |
| `/advisor model <provider/model>` | Pin model explicitly |
| `/advisor <question>` | Run one advisory response |

## Routing and safety

- Preflight is heuristics + quick local gate first.
- Review runs after edits and/or at completion points by policy.
- No standalone check-in command: check-ins are triggered from goal/loop orchestration cadence (not from advisor internals), using higher/advanced advisor models first with regular model fallback enabled by default.

## Keep scope clear

- Successful `on_track` review verdicts are recorded silently instead of displayed as follow-up messages.
- Goal/loop-managed check-ins gate on session activity and `checkinIntervalMinutes`, avoid overlapping calls, and use higher/advanced advisor models first with regular model fallback enabled by default.
- The advisor surface is separate from orchestration (`goal`/`loop`/`autoresearch`) and intentionally stays a small command set with explicit entries above.

## Defaults

- `mode: auto`
- `review: light`
- `checkins: off` by default; orchestration owns cadence and enables them when a goal or loop is active
- `checkinIntervalMinutes: 30`
- `model: auto`
