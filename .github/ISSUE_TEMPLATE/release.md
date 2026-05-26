---
name: Release checklist
about: Track work needed before cutting a release
labels: release
---

## Release checklist

- [ ] Version is bumped and committed
- [ ] Changelog is provisioned for this release
- [ ] Release notes are drafted using the standard sections below
- [ ] CI is green on the release commit
- [ ] npm publish workflow is ready
- [ ] Post-release verification passes

## Changelog provisioning

Link the planned changelog entry or release notes draft here:

- [ ] Changelog updated / release notes drafted

## Standard release note format

Use this shape for component releases so notes stay consistent:

```md
## Summary

## Changes

## Validation
```

## Release scope

List components touched in this release (and release in dependency order):

- [ ] advisor (`advisor-<semver>`)
- [ ] pi-rogue-orchestration (`pi-rogue-orchestration-<semver>`)
- [ ] pi-rogue-bundle (`pi-rogue-bundle-<semver>`)

When this release updates both logic packages and the bundle:
- release logic packages first
- then release `pi-rogue-bundle` so it captures latest versions

## Naming policy

- Tag format: `<component>-<semver>`
- Release title: `<semver>`
- Use the component prefix in the tag, not in the title.
- Internal/experimental umbrella code is labeled as the PiRogue greenhouse, not published as a release.

## Notes

See `docs/release.md` for the full checklist.
