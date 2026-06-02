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

- **Single artefact only:** All releases use the `pi-rogue-bundle` artefact (`@fiale-plus/pi-rogue-bundle` on npm).
  - Git tag: `pi-rogue-bundle-<semver>` (e.g. `pi-rogue-bundle-0.2.0`)
  - Triggers only the bundle publish workflow.
- **Advisor and orchestration releases paused:** Their packages are `private: true`. No new `advisor-*` or `pi-rogue-orchestration-*` tags/releases. Logic changes are made in `packages/advisor/` and `packages/orchestration/`, but ship exclusively inside bundle releases (via `bundledDependencies` for a true single artefact).
- **Recommended user install:** `pi install npm:@fiale-plus/pi-rogue-bundle`
- **Do not:** cut separate releases for leaves; update leaf package.json versions only as dev markers (CI for bundle handles published version from tag).
- Full details, checklists, naming, and process: see `docs/release.md` and `.github/ISSUE_TEMPLATE/release.md`.
- Workflows: `.github/workflows/npm-publish-bundle.yml` (active); the advisor/orchestration publish ymls are disabled (if: false) with comments.

See also the referenced docs for the canonical checklists.
