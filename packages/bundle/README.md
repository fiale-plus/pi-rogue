# Pi-Rogue Bundle

`@fiale-plus/pi-rogue-bundle` is the prepared umbrella package that stitches together:

- `@fiale-plus/pi-rogue-advisor`
- `@fiale-plus/pi-rogue-orchestration`

It is a thin, official surface for local usage when you want one install and both command families together.

## Install

```bash
# from repo root (workspace install)
npm install
# and then use workspace packages as needed
```

## Scope boundaries

- **Lab / internal helpers are excluded from this bundle.**
- `@fiale-plus/pi-rogue-bundle` currently includes only the published logic surfaces.
- Internal helper packages (`@fiale-plus/pi-rogue-guardrails`, `@fiale-plus/pi-rogue-brain`, `@fiale-plus/pi-rogue-repo-arch`) are maintained separately in the lab section.

## Command surface

- `/advisor`, `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab` plus status/config/command paths inherited from the two included packages.

## Status

- **Published?** In progress (prepared package)
- **NPM version/downloads:** not yet published (no registry entry yet)
- **Stability:** public surface; no extra internal helper behavior
