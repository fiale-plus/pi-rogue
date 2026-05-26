# PiRogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/fiale-plus/pi-rogue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/fiale-plus/pi-rogue/check.yml?branch=main&label=tests&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)

PiRogue is a modular Pi extension stack for **agentic session guidance** and **goal/loop-based orchestration**.

## Components and release status

| Surface | Package | NPM Version | NPM Downloads | What it is | Scope |
|---|---|---|---|---|---|
| Published | `@fiale-plus/pi-rogue-advisor` | [![advisor version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-advisor?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor) | [![advisor downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-advisor?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor) | Strategic advisor + phase-aware routing + optional check-ins | Public |
| Published | `@fiale-plus/pi-rogue-orchestration` | [![orchestration version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-orchestration?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | [![orchestration downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue-orchestration?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | Loop, goal, and autoresearch controls | Public |
| Upcoming (prepared) | `@fiale-plus/pi-rogue-bundle` | [![bundle version](https://img.shields.io/badge/bundle%20version-n%2Fa-lightgrey?style=flat-square)](https://img.shields.io/badge/bundle%20version-n%2Fa-lightgrey) | [![bundle downloads](https://img.shields.io/badge/bundle%20downloads-n%2Fa-lightgrey?style=flat-square)](https://img.shields.io/badge/bundle%20downloads-n%2Fa-lightgrey) | Umbrella package for advisor + orchestration | Prepared, not yet published |
| Lab/greenhouse | `@fiale-plus/pi-rogue-guardrails` | n/a | n/a | Internal helper for command safety gates | Internal / not released |
| Lab/greenhouse | `@fiale-plus/pi-rogue-brain` | n/a | n/a | Internal helper for session memory | Internal / not released |
| Lab/greenhouse | `@fiale-plus/pi-rogue-repo-arch` | n/a | n/a | Internal helper for repo memory workflows | Internal / not released |

## Install

### Published packages (recommended)

```bash
# individual surfaces
pi install npm:@fiale-plus/pi-rogue-advisor
pi install npm:@fiale-plus/pi-rogue-orchestration
```

### Umbrella package

`@fiale-plus/pi-rogue-bundle` is prepared as the umbrella package. It is currently available via the workspace package (`npm install` at repo root) and will be published as a dedicated release step.

### Local workspace / lab

```bash
# from repo root
npm install
```

This exposes all workspace packages (`advisor`, `orchestration`, `bundle`, and internal lab packages) for local development.

## Quick start

1. Install either the umbrella or individual packages.
2. Start a Pi session.
3. Run `/advisor` (or `/advisor status`) first to let the quick main model establish session posture.
4. Then use:
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
