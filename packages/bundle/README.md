# @fiale-plus/pi-rogue

`@fiale-plus/pi-rogue` is the **single consolidated public artefact** for Pi-Rogue.

It stitches together (and bundles for a true single-package install):

- `@fiale-plus/pi-core` (shared contracts/helpers)
- `@fiale-plus/pi-rogue-advisor` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-context-broker` (context-broker runtime; registered by default with an env kill switch)
- `@fiale-plus/pi-rogue-orchestration` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-router` (observe-only trajectory-router lab; direct releases paused)

Direct installs of the advisor/orchestration packages are paused (marked private). All users and future releases go through the bundle. See `docs/release.md` and root `AGENTS.md` / `README.md` for the release policy.

## Install (recommended)

```bash
pi install npm:@fiale-plus/pi-rogue
```

For local monorepo dev:

```bash
# from repo root
npm install
# then use workspace packages as needed (e.g. for testing changes to advisor/orch before a bundle release)
```

## Scope boundaries

- **Lab / internal helpers are excluded from this bundle.**
- The context-broker runtime is bundled and registered by default in the bundle.
- Consumers can import the runtime through the bundle subpath: `@fiale-plus/pi-rogue/context-broker`.
- Set `PI_CONTEXT_BROKER_ENABLED=false` before starting Pi to disable the `/context` command surface and prompt-load rewriting.
- Optional durable broker storage can be enabled with `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR=/path/to/store`; it defaults to SQLite/FTS and supports `PI_CONTEXT_BROKER_BACKEND=jsonl` for the legacy JSONL/blob backend.
- `@fiale-plus/pi-rogue` is the only published surface for the logic.
- Internal helper packages (`@fiale-plus/pi-rogue-guardrails`, `@fiale-plus/pi-rogue-brain`, `@fiale-plus/pi-rogue-repo-arch`) are maintained separately in the lab section and are not published.

## Command surface

- Default: `/advisor`, `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab`, `/router` plus status/config/command paths (all provided via the bundle).
- Context broker: enabled by default; `PI_CONTEXT_BROKER_ENABLED=false` disables `/context status`, `/context brief`, `/context lookup <handle|text>`, `/context pin <handle>`, `/context export <handle>`, and `/context prune` with autocomplete.

### Router (offline)

The `/router` surface remains offline and repo-local unless you explicitly enable routing behavior:

- `/router status|help|on|off|mode|profile|models|configure|cycle`
- `/router mode observe` (default): recommendations only, no policy mutation
- `/router mode auto_model`: explicit future-model switching only
- `/router profile <name>` and `print mismatch_only|all|off`

For local artifact generation and sharpening:

- `npm run router:sharpen -- ...`
- `npm run router:sharpen:auto -- ...`

See `packages/router/README.md` for full usage, safety policy, schema, and autosharpen location.

## Status

- **Published:** yes (single artefact)
- The advisor and orchestration packages continue to receive code changes in this repo; they ship inside bundle releases via `bundledDependencies`.

## Release notes

Only `pi-rogue-<semver>` tags/releases are produced. See `docs/release.md` for the full clean policy and checklist.
