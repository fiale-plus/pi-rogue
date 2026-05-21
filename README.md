# pi-fiale-plus

Fiale Plus Pi extensions, skills, and workflow plugins.

## Packages

- `@fiale-plus/pi` — bundle install for the full suite
- `@fiale-plus/pi-advisor` — multi-model strategic advisor with SOTA model suggestion (gpt-5.5, claude-opus-4-6)
- `@fiale-plus/pi-goal` — session goal tracking
- `@fiale-plus/pi-guardrails` — shell risk checks and approvals with optional LLM review
- `@fiale-plus/pi-brain` — local project memory with branch tracking
- `@fiale-plus/pi-repo-arch` — repo-arch CLI integration bridge
- `@fiale-plus/pi-core` — shared helpers

## Install

```bash
npm install @fiale-plus/pi
# or
npm install @fiale-plus/pi-goal @fiale-plus/pi-advisor
```

## Repo layout

```txt
packages/
  core/
  advisor/
  goal/
  guardrails/
  brain/
  repo-arch/
  bundle/
.autoresearch/     # optimization cycles (test coverage, quality)
```

Each feature package can be installed on its own, or through the bundle.

## Development

```bash
npm install
npx vitest run    # 31+ tests
npx vitest run --coverage
```
