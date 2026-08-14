# Minimal Pi-Rogue Design

## Goal
Reduce the public Pi-Rogue package to explicit, read-only advisory work: no hidden model calls, no background orchestration, no context database, and no automatic model routing.

## Approved scope

Delete these packages and all of their source, tests, manifests, scripts, exports, lockfile entries, and documentation references:

- `packages/fusion`
- `packages/context-broker`
- `packages/orchestration`
- `packages/router`

Remove their bundle registration and dependencies. The public artifact remains `@fiale-plus/pi-rogue`, but ships only core and advisor functionality.

## Runtime architecture

The bundle registers only `registerAdvisor`. Core remains a shared internal dependency. Advisor has no `before_agent_start`, `turn_end`, or `agent_end` model work. Normal Pi work therefore incurs zero Pi-Rogue model calls.

Advisor exposes explicit one-shot advice through `/pi-rogue-advisor <question>` and the `advisor` tool. An explicit call may resolve a configured model or a bounded preferred fallback, use a sanitized compact session brief when requested, cache identical answers, and report provider/rate-limit failures. It never changes the active Pi model, injects system-prompt text, edits files, dispatches workers, or triggers another call automatically.

## Board architecture

Retain the read-only Board, specialists, and Head-of-Board inside Advisor. Calls are explicit only. Inputs are compact, bounded, sanitized ledger data; raw transcripts and mutating tools are prohibited. Outputs are advisory notifications, never execution authority.

Retain static specialist roles with clear analysis contracts:

- reviewer: scope, correctness, regressions, tests, maintainability;
- security: secrets, trust boundaries, command/file safety, authorization;
- architecture: ownership, coupling, lifecycle, API/state design;
- debugger: reproduction, root cause, edge cases, verification;
- reliability-perf: hangs, retries, resource growth, repeated work, concurrency.

Specialists default to suggest-only, cheap-tier, read/search-only, bounded to three calls per session. Head-of-Board is explicit, uses a stronger configured model when available, receives only the compact Board ledger, and is bounded by token/time/call limits. Board suggestions may recommend a specialist or Head call but MUST NOT trigger either automatically.

Remove Board shadow/probation telemetry, flight ledgers, automatic shadow decisions, and personal specialist discovery/background workers. Keep only the compact in-session evidence needed to make an explicit Board call useful.

## Models and configuration

Replace mode/review/checkin/profile/router/fusion/context/orchestration configuration with one small Advisor configuration. The user-visible model map is:

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

`null` means bounded automatic selection from available compatible text models. Explicit values override discovery. Setup/doctor MAY report recommendations and selected models, but MUST NOT mutate Pi's global active model. There is no profile cycling or role-to-model Router map.

Recommended selection: advisor/head choose the strongest compatible configured candidate; specialists choose the cheapest compatible candidate. Resolution MUST stop after the explicit model plus one bounded preferred fallback, rather than trying every available provider.

## Binary gate

Retain only the small local binary advisory classifier if it can be used as post-processing after an explicit Advisor, specialist, or Head result. It MUST NOT run during preflight, turn-end, or agent-end hooks; inject prompt text; suppress explicit calls; or invoke another model. Its only permitted result is a visible local suggestion such as “consider Head-of-Board.”

Remove production route logs, trajectory/router dependencies, automatic gate control, and training/runtime plumbing that exists only for automatic routing. Keep a model artifact or focused tests only if they directly support this explicit post-processing contract; otherwise delete them with the obsolete gate path.

## Commands and surfaces

Keep:

- `/pi-rogue status|help|doctor`;
- `/pi-rogue-advisor status|settings|model|board ...`;
- `/pi-rogue-advisor <question>`;
- explicit `advisor` tool;
- explicit read-only specialist and Head calls.

Remove:

- `cfg posture guarded` and the legacy configure planner;
- Router, Fusion, Context, Orchestration, goal, loop, autoresearch, and context lookup commands;
- automatic review/check-in controls;
- subsystem path maps for deleted packages.

Status/doctor MUST describe only the retained Advisor/Board installation and configured models. Unknown obsolete settings should be ignored or migrated without recreating deleted subsystems.

## Safety and failure behavior

A missing or unavailable configured model fails clearly. A bounded fallback may be attempted once and is visible in result metadata. Provider failures, rate limits, malformed advisory output, and gate uncertainty never alter the user's task or execute tools. Board calls fail closed on disallowed roles/tools, excessive input, missing ledger, or unavailable models.

## Acceptance criteria

1. Public bundle contains only core and advisor dependencies and registers no deleted subsystem.
2. No automatic model call occurs on session start, before-agent-start, turn end, or agent end.
3. Explicit Advisor, specialist, and Head calls remain functional and bounded.
4. Board roles are static, read-only, sanitized, and suggest-only.
5. Configuration has no Router/Fusion/Context/Orchestration/profile/check-in fields.
6. Deleted packages have no source/tests/manifests remaining and no repository references except intentional historical release notes.
7. Focused tests cover bundle registration, explicit calls, configuration normalization, bounded model resolution, Board safety, and optional gate post-processing.
8. Smoke verification proves normal bundle registration produces no background handlers that call models and explicit advisory commands still produce bounded results.
