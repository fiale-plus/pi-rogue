# Pi-Rogue packaging, command, and configuration UX

Issue: [#151](https://github.com/fiale-plus/pi-rogue/issues/151)

This document captures the design direction for making Pi-Rogue easier to install,
understand, configure, and validate. It is intentionally command/config focused:
users should think in terms of `/pi-rogue`, advisor, router, fusion, and
orchestration behavior rather than historical workspace/package artifacts.

## Goals

- Keep `@fiale-plus/pi-rogue` as the single public install artifact.
- Present one beginner-friendly command home: `/pi-rogue`.
- Make shipped subsystems discoverable from `/pi-rogue status`, help text, and
  completions.
- Define a predictable configuration home and override story.
- Provide a low-friction first-run path that validates the user's available
  models/providers before recommending advisor, router, and fusion defaults.
- Ensure router profiles can use fusion-backed model IDs such as
  `fusion/<recipe-id>` where appropriate.
- Make router role names honest: every first-class role should either affect
  live routing or be clearly marked as future/metadata-only.

## Non-goals for the first implementation slice

- Do not introduce independent public releases for advisor, orchestration,
  router, fusion, or other internal workspaces.
- Do not make hidden/background configuration changes without an explicit user
  command.
- Do not hardcode provider/model rankings beyond existing safe fallbacks without
  model-card or availability evidence.
- Keep the public command surface to canonical roots only:
  `/pi-rogue`, `/pi-rogue-advisor`, `/pi-rogue-router`, `/pi-rogue-fusion`,
  and `/pi-rogue-orchestration`.
  Legacy top-level aliases were intentionally removed to prevent ambiguity.

## Public artifact story

Canonical public install:

```txt
pi install npm:@fiale-plus/pi-rogue
```

Historical or internal package names should be described only when maintainers
need them. User-facing docs should avoid bundle/artifact terminology unless it is
necessary for migration from old installs.

Recommended docs language:

- Good: "Install Pi-Rogue", "configure Pi-Rogue", "Pi-Rogue includes advisor,
  router, fusion, and orchestration surfaces".
- Avoid: "install the bundle", "choose the advisor package", "install
  orchestration separately".

## Command and discoverability matrix

| Surface | Canonical command | Small tree |
| --- | --- | --- |
| Management root | `/pi-rogue` | `status`, `help`, `doctor` |
| Advisor | `/pi-rogue-advisor` | `status`, `settings`, `config`, `on`, `off`, `mode`, `review`, `model`, `gate`, `profile`, `checkins`, `pause`, `unpause`, `board` |
| Router | `/pi-rogue-router` | `status`, `help`, `on`, `off`, `mode`, `profile`, `print`, `models`, `profiles`, `cycle`, `configure` |
| Fusion | `/pi-rogue-fusion` | `status`, `reload`, `configure` |
| Orchestration | `/pi-rogue-orchestration` | `status`, `help`, `goal`, `loop`, `autoresearch`, `lab` |

`/pi-rogue` should stay a concise management root. Avoid nested subsystem paths
such as `/pi-rogue router status`. The advisor keeps one local settings display,
with `config` as its documented alias. Use `/pi-rogue status` for a safe read-only aggregate view. Umbrella enable/disable controls are intentionally not advertised until they manage every subsystem consistently.

## Configuration home and precedence

Recommended canonical user-global root:

```txt
~/.pi/agent/pi-rogue/
```

Recommended tree:

```txt
~/.pi/agent/pi-rogue/
  config.json                    # global Pi-Rogue setup summary/preferences
  advisor/config.json            # advisor mode, review, check-ins, model override
  advisor/history.jsonl          # advisor history/cache metadata
  router/config.json             # active profile, mode, print behavior
  router/model-cards.jsonl       # manually seeded or learned capability cards
  router/events.jsonl            # route observations/ledger
  fusion/recipes.json            # stable fusion recipes exposed as fusion/<id>
  fusion/runs/                   # traces/results
  orchestration/                 # goal/loop/autoresearch state
  context-broker/                # broker state/config/sqlite store, enabled by default
```

Storage should be explicit and shown in status/doctor output:

1. built-in defaults,
2. user-root Pi-Rogue config under `~/.pi/agent/pi-rogue/`,
3. session runtime state under the same user root.

Default config, traces, ledgers, and context-broker artifacts should not be
written under the current repository. Environment variables may still point to
custom paths for advanced/manual setups, but the default UX is user-root only.

## First-run status flow

Target commands:

```txt
/pi-rogue status
```

The first-run flow is intentionally low-key and short:

1. `/pi-rogue status` shows the detected aggregate setup and writes nothing.
2. Subsystem roots expose their own explicit enable/configure controls.
3. The planner lists available text models/providers from Pi's model registry.
4. It derives an advisor default from the smartest available single model.
5. It chooses a fast worker model when available.
6. It detects user-root fusion recipes and selects `fusion/<recipe-id>` for
   smart/teacher/reviewer roles when available.
7. It previews concise advisor/router/fusion/context setup details.
8. Router starts in safe `observe` mode; users opt into `/pi-rogue-router mode auto_model`
   separately when they want automatic model switching.

When subsystem setup writes defaults, they use user-root paths:

```txt
~/.pi/agent/pi-rogue/config.json
~/.pi/agent/pi-rogue/advisor/config.json
~/.pi/agent/pi-rogue/router/config.json
~/.pi/agent/pi-rogue/router/model-cards.jsonl
~/.pi/agent/pi-rogue/context-broker/artifacts.sqlite
```

`/pi-rogue status` remains the safe read-only entry point.

## Orchestrated advisor/router/fusion defaults

Advisor, router, and fusion should be configured together rather than as
unrelated knobs.

Implemented profile families are generated from available models and recipe evidence. Additional profile families remain candidates for future refinement:

| Profile | Intent | Example assignment strategy |
| --- | --- | --- |
| `quick` | minimize latency while staying capable | generated by router setup |
| `budget` | minimize cost while preserving quality | future: needs cost/capability cards |
| `balanced` | default general use | generated by router setup |
| `fusion-smart` | use fusion for higher-confidence decisions | generated today when a fusion recipe is detected |

Each generated profile should continue to state or imply:

- recommended default,
- acceptable fallback,
- areas requiring validation/research,
- user-preference overrides such as local-only, OSS-only, budget, or frontier.

Fusion defaults should prefer a high-quality judge when available, but should not
force frontier models when a user selects local/OSS-only or budget constraints.

## Fusion as a router target

Fusion recipes should register stable Pi model IDs:

```txt
fusion/<recipe-id>
```

Router config should accept those IDs anywhere a profile accepts a model target.
Status output should make fusion use visible, for example:

```txt
profile: fusion-smart
worker: openai-codex/gpt-5.3-codex-spark
smart: fusion/gpt55fused-53spark
teacher: fusion/gpt55fused-53spark
reviewer: fusion/gpt55fused-53spark
```

`/pi-rogue status` and `subsystem setup` should validate both direct model
availability and fusion recipe availability before selecting a fusion-backed
profile.

## Router role taxonomy

Current live router behavior classifies turns into route actions and then maps
those actions to a small role set. That is safe, but richer profile fields can be
misleading if they are never selected by live routing.

First-class live roles should be documented and tested. Proposed taxonomy:

| Role | Intended live use |
| --- | --- |
| `worker` | quick/local continuation, routine action, cheap path |
| `smart` | normal smart hint/planning/escalation path |
| `reviewer` | diff/code review path |
| `teacher` | teacher-label or policy-generation path, when implemented |
| `debug_diagnose` | repeated-error diagnosis path, if promoted to first-class |
| `verify` | verification/test-only path, if promoted to first-class |
| `explore` | exploratory/research path, if promoted to first-class |

Implementation requirement: `/pi-rogue-router status`, `/pi-rogue-router models`, `/pi-rogue
status`, and completion/help text should either show only live-used roles or
clearly mark future/metadata-only roles. Validation should warn when a profile
defines roles that the live action mapper will not use.

## Model cards and sharpening

Capability/model cards should support setup and later sharpening without silently
overriding the user:

- capture latency, context, cost, reasoning/tool quality, provider, and role
  hints where known,
- track observed outcomes separately from manual seed assumptions,
- use cards to recommend profiles during router setup,
- keep automatic promotions opt-in/manual until there is enough local evidence.

## Migration plan

1. Router config now reads and writes the user-root Pi-Rogue config by default.
2. `/pi-rogue-router status` shows the active user-root config source.
3. `/pi-rogue doctor` checks canonical npm/local package registrations and key
   config/recipe paths without modifying files.
4. Future migration commands should remain dry-run-first before moving files.
5. Preserve direct subsystem commands and config formats during migration.

## Acceptance checklist

- `/pi-rogue` help/status mentions advisor, router, fusion, orchestration, and
  first-run configuration.
- Autocomplete includes every shipped canonical subsystem root.
- Router/fusion status make `fusion/<recipe-id>` targets visible.
- Config docs identify user-root config and session-local state under the user root.
- First-run status/on flow has a read-only path and explicit enable path.
- Router docs distinguish live-used roles from metadata/future roles.
- No remote package or command naming changes are made without explicit approval.
