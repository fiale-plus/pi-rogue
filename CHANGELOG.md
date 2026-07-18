# Changelog

## 0.3.35

### Summary

This release adds the opt-in, model-agnostic execution-worker plane.

### Changes

- Add explicit session-scoped worker selection and configured-model preflight.
- Add bounded RPC worker dispatch with timeouts, cancellation, status polling, and cleanup.
- Add router worker lifecycle telemetry and read-only Advisor Board worker-output review.
- Add focused worker dispatch, telemetry, routing, and review coverage.

### Validation

- TypeScript checks passed.
- Focused execution-worker, advisor, and router suites passed.
- PR #377 CI passed before merge.

## 0.3.34

### Summary

This release adds Pi.dev listing artwork to the canonical Pi-Rogue package.

### Changes

- Add the optimized Pi-Rogue artwork at `docs/images/pi-rogue-pi-dev.png`.
- Publish the artwork through the `pi.image` package manifest field using the repository's public raw GitHub URL.

### Validation

- `npm ci`
- `npm run check`
- `npm test`
- Canonical package metadata and public raw image URL verified.

## 0.3.33

### Summary

This release consolidates the public package and removes disabled or obsolete runtime surfaces.

### Changes

- Remove the disabled Fusion provider, benchmarks, commands, and runtime wiring.
- Archive unused lab packages while retaining deterministic shell-risk scanning in core.
- Finalize canonical tarball metadata so bundled internal packages do not remain runtime dependency declarations.
- Migrate legacy Fusion router profiles and preserve read-only lookup of persisted `fusion_result` artifacts.
- Update public README, configuration UX, release docs, and package smoke tests.

### Validation

- `npm ci`
- `npm run check`
- `npm test`
- Canonical tarball finalization and consumer smoke test passed on the integrated release worktree.

## 0.3.32

### Summary

This patch release fixes stale Advisor review replay and preserves useful advice while keeping the Advisor Board available.

### Changes

- Suppress repeated automatic review-signals and handoff alerts per source/family while retaining the latest useful guidance.
- Clear queued automatic Advisor replay when switching to manual or off mode, including in-flight results that finish after the transition.
- Preserve explicit manual-question answers and their loop history.
- Keep Board, Head-of-Board, and specialist paths independent from automatic loop suppression.

### Validation

- Advisor convergence and Board suites: 105 tests passed.
- Advisor TypeScript check passed.
- Required Node.js 22.19.0 CI passed on PR #366.
- Codex review found no actionable regressions.

## 0.3.31

### Summary

This patch release delivers four critical fixes for context-broker session isolation, advisor artifact preflight accuracy, resume backfill persistence, and model work bounding.

### Changes

- Isolate context-broker state by session to prevent cross-session state leakage across extension, Fusion, and brain packages (#354).
- Ignore ambient package artifact paths in advisor preflight and add explicit artifact list form handling to prevent false-positive artifact matches (#328).
- Bound and persist resume backfill state in the context-broker to prevent lost recovery work across restarts (#355).
- Bound and cancel advisor model work to prevent unbounded async operations and improve cancellation reliability (#357).

### Validation

- Full workspace TypeScript and validation-coverage checks passed.
- Recursive Vitest suite passed on the release baseline.

## 0.3.30

### Summary

This patch release completes the post-0.3.29 reliability audit across context persistence, advisor routing, orchestration lifecycle, Router/Fusion feedback, and bounded Fusion execution. Every retained change was backed by a focused reproduction or regression test.

### Changes

- Enforce owner-only persisted artifact permissions and make JSONL pruning durable, serialized, session-safe, and restart-stable.
- Scope context source deduplication by session across extension and JSONL backends, honor environment configuration, and contain SQLite lock failures during compaction.
- Keep Router observation active with printing disabled, restore profile/model feedback, and make same-session Fusion provider status accurate.
- Dispose Fusion timeout resources, strictly validate judge/synthesis output, and enforce runtime default overall/per-model deadlines even for non-cooperative completers.
- Continue advisor model fallback after per-candidate authentication failures and use complete, versioned, scope-aware answer-cache identities.
- Make advisor manual mode explicit-only and turn trusted binary review-gate escalation into an actionable review route while preserving opt-outs and safety overrides.
- Recover failed goal-message enqueues, release advisor check-in ownership on session shutdown, and preserve resumable goal/loop state.
- Run required CI when draft pull requests become ready for review and preserve the canonical exact-artifact release/deprecation contract.

### Validation

- Required Node.js `22.19.0` CI passed for every merged change.
- Full workspace TypeScript and validation-coverage checks passed.
- Recursive Vitest suite passed with 61 files and 686 tests on the release baseline.
- Canonical tarball contract, Pi-host loading, fresh-cache npm install, and legacy deprecation verification remain release gates.

## 0.3.29

### Summary

This release hardens Pi-Rogue's supported Pi/Node runtime, persistence and routing safety, validation coverage, command semantics, and autoresearch completion lifecycle. It also makes the canonical npm artifact reproducible and smoke-tested before and after publication.

### Changes

- Move the supported host contract to Pi `>=0.80.6 <0.81.0` and Node.js `>=22.19.0`, including exact-minimum packed SQLite durability coverage.
- Harden context-broker session identity, startup/runtime locking, corruption handling, and cross-process persistence.
- Make root recursive tests and resolved TypeScript script coverage authoritative in required CI.
- Separate explicit user routing overrides from policy metadata and prevent weak-label datasets from becoming promotable evaluation truth.
- Validate binary-gate artifacts, strong-model posture configuration, command dispatch, plain-loop backlog behavior, and advisor check-in demand.
- Require explicit confirmation before autoresearch lab activation and require two distinct delivered, evidence-backed cycles before research completion.
- Define the canonical package as a Pi-loader artifact, allowlist its contents, include the MIT license, remove test sources, and pack/smoke/publish the exact same tarball.
- Enforce committed canonical version authority, release-note evidence, exact legacy deprecation messages, bounded retries, and post-write verification.

### Validation

- Required CI on Node.js `22.19.0` for every merged change.
- Full workspace TypeScript checks and recursive Vitest suite.
- Exact canonical tarball install/load smoke through Pi `0.80.6`.
- SQLite artifact persistence and reload across fresh processes at the minimum supported runtime.
- Independent reviewer and Codex review loops for the included audit fixes.

## 0.3.8

### Summary

This release refreshes the repository frontpage and installed command menu ergonomics so Pi-Rogue opens with the `/pi-rogue` cockpit and keeps context-broker controls lower in the menu.

### Changes

- Rewrite the root README as a crisp frontpage with hero copy, quick value bullets, and subsystem-at-a-glance guidance.
- Align subsystem docs around the canonical `/pi-rogue-*` command surfaces.
- Register bundle commands in cockpit-first order: `/pi-rogue`, advisor, router, fusion, orchestration, then `/pi-rogue-context`.
- Keep context-broker startup optional/resilient so core Pi-Rogue commands still load if the broker backend fails.

### Validation

- `npm run check`
- `npm test`
- README local link check
- `git diff --check`
- PR #163 review loop and CI

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
