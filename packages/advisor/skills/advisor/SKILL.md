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
- `/advisor checkins on|off|<minutes>` — control low-power check-ins

## Command surface

| Command | What it does |
|---|---|
| `/advisor` | Show status + config summary |
| `/advisor status` | Same as `/advisor` |
| `/advisor on` | Enable auto mode |
| `/advisor off` | Disable advisor |
| `/advisor mode auto\|manual\|off` | Control when advisor auto-runs |
| `/advisor review light\|strict\|off` | Set review threshold |
| `/advisor checkins on\|off\|<minutes>` | Configure interval check-ins |
| `/advisor config` | Dump full config |
| `/advisor model <provider/model>` | Pin model explicitly |
| `/advisor <question>` | Run one advisory response |

## Routing and safety

- Preflight is heuristics + quick local gate first.
- Review runs after edits and/or at completion points by policy.
- No hidden long-running background daemon: check-ins are interval-gated and lightweight.

## Keep scope clear

The advisor surface is separate from orchestration (`goal`/`loop`/`autoresearch`) and intentionally stays a small command set with explicit entries above.

## Defaults

- `mode: auto`
- `review: light`
- `checkins: mid-hour`
- `checkinIntervalMinutes: 30`
- `model: auto`
