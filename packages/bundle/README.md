# PiRogue Greenhouse

`packages/bundle` is the internal, unreleased PiRogue umbrella package.

It is marked as **greenhouse** (internal workspace-only) and composes the published surfaces for local development and full-stack experimentation.

## What it stitches together

- `@fiale-plus/pi-rogue-advisor` (published)
- `@fiale-plus/pi-rogue-orchestration` (published)
- `@fiale-plus/pi-guardrails` (internal helper)
- `@fiale-plus/pi-brain` (internal helper)
- `@fiale-plus/pi-repo-arch` (internal helper)

## Why greenhouse?

- Keeps local experimentation obvious and contained.
- Prevents unreleased aggregator surfaces from being interpreted as released npm artifacts.
- Gives a single install and extension hook while still documenting explicit published boundaries.

## Installation and usage

```bash
# from repo root
npm install
```

After workspace install, the umbrella registers all internal and published extension modules for local runs.

## Status

- **Published?** No (private workspace package)
- **NPM version/downloads:** not published
- **Stability:** internal, greenhouse, internal-use only
