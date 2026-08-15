---
name: advisor
description: Explicit, bounded strategic advice and read-only Board review for Pi. Use when a second opinion, specialist lens, or Head-of-Board synthesis is explicitly requested.
---

# Pi-Rogue Advisor

Pi-Rogue provides explicit advisory calls. Normal Pi lifecycle events do not invoke models, rewrite prompts, switch models, dispatch workers, or run background loops.

## Quick start

- `/pi-rogue` — show retained status, help, or doctor commands
- `/pi-rogue-advisor status` — show Advisor and Board status
- `/pi-rogue-advisor <question>` — ask one bounded Advisor question
- `/pi-rogue-advisor board specialist suggest` — get a local role suggestion
- `/pi-rogue-advisor board specialist ask <role-id> <task>` — make one explicit specialist call
- `/pi-rogue-advisor board head ask <decision question>` — make one explicit Head-of-Board call

## Command surface

| Command | What it does |
|---|---|
| `/pi-rogue-advisor` or `status` | Show explicit Advisor/Board status |
| `/pi-rogue-advisor settings` | Show local model and Board configuration |
| `/pi-rogue-advisor model [advisor\|specialist\|head] <provider>/<model>\|null` | Set or clear a model-map slot |
| `/pi-rogue-advisor board specialist status` | Show specialist limits and call counts |
| `/pi-rogue-advisor board specialist suggest` | Suggest a static role without calling a model |
| `/pi-rogue-advisor board specialist ask <role-id> <task>` | Call one read-only specialist |
| `/pi-rogue-advisor board head status` | Show Head-of-Board limits and call count |
| `/pi-rogue-advisor board head ask <question>` | Call the read-only Head-of-Board |
| `/pi-rogue-advisor <question>` | Call the explicit Advisor |

The `advisor` tool is the equivalent one-shot API. Each call is bounded and visible. No command silently invokes another role, retries a failed call, or changes Pi's active model.

## Board roles and safety

The static roles are `reviewer`, `security`, `architecture`, `debugger`, and `reliability-perf`. Specialists receive compact, sanitized evidence and read/search-only tool contracts. Head-of-Board receives only the compact Board ledger. All results are suggestions; they cannot edit files, execute commands, dispatch workers, or trigger another model call.

Unavailable models, rate limits, malformed responses, oversized input, missing evidence, disallowed roles, and disallowed tools fail closed with visible metadata.

## Model map and limits

```json
{
  "models": {
    "advisor": null,
    "specialist": null,
    "head": null
  },
  "board": {
    "specialists": "suggest",
    "maxSpecialistCalls": 3,
    "specialistMaxTokens": 900,
    "headMaxTokens": 1200
  }
}
```

`null` selects one compatible role-appropriate model. Explicit `<provider>/<model>` values take precedence. Resolution attempts the configured model and at most one preferred fallback; it never enumerates an unbounded provider list.
