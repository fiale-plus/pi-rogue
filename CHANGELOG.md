# Changelog

## 0.3.5

### Summary

This release publishes the streamlined Pi-Rogue command roots from `main`, making the installed package easier to operate from the top-level slash surfaces while preserving the explicit command behavior of advisor, orchestration, context, router, and fusion flows.

### Changes

- Add and document the consolidated `/pi-rogue` command posture for installed sessions.
- Improve command-root completions and help/status routing across advisor, orchestration, context broker, router, and fusion surfaces.
- Add UX/config documentation for the Pi-Rogue command layout and configuration flow.
- Refresh advisor/router/orchestration tests for the streamlined command dispatch behavior.

### Validation

- `npm run check`
- `npm test`

## 0.3.3

### Summary

This release makes Fusion always discoverable via `/fusion` while keeping Fusion models opt-in by recipe presence, adds configure-first recipe management, and enforces analysis-only panel behavior so panel runs avoid side-effecting tool usage.

### Changes

- Make `/fusion` slash command available in all sessions without an enable flag.
- Keep fusion model registration conditional on recipe availability (`fusion/<recipe-id>` providers register only when recipes load).
- Add `/fusion configure add|edit|remove` with validation, persistence, and session-scoped model suggestions.
- Update fusion docs and benchmark guidance to reflect always-on command + recipe-based model activation.
- Enforce explicit no-tool/no-write/no-command/no-side-effect constraints in panel prompts, with judge/synthesis consuming panel outputs as advisory analysis.

### Validation

- `npm run check`
- `npm test`
- `npm test --workspace @fiale-plus/pi-rogue-fusion`
- `npm run check --workspace @fiale-plus/pi-rogue-fusion`
- PR `#152` review and clean merge check completed.

## 0.3.2

### Summary

Fixes the `0.3.1` runtime packaging regression by vendoring `@fiale-plus/pi-rogue-fusion` in the canonical publish workflow, so npm-installed `@fiale-plus/pi-rogue` can resolve Fusion extensions at runtime.

### Changes

- Vendor `@fiale-plus/pi-rogue-fusion` into bundled dependencies during publish-time packaging.
- Keep publish behavior scoped to the canonical workflow (`npm-publish-bundle.yml`) with unchanged version/policy boundaries.
- Preserve existing checks and tests for unchanged packages.

### Validation

- `npm run check`
- `npm test`
- local publish-pack smoke test with vendored `pi-rogue-fusion` and import smoke test success

## 0.3.1

### Summary

This patch release ships model-only Fusion in the published `@fiale-plus/pi-rogue` artefact and tightens context-broker configurability.

### Changes

- Add the `fusion/*` comparable-panel provider path with local recipes, compact broker artifacts, and benchmark workflow.
- Add `/context config threshold <bytes>` with autocomplete for the context-broker prompt rewrite threshold.
- Keep the existing default rewrite threshold at 8192 bytes and preserve env/option override precedence.

### Validation

- `npm run check`
- `npm test`
- feature-loop-style reviewer pass: no blockers/majors

## 0.3.0

### Summary

This release publishes the first `@fiale-plus/pi-rogue` bundle cut after router trajectory work has been stabilized into the primary public artefact, with safer defaults and user-facing docs for offline sharpening.

### Changes

- Add router functionality to the shipped bundle command surface (`/router`) and keep it in observe-first, opt-in mode.
- Add local sharpening workflow exports and scripts:
  - `router:sharpen` for one-shot hint generation
  - `router:sharpen:auto` for cron/automation refreshes with stable user data paths and manifest-based idempotency
- Add automatic persistence migration and manifest/hash guarding to prevent malformed artifacts from silently persisting.
- Document learning-safety boundaries:
  - route hints are local-only, repo-local by default
  - no raw transcript text is written into learning artifacts
  - no automatic policy mutation (manual promotion remains required)
- Expand docs in `README.md` and `packages/bundle/README.md` to include router usage and release-scope guidance.

### Validation

- `npm run check`
- `npm run test`
- `npm run router:sharpen -- --events <events.jsonl> --output <path>` (on representative data)
- `npm run router:sharpen:auto -- --workspace <repo>` (on representative data)

## 0.2.4

- Release series pre-router docs and baseline route telemetry shipped in prior releases.
