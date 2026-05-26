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
  - `advisor-0.1.x`
  - `pi-rogue-orchestration-0.1.x`
  - `pi-rogue-bundle-0.1.x`
- Release title: `<semver>`
- Keep the component prefix in the tag only.
- Release order is important when multiple packages depend on one another:
  - Run logic-surface releases (`advisor`, `orchestration`) before `pi-rogue-bundle`.
  - Trigger only workflows corresponding to changed packages for that release wave.
- Use the same note sections for every component release:
  - `## Summary`
  - `## Changes`
  - `## Validation`

## Greenhouse status

Internal helper packages (`pi-rogue-guardrails`, `pi-rogue-brain`, `pi-rogue-repo-arch`) remain lab/greenhouse scope and are not published.
`@fiale-plus/pi-rogue-bundle` is the published umbrella for advisor + orchestrator logic.
