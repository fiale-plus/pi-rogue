# @fiale-plus/pi-rogue

`@fiale-plus/pi-rogue` is the **single consolidated public artefact** for Pi-Rogue.

It stitches together (and bundles for a true single-package install):

- `@fiale-plus/pi-core` (shared contracts/helpers)
- `@fiale-plus/pi-rogue-advisor` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-context-broker` (context-broker runtime; registered by default with an env kill switch)
- `@fiale-plus/pi-rogue-fusion` (OpenRouter-style composite model provider shipped in this package)
- `@fiale-plus/pi-rogue-orchestration` (logic; direct releases paused)
- `@fiale-plus/pi-rogue-router` (observe-only trajectory-router lab; direct releases paused)

Direct installs of advisor/orchestration remain paused (marked private). Fusion ships through this published artefact. See `docs/release.md` and root `AGENTS.md` / `README.md` for the release policy.

## Install (recommended)

```bash
pi install npm:@fiale-plus/pi-rogue
```

Requires `@earendil-works/pi-coding-agent >=0.80.6 <0.81.0` and Node.js `>=22.19.0`. The Node floor is required by the default durable context-broker backend, which uses built-in `node:sqlite`. Required Linux CI verifies the packed package at that exact minimum and reloads a SQLite artifact across fresh processes.

For local monorepo dev:

```bash
# from repo root
npm install
# then use workspace packages as needed (e.g. for testing changes to advisor/orch before a bundle release)
```

## Supported package surface

The published artifact is supported through Pi's TypeScript package loader. Its `.ts` entrypoints and export subpaths are intentionally not a generic plain-Node JavaScript/declaration contract. Pi extensions load from `pi.extensions`, and the bundled advisor/orchestration skills load from `pi.skills`; the publish workflow installs and loads the exact tarball through the supported Pi host before publishing it.

## Scope boundaries

- The context-broker runtime is bundled and registered by default in the bundle.
- Extensions running inside Pi's TypeScript loader can import the runtime through the bundle subpath: `@fiale-plus/pi-rogue/context-broker`.
- Set `PI_CONTEXT_BROKER_ENABLED=false` before starting Pi to disable the `/pi-rogue-context` command surface and prompt-load rewriting.
- Legacy `/context` command alias is not registered.
- Optional durable broker storage can be enabled with `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR=/path/to/store`; it defaults to SQLite/FTS and supports `PI_CONTEXT_BROKER_BACKEND=jsonl` for the legacy JSONL/blob backend.

## Command surface

The bundle registers commands in cockpit-first order for the Pi menu:

1. `/pi-rogue` — management cockpit (`status|help|doctor`)
2. `/pi-rogue-advisor` — strategic advisor controls and one-shot questions
3. `/pi-rogue-router` — route telemetry and explicit model-routing controls
4. `/pi-rogue-fusion` — comparable-panel Fusion provider controls
5. `/pi-rogue-orchestration` — goal, loop, autoresearch, and lab primitives
6. `/pi-rogue-context` — context broker controls, registered last so it sits lower in the menu

Context broker is enabled by default; `PI_CONTEXT_BROKER_ENABLED=false` disables `/pi-rogue-context status`, `/pi-rogue-context brief`, `/pi-rogue-context lookup <handle|text>`, `/pi-rogue-context pin <handle>`, `/pi-rogue-context export <handle>`, `/pi-rogue-context config threshold <bytes>`, and `/pi-rogue-context prune` with autocomplete.

Fusion models register as `fusion/<recipe-id>` when recipes exist. Use `/pi-rogue-fusion configure` then `/pi-rogue-fusion reload` explicitly in a session.

### Router (offline)

The `/pi-rogue-router` surface remains offline and repo-local unless you explicitly enable routing behavior:

- `/pi-rogue-router status|help|mode|profile|models|profiles|configure|cycle`
- `/pi-rogue-router mode observe` (default): recommendations only, no policy mutation
- `/pi-rogue-router mode auto_model`: explicit future-model switching only
- `/pi-rogue-router profile <name>` and `print mismatch_only|all|off`

For local artifact generation and sharpening:

- `npm run router:sharpen -- ...`
- `npm run router:sharpen:auto -- ...`

See `packages/router/README.md` for full usage, safety policy, schema, and autosharpen location.

### Fusion

The `/pi-rogue-fusion` surface loads OpenRouter-style comparable-panel recipes. It keeps the language explicit:

- panel: `analysis_models` answer the same task independently as analysis-only/no-side-effect attempts;
- judge: structured comparison (`consensus`, `contradictions`, `partial_coverage`, `unique_insights`, `blind_spots`);
- synthesis: final answer from judge analysis plus panel responses.

Pi-agents/subagents and pi-intercom are reserved for a future `agent_fusion` recipe family (`analysis_agents`) rather than overloaded into `analysis_models`.

See `packages/fusion/README.md`.

## Status

- **Published:** yes (single artefact)
- Advisor, orchestration, router, context broker, and Fusion code ship inside bundle releases via `bundledDependencies`.

## Release notes

Only `pi-rogue-<semver>` tags/releases are produced. See `docs/release.md` for the full clean policy and checklist.
