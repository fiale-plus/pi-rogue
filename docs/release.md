# Release checklist

Use this when cutting a new release.

**Current policy (as of this doc):** Releases are consolidated under the single published artefact `@fiale-plus/pi-rogue-bundle`. Direct releases of `@fiale-plus/pi-rogue-advisor` and `@fiale-plus/pi-rogue-orchestration` are on pause (their packages are marked private in source; no new npm releases or GitHub tags for them). All logic changes ship via bundle releases.

## Checklist

- [ ] Version is bumped and committed (for the bundle; leaves use dev versions only)
- [ ] Changelog is provisioned for this release
- [ ] Release notes are drafted
- [ ] CI is green on the release commit
- [ ] npm publish workflow is ready (only the bundle workflow)
- [ ] Post-release verification passes (`npm view`, install smoke test)

## Changelog provisioning

"Changelog provisioned" means one of:

- a `CHANGELOG.md` entry is added/updated, or
- the GitHub release notes are prepared with a clear summary of changes

Prefer the changelog entry to be done before the release is cut, not after.

## Naming policy

- Only `pi-rogue-bundle` releases are cut:
  - Tag format: `pi-rogue-bundle-<semver>` (e.g. `pi-rogue-bundle-0.2.0`)
  - Release title: `<semver>` (e.g. `0.2.0`)
- No new tags or releases for `advisor-*` or `pi-rogue-orchestration-*` (paused).
- Keep the component prefix in the tag only.
- Use the same note sections for the bundle release:
  - `## Summary`
  - `## Changes`
  - `## Validation`

## Greenhouse / paused packages

- Internal helper packages (`pi-rogue-guardrails`, `pi-rogue-brain`, `pi-rogue-repo-arch`) remain lab/greenhouse scope and are not published.
- `@fiale-plus/pi-rogue-advisor` and `@fiale-plus/pi-rogue-orchestration` releases are paused (see package.json "private": true). Their code evolves in this repo; updates ship exclusively via the bundle artefact.
- `@fiale-plus/pi-rogue-bundle` is the single public/consolidated artefact for advisor + orchestration logic. Install via `pi install npm:@fiale-plus/pi-rogue-bundle`.

## Release process notes

- Cut a GitHub release with tag `pi-rogue-bundle-<semver>` (this triggers only the bundle publish workflow).
- The bundle publish workflow:
  - Runs checks + tests.
  - Syncs the bundle version from the tag (local only).
  - Publishes the bundle (which bundles the advisor/orchestration logic via bundledDependencies for single-artefact install).
- No need to release leaves first (they are no longer independently released).
- For users: always use the bundle; direct leaf installs are deprecated/paused.

See also: `.github/ISSUE_TEMPLATE/release.md`, AGENTS.md (maintenance references), and the individual package READMEs.
