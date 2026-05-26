# Release checklist

Use this when cutting a new release.

## Checklist

- [ ] Version is bumped and committed
- [ ] Changelog is provisioned for this release
- [ ] Release notes are drafted
- [ ] CI is green on the release commit
- [ ] npm publish workflow is ready
- [ ] Post-release verification passes (`npm view`, install smoke test)

## Changelog provisioning

"Changelog provisioned" means one of:

- a `CHANGELOG.md` entry is added/updated, or
- the GitHub release notes are prepared with a clear summary of changes

Prefer the changelog entry to be done before the release is cut, not after.

## Naming policy

- Tag format: `<component>-<semver>`
- Release title: `<semver>`
- Keep the component prefix in the tag only.
- Use the same note sections for every component release:
  - `## Summary`
  - `## Changes`
  - `## Validation`

## Greenhouse status

Internal/experimental umbrella packaging is labeled as the PiRogue greenhouse and is not published as a release.
