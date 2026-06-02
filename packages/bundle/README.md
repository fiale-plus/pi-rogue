# Pi-Rogue Bundle

`@fiale-plus/pi-rogue-bundle` is the **single consolidated public artefact** for Pi-Rogue.

It stitches together (and bundles for a true single-package install):

- `@fiale-plus/pi-rogue-advisor` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-orchestration` (logic; direct releases paused)

Direct installs of the advisor/orchestration packages are paused (marked private). All users and future releases go through the bundle. See `docs/release.md` and root `AGENTS.md` / `README.md` for the release policy.

## Install (recommended)

```bash
pi install npm:@fiale-plus/pi-rogue-bundle
```

For local monorepo dev:

```bash
# from repo root
npm install
# then use workspace packages as needed (e.g. for testing changes to advisor/orch before a bundle release)
```

## Scope boundaries

- **Lab / internal helpers are excluded from this bundle.**
- `@fiale-plus/pi-rogue-bundle` is the only published surface for the logic.
- Internal helper packages (`@fiale-plus/pi-rogue-guardrails`, `@fiale-plus/pi-rogue-brain`, `@fiale-plus/pi-rogue-repo-arch`) are maintained separately in the lab section and not published.

## Command surface

- `/advisor`, `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab` plus status/config/command paths (all provided via the bundle).

## Status

- **Published:** yes (single artefact)
- The advisor and orchestration packages continue to receive code changes in this repo; they ship inside bundle releases via `bundledDependencies`.

## Release notes

Only `pi-rogue-bundle-<semver>` tags/releases are produced. See `docs/release.md` for the full clean policy and checklist.
