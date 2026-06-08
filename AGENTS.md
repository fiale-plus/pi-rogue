# Pi-Rogue repository agent instructions

Use this file as the concise operating guidance for agent usage in this repo.

## Core behavior for agents

- Keep scope narrow. Do not expand command surfaces unless requested.
- Keep command names and behavior unchanged unless explicitly approved.
- Prefer explicit `/` command surfaces and avoid implicit/background-only behavior.
- Start with `/advisor` (or `/advisor status`) at session start to establish quick posture before orchestration actions.

## Safety / process

- **Do not merge PRs without explicit user consent.**
- Merge branches/PRs only after summary validation and user approval.

## Maintenance policy references

This AGENTS file intentionally stays agentic (not maintainer process).

### Release policy (consolidated)

- **Single public artefact only:** All new releases are published as `@fiale-plus/pi-rogue`.
  - Git tag: `pi-rogue-<semver>` (e.g. `pi-rogue-0.2.0`)
  - Triggers only the canonical publish workflow.
- **Advisor and orchestration releases remain paused:** Their packages are `private: true` and have no independent tags/releases; logic changes are still made in `packages/advisor/` and `packages/orchestration/`, but ship exclusively inside the `@fiale-plus/pi-rogue` bundle release.
- **Recommended user install:** `pi install npm:@fiale-plus/pi-rogue`
- **Legacy artifact policy:** keep `@fiale-plus/pi-rogue-bundle`, `@fiale-plus/pi-rogue-advisor`, and `@fiale-plus/pi-rogue-orchestration` in npm as deprecated/thombstone tracks that explicitly point users to `@fiale-plus/pi-rogue`.
- **Do not:** cut separate user-facing releases for advisor/orchestration/bundle aliases.
- **Do not:** publish separate releases for non-user-facing leaves except for local dev markers; leaf package.json version bumps remain development-only.
- Full details, checklists, naming, and process: see `docs/release.md` and `.github/ISSUE_TEMPLATE/release.md`.
- Workflows: only the canonical publish workflow under `.github/workflows/` is active for releases.

See also the referenced docs for the canonical checklists.
