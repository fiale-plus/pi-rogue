# @fiale-plus/pi-rogue

`@fiale-plus/pi-rogue` is the **single consolidated public artefact** for Pi-Rogue.

It stitches together (and bundles for a true single-package install):

- `@fiale-plus/pi-core` (shared contracts/helpers)
- `@fiale-plus/pi-rogue-advisor` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-context-broker` (context-broker runtime; registered by default with an env kill switch)
- `@fiale-plus/pi-rogue-fusion` (opt-in OpenRouter-style composite model provider shipped in this package)
- `@fiale-plus/pi-rogue-orchestration` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-router` (observe-only trajectory-router lab; direct releases paused)

Direct installs of advisor/orchestration remain paused (marked private). Fusion ships through this published artefact as an opt-in provider. See `docs/release.md` and root `AGENTS.md` / `README.md` for the release policy.

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

- The context-broker runtime is bundled and registered by default in the bundle.
- Consumers can import the runtime through the bundle subpath: `@fiale-plus/pi-rogue/context-broker`.
- Set `PI_CONTEXT_BROKER_ENABLED=false` before starting Pi to disable the `/context` command surface and prompt-load rewriting.
- Optional durable broker storage can be enabled with `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR=/path/to/store`; it defaults to SQLite/FTS and supports `PI_CONTEXT_BROKER_BACKEND=jsonl` for the legacy JSONL/blob backend.

## Command surface

- Default: `/advisor`, `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab`, `/router`, `/fusion` plus status/config/command paths (all provided via the bundle).
- Context broker: enabled by default; `PI_CONTEXT_BROKER_ENABLED=false` disables `/context status`, `/context brief`, `/context lookup <handle|text>`, `/context pin <handle>`, `/context export <handle>`, `/context config threshold <bytes>`, and `/context prune` with autocomplete.
- Fusion provider: disabled by default; `PI_ROGUE_FUSION_ENABLED=1` auto-registers configured `fusion/<recipe-id>` models, or use `/fusion reload` explicitly in a session.

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

### Fusion (opt-in)

The `/fusion` surface loads OpenRouter-style comparable-panel recipes. It keeps the language explicit:

- panel: `analysis_models` answer the same task independently;
- judge: structured comparison (`consensus`, `contradictions`, `partial_coverage`, `unique_insights`, `blind_spots`);
- synthesis: final answer from judge analysis plus panel responses.

Pi-agents/subagents and pi-intercom are reserved for a future `agent_fusion` recipe family (`analysis_agents`) rather than overloaded into `analysis_models`.

See `packages/fusion/README.md`.

## Status

- **Published:** yes (single artefact)
- Advisor, orchestration, router, context broker, and Fusion code ship inside bundle releases via `bundledDependencies`.

## Release notes

Only `pi-rogue-<semver>` tags/releases are produced. See `docs/release.md` for the full clean policy and checklist.
