# PiRogue

[![CI](https://github.com/fiale-plus/pi-fiale-plus/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/fiale-plus/pi-fiale-plus/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/%40fiale-plus%2Fpi-rogue-advisor?logo=npm)](https://www.npmjs.com/package/@fiale-plus/pi-rogue-advisor)

PiRogue is an advisor-first Pi extension repo. **Only the advisor package is public right now**; everything else is internal workspace code for later.

## Published package

- `@fiale-plus/pi-rogue-advisor` — phase-aware strategic advisor and advisor-coach replacement (SOTA escalation: gpt-5.5, claude-opus-4-6)

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
  goal/
  guardrails/
  brain/
  repo-arch/
  bundle/
.autoresearch/     # optimization cycles (test coverage, quality)
```

The published surface is advisor-only for now. Bundle/umbrella packaging may come later.

If you’re migrating from advisor-coach, wire the local `packages/advisor` workspace in and remove the old package.

## Development

```bash
npm install
npx vitest run    # 31+ tests
npx vitest run --coverage
```
