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
| `/pi-rogue` | Show the retained Pi-Rogue cockpit (`status`, `help`, `doctor`, or `closeout`) |
| `/pi-rogue-advisor` | Show explicit Advisor/Board status |
| `/pi-rogue-advisor status` | Show selected model slots, Board bounds, and explicit-call counters |
| `/pi-rogue-advisor settings` | Show the same local configuration without starting an advisory call |
| `/pi-rogue-advisor model list [advisor\|specialist\|head]` | Inspect available models and role recommendations without an LLM call |
| `/pi-rogue-advisor model [advisor\|specialist\|head] <provider>/<model>\|null` | Set or clear one model-map slot |
| `/pi-rogue-advisor board watch status` | Show deterministic watcher mode, risk runs, interventions, and suppression counts |
| `/pi-rogue-advisor board watch off\|shadow\|intervene` | Disable, record-only, or queue non-binding next-turn Board suggestions |
| `/pi-rogue-advisor board watch head status\|on\|off` | Inspect or enable bounded automatic Head escalation |
| `/pi-rogue-advisor board specialist status` | Show specialist mode, limits, and call counts |
| `/pi-rogue-advisor board specialist suggest` | Return a local suggestion about which static role may help; does not call a model |
| `/pi-rogue-advisor board specialist ask <role-id> <task>` | Make one explicit bounded specialist call |
| `/pi-rogue-advisor board head status` | Show Head-of-Board bounds and call count |
| `/pi-rogue-advisor board head ask <decision question>` | Make one explicit bounded Head-of-Board call |
| `/pi-rogue-advisor <question>` | Make one explicit Advisor call |
| `/pi-rogue closeout start|add-evidence|record|show|export` | Record and inspect bounded local session evidence; never infers success |

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

`null` uses bounded role-appropriate selection from compatible text models. Use `model list` to see authenticated text models, the selected/recommended candidate for each role, and facts such as reasoning support, context window, token limit, and declared input/output cost. The role policy is intentionally explainable rather than a universal quality claim: Advisor balances quality, specialists prefer efficiency, and Head prefers reasoning/context. Explicit values use `<provider>/<model>` and take precedence; unavailable or unauthenticated overrides are retained but shown with a warning. Resolution attempts the configured candidate and at most one preferred fallback. Inspection never calls a model, changes Pi's global active model, or persists config.

The active **main Pi model is separate from all three Pi-Rogue role slots**. Pi-Rogue reports it but never changes it. For a cheap/fast starting point, use a currently authenticated registry entry such as `pi --model openrouter/deepseek/deepseek-v4-flash`; verify current IDs and pricing with Pi's model list and the provider's pricing page. Luna/Kimi high-end variants should be treated as quality-oriented escalation choices, not assumed to be cheaper.

Specialists default to `suggest` mode and are limited to three calls per session. Board inputs are compact, bounded, sanitized ledger data rather than raw transcripts. Disallowed roles/tools, missing evidence, oversized input, unavailable models, rate limits, and malformed responses fail closed with visible metadata. Suggestions cannot suppress the user's task, edit files, execute commands, or trigger a specialist or Head call.

## Session closeout

Closeout is an explicit local evidence ledger for carrying useful facts between work sessions. Start it with `/pi-rogue closeout start [summary]`, add handles or notes with `add-evidence`, record a user-selected `success`, `partial`, `failed`, or `abandoned` outcome, then inspect or export it. Lifecycle hooks only snapshot bounded changed-file, validation, failure, and call-count facts after a closeout exists; they do not make model calls or infer completion.

The offline evaluation harness consumes these closeout records without loading raw transcripts:

```bash
npm run evaluate:advisor -- --input ./evaluation.json \
  --json-output /tmp/advisor-evaluation.json \
  --markdown-output /tmp/advisor-evaluation.md
```

Each fixture compares a no-Advisor baseline with an explicit Advisor/Board observation by task class. The report is descriptive and fail-closed for safety-sensitive slices; it does not promote models or policies automatically.

## Explicit-only guarantee

The deterministic Board watcher may run during ordinary lifecycle events in `shadow` mode without model work. `intervene` mode queues a visible, non-binding `nextTurn` Board suggestion with no automatic turn, model switch, prompt rewrite, or mutation. Head escalation is off by default and, when explicitly enabled, is bounded, deduplicated, read-only, and fail-closed. The regular Advisor and specialist calls remain on-demand. Pi-Rogue makes zero model calls during ordinary startup, turn-end, and agent-end handling unless the user explicitly enabled Board-to-Head escalation.
