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

## Naming policy

- Tag format: `<component>-<semver>`
- Release title: `<semver>`
- Use the component prefix in the tag, not in the title.
- Internal/experimental umbrella code is labeled as the PiRogue greenhouse, not published as a release.

## Notes

See `docs/release.md` for the full checklist.
