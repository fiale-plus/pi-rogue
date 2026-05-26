# PiRogue repository agent instructions

## Scope and command discipline

- Keep scope narrow. Do not expand command surfaces unless requested.
- Keep command names and behavior unchanged unless there is explicit approval.
- Prefer explicit `/` command surfaces and avoid implicit/background-only behavior.

## Merge policy

- **Do not merge PRs without explicit user consent.**
- Merge branches/PRs only after summary validation and user approval.

## Naming and release conventions

- Published package names should follow the `@fiale-plus/pi-rogue-*` pattern.
- Release tags are component-scoped: `<component>-<semver>` (e.g. `advisor-0.1.5`).

## Surface tiers

- **Published surface**: `@fiale-plus/pi-rogue-advisor`, `@fiale-plus/pi-rogue-orchestration`, `@fiale-plus/pi-rogue-bundle`.
- **Lab / greenhouse (internal)**: `@fiale-plus/pi-rogue-guardrails`, `@fiale-plus/pi-rogue-brain`, `@fiale-plus/pi-rogue-repo-arch`.
  - These are not to be marked as user-facing published alternatives.

## Note

- This file is for repo users and agent helpers (not maintainer-only process playbooks). For release workflow details, see `.github/ISSUE_TEMPLATE/release.md` and `docs/release.md`.
