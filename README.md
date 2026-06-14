# Pi-Rogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/fiale-plus/pi-rogue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/fiale-plus/pi-rogue/check.yml?branch=main&label=tests&style=flat-square)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)

Pi-Rogue is a modular Pi extension stack for **agentic session guidance** and **goal/loop-based orchestration**.

## Components and release status

| Package | NPM Version | NPM Downloads | What it is |
|---|---|---|---|
| `@fiale-plus/pi-rogue` | [![version](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue) | [![downloads](https://img.shields.io/npm/dm/%40fiale-plus%2Fpi-rogue?style=flat-square)](https://www.npmjs.com/package/@fiale-plus/pi-rogue) | **Single consolidated artefact** for advisor + orchestration (recommended) |

Legacy/paused packages remain available for compatibility but are deprecated:

- `@fiale-plus/pi-rogue-bundle` (deprecated; kept for migration)
- `@fiale-plus/pi-rogue-advisor` (deprecated; paused)
- `@fiale-plus/pi-rogue-orchestration` (deprecated; paused)

Lab/greenhouse helper packages (`pi-rogue-guardrails`, `pi-rogue-brain`, `pi-rogue-repo-arch`) are internal and not published.

## Install

### Recommended (and supported for new installs)

```bash
pi install npm:@fiale-plus/pi-rogue
```

This is the single consolidated artefact. It includes advisor + orchestration logic (bundled through package dependencies for one-install behavior).

### Legacy package users

Existing installs of `@fiale-plus/pi-rogue-bundle`, `@fiale-plus/pi-rogue-advisor`, and `@fiale-plus/pi-rogue-orchestration` continue to function during migration but will show deprecation notices. Update installs to `@fiale-plus/pi-rogue`.

### Local workspace / lab

```bash
# from repo root
npm install
```

This exposes all workspace packages for local development.

## Quick start

1. Install `@fiale-plus/pi-rogue` (the single consolidated artefact).
2. Start a Pi session.
3. Run `/advisor` (or `/advisor status`) first to set advisor posture.
4. Then use:
   - `/pi-rogue` — cockpit and command pointers
   - `/advisor` — strategic guidance
   - `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab` — orchestration primitives

## Published command surfaces

All command surfaces below are provided by the single `@fiale-plus/pi-rogue` artefact (advisor + orchestration are bundled; their standalone packages have releases paused).

- `/advisor` — status, config, mode/review/model control, and questions
- `/advisor status` — show active mode/review/model state and loop-owned check-ins
- `/advisor on|off`
- `/advisor mode auto|manual|off`
- `/advisor review light|strict|off`
- `/advisor model <provider>/<model>` — optional override
- `/advisor config`
- `/advisor <question>` — get immediate advice
- `/pi-rogue` — shared cockpit view over advisor + orchestration pointers
- `/goal set|show|clear|list` — set or update the active goal (check-ins enabled via loop); models can close active goals with `goal_complete` when summary + verification are available
- `/loop status|off|clear|stop|<interval> <instruction>`
- `/autoresearch status|clear|<instruction>` — goal+loop-driven solo research flow
- `/autoresearch-lab status|clear|<instruction>` — goal+loop-driven parallel research flow

## Documentation

- `packages/advisor/README.md` (Advisor package)
- `packages/orchestration/README.md` (Orchestration package)
- `packages/bundle/README.md` (Canonical published package)
- `packages/advisor/skills/advisor/SKILL.md` (Pi skill surface)
- `packages/orchestration/skills/orchestration/SKILL.md` (Pi skill surface)
- `AGENTS.md` (repo instructions)
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
