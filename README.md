# Pi-Rogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml) [![Tests](https://img.shields.io/github/actions/workflow/status/fiale-plus/pi-rogue/check.yml?branch=main&label=tests&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml) [![version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue) [![downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue) [![License](https://img.shields.io/github/license/fiale-plus/pi-rogue?style=flat-square)](LICENSE)

Pi-Rogue is the single-install Pi extension bundle for command-first session control: advisor reviews, routing telemetry, context brokerage, Fusion model panels, and explicit goal/loop orchestration.

## Install

```bash
pi install npm:@fiale-plus/pi-rogue
```

This is the single consolidated artefact. It includes advisor, orchestration, router, context broker, and Fusion logic (bundled through package dependencies for one-install behavior).

### Local workspace / lab

```bash
# from repo root
npm install
```

This exposes all workspace packages for local development.

## Quick start

1. Install `@fiale-plus/pi-rogue` (the single consolidated artefact).
2. Start a Pi session.
3. Run `/pi-rogue` first for the concise management cockpit.
4. Then use canonical subsystem roots:
   - `/pi-rogue-advisor` — strategic guidance
   - `/pi-rogue-router` — route telemetry/model-routing controls
   - `/pi-rogue-fusion` — comparable-panel Fusion provider controls
   - `/pi-rogue-orchestration` — goal, loop, and autoresearch primitives

## Published command surfaces

All command surfaces below are provided by the single `@fiale-plus/pi-rogue` artefact.

- `/pi-rogue status|help|doctor` — concise Pi-Rogue management root and checks/health entrypoint
- `/pi-rogue-advisor status||mode|model|review|pause|unpause|checkins` — advisor state/control
- `/pi-rogue-advisor <question>` — get immediate strategic advice
- `/pi-rogue-orchestration goal set|show|clear|list` — set or update the active goal
- `/pi-rogue-orchestration loop status|off|clear|stop|<interval> <instruction>`
- `/pi-rogue-orchestration autoresearch status|clear|<instruction>` — goal+loop-driven solo research flow
- `/pi-rogue-orchestration lab status|clear|<instruction>` — goal+loop-driven parallel research flow
- `/pi-rogue-router status|help||mode|profile|models|profiles|configure|cycle` — local route telemetry controls
- `/pi-rogue-router` mode `observe` (default) keeps routing as recommendations only and does not auto-switch policy
- `/pi-rogue-router` mode `auto_model` explicitly applies only model routing; this still requires clear user-level intent and explicit opt-in
- `/pi-rogue-fusion status|reload|configure` — OpenRouter-style comparable-panel Fusion provider controls (models register when recipes exist)
- `/pi-rogue-context status|brief|lookup <handle|text>|pin <handle-or-id>|export <handle-or-id>|config threshold <bytes>|prune` — context broker controls (threshold minimum 2 KiB). Legacy `/context` alias is not supported.

### Fusion

Fusion recipes register `fusion/<recipe-id>` as normal models when recipes exist. The v1 recipe shape is OpenRouter-style and roleless: `analysis_models` are comparable independent analysis-only attempts, then a judge produces structured analysis, then the synthesis model writes the final answer. Role-based critic/researcher/verifier passes are intentionally not part of the Fusion schema.

A future agentic panel can use pi-agents/subagents plus pi-intercom under a separate `agent_fusion` family (`analysis_agents`), preserving the same judge-and-synthesis language without overloading model refs.

See `packages/fusion/README.md`.

### Lab packages

- `packages/lab/guardrails/` — Shell command risk checks and approvals for Pi.
- `packages/lab/brain/` — Local project memory helpers.
- `packages/lab/repo-arch/` — Repo integration bridge for repo-arch CLI.

These are experimental/internal lab surfaces and grouped under `packages/lab/`.

## Documentation

### For users

- [Canonical package README](packages/bundle/README.md) — install scope and command surface.
- [Repository guidance](AGENTS.md) — repository rules, maintenance policy, and release posture.
- [Release guide](docs/release.md) — canonical release process and naming policy.
- [Release issue template](.github/ISSUE_TEMPLATE/release.md) — standard release checklist template.

### Subsystem references

- [Advisor README](packages/advisor/README.md) and [advisor skill](packages/advisor/skills/advisor/SKILL.md) — strategic guidance commands and skill surface.
- [Orchestration README](packages/orchestration/README.md) and [orchestration skill](packages/orchestration/skills/orchestration/SKILL.md) — goals, loop, autoresearch, and lab behavior.
- [Router README](packages/router/README.md), [binary gate runbook](docs/routing-binary-gate.md), [routing dataset workflow](docs/routing-dataset.md), and [routing labels](docs/routing-labels.md) — routing telemetry and training workflow.
- [Context broker README](packages/context-broker/README.md) and [context footprint broker proposal](docs/context-footprint-broker.md) — bounded artifact storage and lookup design.
- [Fusion README](packages/fusion/README.md) and [skills-to-flow map](docs/skills-flow.md) — model-composition behavior and orchestration mapping.

### Lab and extension docs

- [Guardrails package README](packages/lab/guardrails/README.md)
- [Brain package README](packages/lab/brain/README.md)
- [Repo-arch package README](packages/lab/repo-arch/README.md)

### Evidence and operational notes

- [Config UX design](docs/pi-rogue-config-ux.md) — command/config discoverability rationale.
- [Session savings](docs/savings.md) — runtime savings snapshot.
- [Binary-gate benchmark evidence (2026-05-30)](docs/advisor-binary-gate-benchmark-evidence-2026-05-30.md) — benchmark/verification trail.

## Development

```bash
npm install
npm run check
npm test
```

## Repo layout

```txt
packages/
  advisor/
  core/
  context-broker/
  lab/
    guardrails/
    brain/
    repo-arch/
  orchestration/
  router/
  fusion/
  bundle/
```

Legacy `.autoresearch` scratch data is archived at `~/.pi/archived-autoresearch/pi-rogue/`.
