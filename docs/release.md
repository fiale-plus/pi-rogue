# Release checklist

Use this when cutting a new release.

**Current policy (as of this doc):** Releases are consolidated under a single public package, `@fiale-plus/pi-rogue`.
Direct releases of `@fiale-plus/pi-rogue-advisor` and `@fiale-plus/pi-rogue-orchestration` are on pause (their packages are `private: true` in source; no independent npm tags/releases).
Legacy alias package `@fiale-plus/pi-rogue-bundle` is deprecated and redirects users to `@fiale-plus/pi-rogue`.

## Checklist

- [ ] Canonical version is bumped and committed in `packages/bundle/package.json` and `package-lock.json` (leaves keep dev-marker versions only)
- [ ] Changelog is provisioned for this release
- [ ] Release notes are drafted
- [ ] CI is green on the release commit
- [ ] publish workflow is ready (canonical publish workflow only)
- [ ] Post-release verification passes (`npm view`, install smoke test, `npm run budget-board:smoke` when Advisor Board profile changes)
- [ ] Legacy artefacts are deprecated against latest `@fiale-plus/pi-rogue`

## Changelog provisioning

"Changelog provisioned" means one of:

- a `CHANGELOG.md` entry is added/updated, or
- the GitHub release notes are prepared with a clear summary of changes

Prefer the changelog entry to be done before the release is cut, not after.

## Naming policy

- Only `pi-rogue` releases are cut:
  - Tag format: `pi-rogue-<semver>` (e.g. `pi-rogue-0.2.0`)
  - Release title: `<semver>` (e.g. `0.2.0`)
- No new tags or releases for `advisor-*` or `pi-rogue-orchestration-*` packages (paused).
- Keep the package prefix in the tag only.
- Use this note shape for release notes:
  - `## Summary`
  - `## Changes`
  - `## Validation`

## Greenhouse / paused packages

- Internal helper packages (`pi-rogue-guardrails`, `pi-rogue-brain`, `pi-rogue-repo-arch`) remain lab/greenhouse scope and are not published.
- `@fiale-plus/pi-rogue-advisor` and `@fiale-plus/pi-rogue-orchestration` releases are paused. Their code evolves in this repo and ships inside `@fiale-plus/pi-rogue`.
- `@fiale-plus/pi-rogue-bundle`, `@fiale-plus/pi-rogue-advisor`, and `@fiale-plus/pi-rogue-orchestration` should be deprecation tracks:
  - Keep install/installers discoverable but warning-forwarding only.
  - Their current published versions should have deprecation notices pointing to `@fiale-plus/pi-rogue`.

## Release process notes

- The committed `packages/bundle/package.json` version is the sole version authority. The release tag must exactly equal `pi-rogue-<committed-version>`; the workflow validates this and never rewrites package metadata.
- Cut a GitHub release with that exact tag (this triggers only the canonical publish workflow).
- Every release must have either a matching `CHANGELOG.md` heading or GitHub release notes with `Summary`, `Changes`, and `Validation` sections.
- Canonical publish workflow:
  - Validates the committed version/tag and release-note evidence.
  - Runs checks + tests.
  - Publishes `@fiale-plus/pi-rogue` with bundled dependencies for a true single-artefact install.
- After publishing, deprecate legacy artefacts (`@fiale-plus/pi-rogue-bundle`, `@fiale-plus/pi-rogue-advisor`, `@fiale-plus/pi-rogue-orchestration`, and the older `@fiale-plus/pi-orchestration` compatibility track) so installs of those names warn users to migrate. Already-correct messages are success; transient writes are retried, every published version is verified against the exact expected message, and exhausted failures fail the workflow.
- Post-release verification includes:
  - `npm view` confirms new version is visible for `@fiale-plus/pi-rogue`.
  - `npm info <legacy-pkg> deprecated` shows the migration message.
  - For Advisor Board/profile releases, `npm run budget-board:smoke` passes locally; it uses registry metadata and temp config files only, with no live model calls.

Example legacy deprecation commands (run in the release workflow):

```bash
npm deprecate "@fiale-plus/pi-rogue-bundle@*" 'Deprecated: replaced by @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-rogue-advisor@*" 'Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-rogue-orchestration@*" 'Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-orchestration@*" 'Deprecated: replaced by @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
```

See also: `.github/ISSUE_TEMPLATE/release.md`, AGENTS.md (maintenance references), and the individual package READMEs.
