---
name: advisor
description: Zero-config strategic advisor for Pi. Auto-detects best model, phase-aware routing, preflight + post-review + cache. Use for architecture, tradeoffs, planning.
---

# PiRogue Advisor

Works out of the box. Just install and use `/advisor`.

> 96 strategic calls saved ~$53 on GPT-5.5 over 3,071 turns — see [`docs/savings.md`](../../docs/savings.md)

## Quick start

- `/advisor` — status + config
- `/advisor <question>` — get immediate advice
- `/advisor on|off` — enable/disable

Zero config needed. Falls back through SOTA models (gpt-5.5 → claude-opus-4-6 → sonnet-4-6) automatically.

The router is phase-aware: it keeps tiny edits cheap, escalates complex/high-risk work to SOTA, and writes compact routing logs for future classifier training.

## When to call

Agent should call `advisor` tool before: new frameworks, refactoring, API design, concurrency, security, tradeoffs.
Skip: reads, small edits, one-liners.

## Commands

| Command | What it does |
|---------|-------------|
| `/advisor` | Show status, config, cached note |
| `/advisor <question>` | Get immediate strategic advice |
| `/advisor on` | Enable auto mode (preflight+post+cache) |
| `/advisor off` | Disable |
| `/advisor mode auto\|manual\|off` | Set advisor mode |
| `/advisor model <provider/model>` | Set specific model (e.g. `openai-codex/gpt-5.5`) |
| `/advisor status` | Full status with model info |
| `/advisor config` | Show current 3-field config |
| `/advisor review light\|strict\|off` | Set review aggressiveness |

## Config (3 fields, all optional)

Defaults: `mode: auto, review: light`

```json
{ "mode": "auto", "review": "light" }
```
