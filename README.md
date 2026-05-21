# pi-fiale-plus

Fiale Plus Pi extensions, skills, and workflow plugins.

## Packages

- `@fiale-plus/pi` — bundle install for the full suite
- `@fiale-plus/pi-advisor` — coaching / decision framing
- `@fiale-plus/pi-goal` — session goal tracking
- `@fiale-plus/pi-guardrails` — shell risk checks and approvals
- `@fiale-plus/pi-brain` — local project memory
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
```

Each feature package can be installed on its own, or through the bundle.
