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

Only the consolidated bundle is released:

- [ ] pi-rogue-bundle (`pi-rogue-bundle-<semver>`)

Advisor and orchestration releases are on pause (packages marked private; no independent tags/releases). Changes to their logic ship via the bundle artefact only.

## Naming policy

- Tag format: `pi-rogue-bundle-<semver>`
- Release title: `<semver>`
- Use the component prefix in the tag, not in the title.
- Internal helper packages (guardrails/brain/repo-arch) remain lab/greenhouse and are not published independently.
- Direct releases of advisor and pi-rogue-orchestration are paused per docs/release.md.

## Notes

See `docs/release.md` for the full checklist.
