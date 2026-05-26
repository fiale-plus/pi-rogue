# PiRogue repository agent instructions

Use this file as the concise operating guidance for agent usage in this repo.

## Core behavior for agents

- Keep scope narrow. Do not expand command surfaces unless requested.
- Keep command names and behavior unchanged unless explicitly approved.
- Prefer explicit `/` command surfaces and avoid implicit/background-only behavior.
- Start with `/advisor` (or `/advisor status`) at session start to establish quick posture before orchestration actions.

## Safety / process

- **Do not merge PRs without explicit user consent.**
- Merge branches/PRs only after summary validation and user approval.

## Maintenance policy references

This AGENTS file intentionally stays agentic (not maintainer process).
- For release rules, naming, and checklists, see:
  - `docs/release.md`
  - `.github/ISSUE_TEMPLATE/release.md`
  - `.github/workflows/*.yml`
