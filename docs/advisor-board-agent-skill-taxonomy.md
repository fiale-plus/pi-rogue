# Advisor Board role taxonomy

**Status:** Current retained runtime contract

The Advisor Board is a small set of explicit, read-only advisory roles. It is not a worker pool, routing layer, or background process. A Board result can suggest a next step, but never executes that step or triggers another model call.

## Role types

- **Specialist:** a static expert lens over compact, sanitized Board evidence. Specialists are user-invoked, suggest-only, and bounded to read/search tools.
- **Head-of-Board:** an explicit senior synthesis call over the compact Board ledger and a decision question. It is read-only and cannot dispatch specialists.
- **Board role Markdown:** advisory prompt/data describing an expert lens. Markdown cannot grant tools or authority.
- **Skill:** a concrete workflow that the main agent may explicitly choose. A specialist may recommend a skill but must not execute it.

## Static specialist catalog

| Role | Scope |
|---|---|
| `reviewer` | Scope, correctness, regressions, tests, maintainability |
| `security` | Secrets, trust boundaries, command/file safety, authorization |
| `architecture` | Ownership, coupling, lifecycle, API/state design |
| `debugger` | Reproduction, root cause, edge cases, verification |
| `reliability-perf` | Hangs, retries, resource growth, repeated work, concurrency |

These are the shipped roles. There is no personal-role discovery, generated worker, shadow role, or automatic role assignment.

## Input and permission boundary

Board calls receive bounded ledger fields such as progress, changed files, risks, failures, evidence epochs, and prior findings. Raw transcripts are not passed by default. Runtime code—not role Markdown—enforces the allowlist (`read`, `search`, and approved context lookup where available), input limits, model selection, and call budgets.

Roles must not gain:

- write/edit tools or mutating shell access;
- git/remote mutation or settings mutation;
- direct skill execution;
- budget overrides or model-routing authority; or
- authority to dispatch another role.

Specialists default to `suggest` mode and are limited to three calls per session. Head-of-Board is explicit and bounded by token, time, and call limits. Missing evidence, disallowed tools, malformed results, oversized input, and unavailable models fail closed with visible metadata.

## Explicit invocation

```text
/pi-rogue-advisor board specialist suggest
/pi-rogue-advisor board specialist ask reviewer check the proposed change for regressions
/pi-rogue-advisor board head ask which decision best reduces the remaining release risk
```

A suggestion is not an action. The user or main agent must explicitly choose any recommended specialist, Head call, skill, command, or file change.
