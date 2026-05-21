---
name: advisor
description: Multi-model strategic advisor with SOTA model suggestion for Pi. Use when you need architectural guidance, tradeoff evaluation, or next-step planning. Automatically suggests gpt-5.5, claude-opus-4-6, or best available model.
---

# Advisor

This skill manages the multi-model advisor system. It provides:
- `advisor` tool — callable by the agent for strategic questions
- `/advisor` command — interactive configuration and notes
- Preflight injection — prompts the agent to call advisor at decision points
- Cache — deduplicates identical advisory requests
- SOTA fallback — tries configured model, then best available

## When to call advisor

Before: new frameworks, refactoring approach, API design, concurrency models, security decisions, tradeoff evaluation.
Skip: file reads, small edits, config tweaks, one-liners.

Format: ask 1 concise question. Incorporate the answer.

## Commands

- `/advisor` — show current note and config
- `/advisor set <text>` — set a coaching note (injected as context)
- `/advisor model` — show SOTA model suggestions
- `/advisor model <provider/model>` — set advisor model (e.g. `openai-codex/gpt-5.5`)
- `/advisor mode tool|prompt|disabled` — set advisor mode
- `/advisor status` — full status with SOTA suggestions
- `/advisor clear` — clear note
- `/advisor list` — recent note history
- `/advisor digest` — show session brief

## SOTA models supported

| Provider/Model | Label |
|---|---|
| `openai-codex/gpt-5.5` | GPT-5.5 Codex |
| `anthropic/claude-opus-4-6` | Claude Opus 4.6 |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `openrouter/openrouter/auto` | OpenRouter Auto |

The advisor automatically falls back through available models if the configured one is unreachable.
