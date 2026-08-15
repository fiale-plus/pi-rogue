# Release checklist

Use this when cutting a new release.

**Current policy:** Releases are consolidated under one public package, `@fiale-plus/pi-rogue`. The package contains only the shared core and explicit Advisor/Board extension. Direct releases of `@fiale-plus/pi-rogue-advisor` remain paused because the leaf package is private and ships inside the canonical artifact.

Retired package names remain deprecation/tombstone tracks where they are still published. They are not current runtime surfaces and must not be added back to the bundle.

## Checklist

- [ ] Canonical version is bumped and committed in `packages/bundle/package.json` and `package-lock.json`.
- [ ] Changelog is provisioned for this release.
- [ ] Release notes are drafted.
- [ ] CI is green on the release commit.
- [ ] The canonical publish workflow is ready.
- [ ] Post-release verification passes (`npm view`, packed install smoke, and focused Board checks when Board behavior changes).
- [ ] Legacy artifacts are deprecated against the latest `@fiale-plus/pi-rogue`.

## Changelog provisioning

“Changelog provisioned” means one of:

- a `CHANGELOG.md` entry is added or updated; or
- GitHub release notes are prepared with a clear summary of changes.

Prefer the changelog entry before the release is cut.

## Naming policy

- Only `pi-rogue` releases are cut:
  - Tag format: `pi-rogue-<semver>` (for example, `pi-rogue-0.3.31`).
  - Release title: `<semver>` (for example, `0.3.31`).
- No independent tags or releases are produced for the private Advisor leaf or retired package tracks.
- Keep the package prefix in the tag only.
- Release notes use this shape:
  - `## Summary`
  - `## Changes`
  - `## Validation`

## Legacy tombstones

- `@fiale-plus/pi-rogue-advisor` is an internal bundled leaf; its direct release track stays paused.
- `@fiale-plus/pi-rogue-bundle`, `@fiale-plus/pi-rogue-orchestration`, and the older `@fiale-plus/pi-orchestration` compatibility name are retired deprecation tracks.
- Existing tombstones should keep warning-forwarding messages that point users to `@fiale-plus/pi-rogue`; do not describe retired packages as bundled runtime features.

## Release process notes

- The committed `packages/bundle/package.json` version is the sole version authority. The release tag must exactly equal `pi-rogue-<committed-version>`; the workflow validates this and never rewrites package metadata.
- Cut a GitHub release with that exact tag; this triggers only the canonical publish workflow.
- Every release must have either a matching `CHANGELOG.md` heading or GitHub release notes with `Summary`, `Changes`, and `Validation` sections.
- The canonical publish workflow validates the version/tag and release-note evidence, runs checks and tests, and publishes `@fiale-plus/pi-rogue` with its core and Advisor dependencies bundled.
- After publishing, deprecate any still-published legacy names so installs warn users to migrate. Already-correct messages are success; transient writes are retried, every published version is verified against the expected message, and exhausted failures fail the workflow.
- Post-release verification includes:
  - `npm view` confirms the new canonical version is visible;
  - `npm info <legacy-pkg> deprecated` shows the migration message; and
  - `npm run test:packed-min-node` verifies the packed canonical artifact at the minimum supported Node version.

Example legacy deprecation commands (run only for names that still exist in the registry):

```bash
npm deprecate "@fiale-plus/pi-rogue-bundle@*" 'Deprecated: replaced by @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-rogue-advisor@*" 'Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-rogue-orchestration@*" 'Deprecated: advisor/orchestration are bundled in @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
npm deprecate "@fiale-plus/pi-orchestration@*" 'Deprecated: replaced by @fiale-plus/pi-rogue. Install via "pi install npm:@fiale-plus/pi-rogue".'
```

See also: `.github/ISSUE_TEMPLATE/release.md`, `AGENTS.md` maintenance references, and the canonical package README.
