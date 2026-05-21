---
name: guardrails
description: Shell command risk checks for Pi; use when you want to scan or tune approvals for risky commands anywhere in the full command string.
---

# Guardrails

This skill is for command-risk policy, especially Bash approval heuristics.

## Usage

- `/guardrails` — show current policy
- `/guardrails mode ask|block|allow` — set approval behavior
- `/guardrails llm on|off` — toggle the LLM-review scaffold
- `/guardrails add <fragment>` — add a risky fragment
- `/guardrails remove <fragment>` — remove it
