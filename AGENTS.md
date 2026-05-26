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
- Release notes should include `Summary`, `Changes`, and `Validation` sections.

## Surface tiers

- **Published surface**: `@fiale-plus/pi-rogue-advisor`, `@fiale-plus/pi-rogue-orchestration`, `@fiale-plus/pi-rogue-bundle`.
- **Lab / greenhouse (internal)**: `@fiale-plus/pi-rogue-guardrails`, `@fiale-plus/pi-rogue-brain`, `@fiale-plus/pi-rogue-repo-arch`.
  - These are not to be externalized or marked as lab-grade alternatives in published command docs yet.

## Release orchestration rule (requested)

- For changed logic packages (`advisor`/`orchestration`), release those first.
- Release `pi-rogue-bundle` after its upstream published surfaces are at the desired versions.
- Trigger only the changed-package release workflows / publish paths for a given release step.
