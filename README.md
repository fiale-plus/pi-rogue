# PiRogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/fiale-plus/pi-rogue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/fiale-plus/pi-rogue/check.yml?branch=main&label=tests&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)

PiRogue is a modular Pi extension stack for **agentic session guidance** and **goal/loop-based orchestration**.

## Components and release status

Published surface:

| Surface | Package | NPM Version | NPM Downloads | What it is |
|---|---|---|---|---|
| Advisor | `@fiale-plus/pi-rogue-advisor` | [![advisor version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-advisor?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor) | [![advisor downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-advisor?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor) | Strategic advisor + phase-aware routing + optional check-ins |
| Orchestrator | `@fiale-plus/pi-rogue-orchestration` | [![orchestration version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-orchestration?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | [![orchestration downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-orchestration?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | Loop, goal, and autoresearch controls |
| Bundle | `@fiale-plus/pi-rogue-bundle` | [![bundle version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-bundle?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-bundle) | [![bundle downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-bundle?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-bundle) | Umbrella package for advisor + orchestration |

Lab / greenhouse (unreleased internal helper packages):

| Surface | Package | Status | Notes |
|---|---|---|---|
| Guardrails | `@fiale-plus/pi-rogue-guardrails` | not published | internal helper |
| Brain | `@fiale-plus/pi-rogue-brain` | not published | internal helper |
| Repo-arch | `@fiale-plus/pi-rogue-repo-arch` | not published | internal helper |

## Install

### Published packages (recommended)

```bash
# umbrella
pi install npm:@fiale-plus/pi-rogue-bundle

# individual surfaces
pi install npm:@fiale-plus/pi-rogue-advisor
pi install npm:@fiale-plus/pi-rogue-orchestration
```

### Local workspace / lab

```bash
# from repo root
npm install
```

This exposes all workspace packages (`advisor`, `orchestration`, `bundle`, and internal lab packages) for local development.

## Quick start

1. Install either the umbrella or individual packages.
2. Start a Pi session.
3. Use:
   - `/pi-rogue` — cockpit and command pointers
   - `/advisor` — strategic guidance
   - `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab` — orchestration primitives

## Published command surfaces

### Advisor package

- `/advisor` — status, config, mode/review/check-in/model control, and questions
- `/advisor status` — show active mode/review/check-ins/model state
- `/advisor on|off`
- `/advisor mode auto|manual|off`
- `/advisor review light|strict|off`
- `/advisor checkins on|off|<minutes>` — opportunistic check-ins during long sessions
- `/advisor model <provider>/<model>` — optional override
- `/advisor config`
- `/advisor <question>` — get immediate advice
- `/pi-rogue` — shared cockpit view over advisor + orchestration pointers

### Orchestration package

- `/goal set|show|clear|list`
- `/loop status|off|clear|stop|<interval> <instruction>`
- `/autoresearch status|clear|<instruction>`
- `/autoresearch-lab status|clear|<instruction>`

### Bundle package

- Includes both advisor and orchestration commands above via one install.

## Documentation

- `packages/advisor/README.md` (Advisor package)
- `packages/orchestration/README.md` (Orchestration package)
- `packages/bundle/README.md` (Bundle surface)
- `packages/advisor/skills/advisor/SKILL.md` (Pi skill surface)
- `packages/orchestration/skills/orchestration/SKILL.md` (Pi skill surface)
- `docs/agents.md` (agentic usage playbook)
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
