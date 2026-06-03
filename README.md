# Pi-Rogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/fiale-plus/pi-rogue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/fiale-plus/pi-rogue/check.yml?branch=main&label=tests&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)

Pi-Rogue is a modular Pi extension stack for **agentic session guidance** and **goal/loop-based orchestration**.

## Components and release status

| Package | NPM Version | NPM Downloads | What it is |
|---|---|---|---|
| `@fiale-plus/pi-rogue-bundle` | [![bundle version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-bundle?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-bundle) | [![bundle downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-bundle?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-bundle) | **Single consolidated artefact** for advisor + orchestration + guardrails (recommended) |

`@fiale-plus/pi-rogue-advisor` and `@fiale-plus/pi-rogue-orchestration` are internal packages in this repo; direct releases are paused and their logic ships only inside the bundle.

`@fiale-plus/pi-rogue-guardrails` is now shipped with the bundle as a first-class command surface (`/guardrails`) while still remaining private as an internal package source.

Lab/greenhouse helper packages (`pi-rogue-brain`, `pi-rogue-repo-arch`) remain internal and are not published as standalone packages.

**Release policy:** Advisor and orchestration direct releases are on pause (packages private in source). All updates ship under the single `@fiale-plus/pi-rogue-bundle` artefact. See `docs/release.md` and `AGENTS.md` for the clean policy.


## Install

### Recommended (and only supported for new installs)

```bash
pi install npm:@fiale-plus/pi-rogue-bundle
```

This is the single consolidated artefact. It includes advisor + orchestration + guardrails logic (via bundling for a true single package).

**Note on paused packages:** Direct `pi install` of `@fiale-plus/pi-rogue-advisor` or `@fiale-plus/pi-rogue-orchestration` is no longer recommended and their independent releases are paused. Existing installs continue to work, but use the bundle for new work and updates. See `docs/release.md`.

### Local workspace / lab

```bash
# from repo root
npm install
```

This exposes all workspace packages for local development.

## Quick start

1. Install `@fiale-plus/pi-rogue-bundle` (the single consolidated artefact).
2. Start a Pi session.
3. Run `/advisor` (or `/advisor status`) first to let the quick main model establish session posture.
4. Then use:
   - `/pi-rogue` — cockpit and command pointers
   - `/advisor` — strategic guidance
   - `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab` — orchestration primitives
   - `/guardrails` — low-friction command-risk guardrails (ask-mode defaults to high-risk only)

## Published command surfaces

All command surfaces below are provided by the single `@fiale-plus/pi-rogue-bundle` artefact (advisor/orchestration/guardrails logic are included/bundled; their standalone packages have releases paused).

- `/advisor` — status, config, mode/review/model control, and questions
- `/advisor status` — show active mode/review/model state and loop-owned check-ins
- `/advisor on|off`
- `/advisor mode auto|manual|off`
- `/advisor review light|strict|off`
- `/advisor model <provider>/<model>` — optional override
- `/advisor config`
- `/advisor <question>` — get immediate advice
- `/pi-rogue` — shared cockpit view over advisor + orchestration pointers
- `/goal set|show|clear|list` — set or update the active goal (check-ins enabled via loop)
- `/loop status|off|clear|stop|<interval> <instruction>`
- `/autoresearch status|clear|<instruction>` — goal+loop-driven research flow
- `/autoresearch-lab status|clear|<instruction>`
- `/guardrails` — show/update command-risk policy (`/guardrails mode`, `/guardrails warn`, `/guardrails llm`, `/guardrails llm-model` (`auto|local|provider/model`), `/guardrails session`, `/guardrails add`, `/guardrails remove`)

(Previously documented "Advisor package" and "Orchestration package" sections now route through the bundle only.)

## Documentation

- `packages/advisor/README.md` (Advisor package)
- `packages/orchestration/README.md` (Orchestration package)
- `packages/bundle/README.md` (Bundle surface)
- `packages/advisor/skills/advisor/SKILL.md` (Pi skill surface)
- `packages/orchestration/skills/orchestration/SKILL.md` (Pi skill surface)
- `AGENTS.md` (agentic usage/playbook + repo-level agent instructions)
- `docs/skills-flow.md` (how advisor/orchestration skills fit together)
- `docs/release.md` and `.github/ISSUE_TEMPLATE/release.md` (release policy and naming)

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
  guardrails/
  brain/
  repo-arch/
  orchestration/
  bundle/
```

Legacy `.autoresearch` scratch data is archived at `~/.pi/archived-autoresearch/pi-rogue/`.
