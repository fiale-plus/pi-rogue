# PiRogue

[![CI](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/fiale-plus/pi-rogue/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-advisor?logo=npm)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor)

PiRogue is an advisor + orchestration Pi extension repo. The published packages are advisor and orchestration; the rest stays internal workspace code.

## Published packages

- `@fiale-plus/pi-rogue-advisor` — phase-aware strategic advisor and advisor-coach replacement (SOTA escalation: gpt-5.5, claude-opus-4-6)
- `@fiale-plus/pi-rogue-orchestration` — loop, goal, and autoresearch controls

## Install (local checkout)

This repo is not published as a bundle yet. Use the local workspace checkout:

```bash
npm install
```

If you only want the advisor workspace while developing:

```bash
npm install --workspace packages/advisor
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

The published surface includes advisor and orchestration. Bundle/umbrella packaging stays internal.

The old `.autoresearch` scratch data has been archived under `~/.pi/archived-autoresearch/pi-rogue/`.

If you’re migrating from advisor-coach, wire the local `packages/advisor` workspace in and remove the old package.

## Development

```bash
npm install
npx vitest run    # 31+ tests
npx vitest run --coverage
```
