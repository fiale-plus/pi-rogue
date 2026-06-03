---
name: guardrails
description: Shell command risk checks for Pi; use when you want to scan or tune approvals for risky commands anywhere in the full command string.
---

# Guardrails

This skill is for command-risk policy, especially Bash approval heuristics.

## Usage

- `/guardrails` — show current policy
- `/guardrails mode off|ask|block|allow` — set approval behavior (`off` disables checks)
- `/guardrails llm on|off` — toggle the LLM-review scaffold
- `/guardrails llm-model auto|local|provider/model` — set the model used by LLM review (`local` uses the local binary gate)
- `/guardrails warn on|off` — enable/disable prompts for warn-level findings (`off` default)
- `/guardrails session on|off|clear|status` — temporary session-wide bypass for all flagged commands (`on` disables prompts until `off`)
- `/guardrails add <fragment>` — add a risky fragment
- `/guardrails remove <fragment>` — remove it
- `/guardrails` status includes active restore-ledger windows for reversible destructive commands (auto snapshot then short retention)
