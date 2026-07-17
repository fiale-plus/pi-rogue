---
name: Release checklist
about: Track work needed before cutting a release
labels: release
---

## Release checklist

- [ ] Canonical version is bumped and committed in `packages/bundle/package.json` and `package-lock.json`; planned tag matches exactly
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

Only the canonical package is released:

- [ ] pi-rogue (`pi-rogue-<semver>`)

Advisor, orchestration, and legacy bundle releases are paused (or deprecated tracks). Changes to their logic ship via the canonical package only.

## Naming policy

- `packages/bundle/package.json` is the sole version authority; workflow validation rejects tag drift.
- Tag format: `pi-rogue-<semver>`
- Release title: `<semver>`
- Use the package prefix in the tag, not in the title.
- Former lab helper packages are archived; deterministic shell scanning remains in `packages/core` and is not published independently.
- Direct releases of advisor and pi-rogue-orchestration are paused per docs/release.md.

## Notes

See `docs/release.md` for the full checklist, including legacy deprecation tasks.
