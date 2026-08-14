# @fiale-plus/pi-rogue-advisor

> **Internal bundled package.** Direct releases are paused. Users install `@fiale-plus/pi-rogue`, which bundles this extension and its skills.

## What this package is

The Advisor provides explicit, bounded engineering advice for Pi sessions. It does not inspect or modify every turn: normal session lifecycle events make no model calls. The explicit `advisor` tool and `/pi-rogue-advisor <question>` command return suggestions without changing Pi's active model, editing files, running commands, dispatching workers, or rewriting prompts.

The Advisor Board adds five static, read-only specialist lenses and an explicit Head-of-Board synthesis path:

| Role | Advisory focus |
|---|---|
| `reviewer` | Scope, correctness, regressions, tests, and maintainability |
| `security` | Secrets, trust boundaries, command/file safety, and authorization |
| `architecture` | Ownership, coupling, lifecycle, and API/state design |
| `debugger` | Reproduction, root cause, edge cases, and verification |
| `reliability-perf` | Hangs, retries, resource growth, repeated work, and concurrency |

Specialists receive compact sanitized Board evidence and may use only read/search tools. Their output is a suggestion, not execution authority. Head-of-Board receives the compact ledger and a decision question; it is read-only, bounded, and cannot dispatch another role.

## Install

**For users:**

```bash
pi install npm:@fiale-plus/pi-rogue
```

**For local development (monorepo only):**

```bash
npm install --workspace packages/advisor
```

The leaf package is private and is not an independent user install target.

## Commands

| Command | What it does |
|---|---|
| `/pi-rogue` | Show the retained Pi-Rogue cockpit (`status`, `help`, or `doctor`) |
| `/pi-rogue-advisor` | Show explicit Advisor/Board status |
| `/pi-rogue-advisor status` | Show selected model slots, Board bounds, and explicit-call counters |
| `/pi-rogue-advisor settings` | Show the same local configuration without starting an advisory call |
| `/pi-rogue-advisor model [advisor\|specialist\|head] <provider>/<model>\|null` | Set or clear one model-map slot |
| `/pi-rogue-advisor board specialist status` | Show specialist mode, limits, and call counts |
| `/pi-rogue-advisor board specialist suggest` | Return a local suggestion about which static role may help; does not call a model |
| `/pi-rogue-advisor board specialist ask <role-id> <task>` | Make one explicit bounded specialist call |
| `/pi-rogue-advisor board head status` | Show Head-of-Board bounds and call count |
| `/pi-rogue-advisor board head ask <decision question>` | Make one explicit bounded Head-of-Board call |
| `/pi-rogue-advisor <question>` | Make one explicit Advisor call |

The `advisor` tool is the equivalent explicit one-shot API. No command or tool silently invokes another command, role, retry, or model call.

## Model map and limits

The user-visible configuration is intentionally small:

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

`null` uses bounded role-appropriate selection from compatible text models. Explicit values use `<provider>/<model>` and take precedence. Advisor and Head prefer the strongest compatible candidate; specialists prefer the cheapest compatible candidate. Resolution attempts the configured candidate and at most one preferred fallback. It never loops through every provider and never mutates Pi's global active model.

Specialists default to `suggest` mode and are limited to three calls per session. Board inputs are compact, bounded, sanitized ledger data rather than raw transcripts. Disallowed roles/tools, missing evidence, oversized input, unavailable models, rate limits, and malformed responses fail closed with visible metadata. Suggestions cannot suppress the user's task, edit files, execute commands, or trigger a specialist or Head call.

## Explicit-only guarantee

There is no automatic preflight, review, check-in, route decision, model switch, prompt rewrite, context database, orchestration loop, Fusion/panel call, background worker, or lifecycle model work. Pi-Rogue makes zero model calls during ordinary session startup, turn-end, and agent-end handling. Only an explicit Advisor, specialist, or Head invocation can perform bounded model work.
