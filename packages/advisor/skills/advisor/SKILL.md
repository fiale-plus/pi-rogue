---
name: advisor
description: Zero-config strategic advisor for Pi. Auto-detects best model, phase-aware routing, preflight + post-review + cache. Use for architecture, tradeoffs, planning.
---

# Pi-Rogue Advisor

Use this skill for non-trivial decisions before/after significant edits.

## Quick start

- `/pi-rogue` — open cockpit and command pointers
- `/pi-rogue-advisor status` — show current advisor settings and model route
- `/pi-rogue-advisor <question>` — ask immediate advice
- Check-ins are lifecycle-managed by orchestration, not by the advisor command surface

## Command surface

| Command | What it does |
|---|---|
| `/pi-rogue-advisor` | Show status + route summary |
| `/pi-rogue-advisor status` | Same as `/pi-rogue-advisor` |
| `/pi-rogue-advisor settings` | Show full local config |
| `/pi-rogue-advisor config` | Alias for local `settings` |
| `/pi-rogue-advisor on` | Enable auto mode |
| `/pi-rogue-advisor off` | Disable advisor |
| `/pi-rogue-advisor mode auto\|manual\|off` | Control when advisor auto-runs |
| `/pi-rogue-advisor review light\|strict\|off` | Set review threshold |
| `/pi-rogue-advisor model <provider/model>` | Pin model explicitly |
| `/pi-rogue-advisor gate status` | Inspect the trained gate |
| `/pi-rogue-advisor profile status\|budget-board\|off` | Inspect/control the explicit profile |
| `/pi-rogue-advisor checkins` | Explain orchestration-managed check-ins |
| `/pi-rogue-advisor pause <N>` | Pause advisor auto-runs for the next N turns |
| `/pi-rogue-advisor unpause` | Resume advisor auto-runs immediately |
| `/pi-rogue-advisor board status` | Inspect Advisor Board controls |
| `/pi-rogue-advisor <question>` | Run one advisory response |

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
