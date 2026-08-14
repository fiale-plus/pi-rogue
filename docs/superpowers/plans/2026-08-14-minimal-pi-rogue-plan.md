# Minimal Pi-Rogue Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a minimal `@fiale-plus/pi-rogue` artifact containing only explicit Advisor and read-only Board behavior.

**Architecture:** The bundle registers only Advisor. Advisor has no automatic model work or router/profile lifecycle; explicit Advisor, specialist, and Head calls use a small model map and bounded resolution. Deleted packages are removed from the workspace and all shipped/docs/script references are migrated or deleted.

**Tech Stack:** TypeScript, Vitest, npm workspaces, Pi ExtensionAPI, TypeBox, Git worktrees, GitHub CLI.

---

## Stacked PR layout

Each branch is based on the previous branch and pushed to GitHub. Do not merge any branch.

1. `feat/minimal-explicit-advisor-board` — simplify Advisor runtime/configuration while preserving explicit Board calls.
2. `chore/remove-retired-subsystems` — delete Fusion, Context Broker, Orchestration, Router source/tests/manifests and remove package graph/scripts.
3. `docs/minimal-runtime-surface` — align public docs, package metadata, release notes, and final smoke/coverage checks.

The design specification is already committed on the base branch at `docs/superpowers/specs/2026-08-14-minimal-pi-rogue-design.md`.

## PR 1: Explicit Advisor and Board

### Task 1: Establish minimal Advisor configuration

**Files:**
- Modify: `packages/advisor/src/extension.ts` configuration types, defaults, normalization, status text, model resolution.
- Modify: `packages/advisor/src/extension.test.ts` configuration and status tests.
- Modify: `packages/advisor/package.json` scripts only if removed modules become unreferenced.

- [ ] Replace `AdvisorConfig` fields `mode`, `review`, `checkins`, `profile`, `profileRestore`, and orchestration-linked settings with `models.advisor`, `models.specialist`, `models.head`, and bounded Board settings.
- [ ] Make defaults explicit-only: no automatic mode, review, or check-in fields; Board shadow off; specialists suggest-only; Head off.
- [ ] Normalize unknown legacy values without recreating deleted subsystem paths or writing migration aliases.
- [ ] Change model resolution to explicit configured model, then at most one preferred compatible fallback; never iterate every available text model.
- [ ] Add tests for null model discovery, explicit override, unavailable model failure, and bounded fallback count.
- [ ] Run `npm test -- packages/advisor/src/extension.test.ts` and commit `refactor(advisor): reduce configuration to explicit board calls`.

### Task 2: Remove automatic Advisor execution

**Files:**
- Modify: `packages/advisor/src/extension.ts` registration and state handling.
- Modify/delete: `packages/advisor/src/router.ts`, `binary-gate-eval.ts`, `preflight-signals.ts`, `artifact-preflight.ts`, `review-preflight.ts`, and their tests where only automatic routing uses them.
- Modify: `packages/advisor/src/extension.test.ts`, `router.test.ts`, `binary-gate*.test.ts`, `preflight-signals.test.ts`, `artifact-preflight.test.ts`, `review-preflight.test.ts`.

- [ ] Remove `before_agent_start`, `turn_end`, and `agent_end` handlers that compute routes, inject prompts, review automatically, or initiate check-ins.
- [ ] Preserve session lifecycle only as needed to initialize/close explicit Board state and compact evidence; no model call or prompt mutation from lifecycle hooks.
- [ ] Remove automatic review state, route-log writes, trajectory/router reads, check-in locks, and follow-up injection.
- [ ] Delete obsolete automatic-routing tests; add a registration test asserting no automatic model hook is installed and explicit command/tool registration remains.
- [ ] Keep the local gate only if it is directly used by explicit result post-processing; otherwise remove all gate artifacts and tests in this PR.
- [ ] Run focused Advisor tests and commit `refactor(advisor): make model work explicit-only`.

### Task 3: Make Board calls explicit, bounded, and model-map driven

**Files:**
- Modify: `packages/advisor/src/board-head.ts`, `board-specialist.ts`, `board-roles.ts`, `extension.ts`.
- Delete: `packages/advisor/src/board-shadow.ts`, `board-shadow.test.ts`, `board-flight-recorder.ts`, `board-flight-recorder.test.ts`, `board-flight-ux.ts`, `board-flight-ux.test.ts`, `personal-specialist-discovery.ts`, `personal-specialist-discovery.test.ts`, worker file, and shadow/fixture tests if no longer referenced.
- Modify: Board tests and `packages/advisor/README.md`.

- [ ] Keep static roles `reviewer`, `security`, `architecture`, `debugger`, and `reliability-perf` with read/search-only tool contracts and concise descriptions.
- [ ] Remove worker/smart/teacher/explore/verify routing role concepts from Board-facing APIs.
- [ ] Ensure specialist mode is `suggest` or `off`; remove automatic dispatch behavior and preserve explicit user calls.
- [ ] Ensure Head is explicit only, bounded, read-only, raw-transcript-free, and cannot dispatch or mutate.
- [ ] Add model override selection for advisor/specialist/head using the minimal config and include selected model in status/result metadata.
- [ ] Add tests for role contract, disallowed tools, call budgets, explicit Head call, explicit specialist call, and model selection.
- [ ] Run `npm test -- packages/advisor/src/board*.test.ts packages/advisor/src/extension.test.ts` and commit `feat(advisor): retain explicit read-only board`.

### Task 4: Add optional explicit-call gate post-processing

**Files:**
- Modify/create: focused Advisor gate module under `packages/advisor/src/`.
- Modify: explicit Advisor, specialist, and Head result paths.
- Test: focused gate and command tests.

- [ ] If retained, accept an explicit advisory result and return a local `continue|suggest_head|uncertain` classification without model calls.
- [ ] Ensure classification never suppresses, retries, triggers, or injects another operation; it only adds visible suggestion metadata.
- [ ] Remove trajectory, route log, preflight, and automatic control dependencies from the gate.
- [ ] Add tests proving explicit result post-processing is local and cannot invoke another completion.
- [ ] Commit `feat(advisor): add bounded advisory result hint`.

## PR 2: Delete retired subsystems

### Task 5: Remove package directories and workspace graph

**Files:**
- Delete: `packages/fusion/**`.
- Delete: `packages/context-broker/**`.
- Delete: `packages/orchestration/**`.
- Delete: `packages/router/**`.
- Modify: `packages/bundle/package.json`, `packages/bundle/src/extension.ts`, `packages/bundle/src/index.ts`, bundle tests.
- Modify: root `package.json`, regenerate `package-lock.json`.

- [ ] Remove bundle imports/registration for Fusion, Context Broker, Orchestration, and Router; register only Advisor.
- [ ] Remove deleted package dependencies, bundledDependencies, exports, skills, and host-compat expectations.
- [ ] Remove root scripts that invoke deleted package CLIs, including router and fusion benchmarks; retain unrelated Board scripts.
- [ ] Delete package trees only after all imports/references are removed so TypeScript diagnostics identify remaining callers.
- [ ] Add bundle tests proving only retained Advisor commands are registered and deleted commands are absent.
- [ ] Run `npm install`, focused bundle tests, and package type checks; commit `chore: remove retired runtime subsystems`.

### Task 6: Remove obsolete shared contracts and references

**Files:**
- Modify/delete unused context-broker exports in `packages/core/src/context-broker.ts` and `packages/core/src/index.ts`.
- Modify: Advisor imports/state/config paths left over from Router/Context/Orchestration.
- Modify: scripts and test configuration that enumerate deleted packages.

- [ ] Remove only core contracts with no remaining Advisor consumer; preserve shared paths, secure filesystem, risk, storage, and text helpers.
- [ ] Remove orchestration directory constants, context broker brief hooks, router path readers, and dead config planners from Advisor.
- [ ] Search the repository for deleted package names and either remove references or classify intentional historical release notes.
- [ ] Run workspace type checks and focused tests; commit `refactor: remove retired subsystem contracts`.

## PR 3: Public surface and release readiness

### Task 7: Rewrite public documentation and command references

**Files:**
- Modify: `README.md`, `packages/bundle/README.md`, `packages/advisor/README.md`.
- Modify/delete: deleted subsystem docs and links under `docs/` that describe shipped Fusion, Context, Orchestration, or Router behavior.
- Modify: `docs/release.md` only where package contents/checklists require it.

- [ ] Describe only explicit Advisor, Board, specialists, Head, model map, safety boundaries, and zero-background-call behavior.
- [ ] Remove deleted commands, installation/configuration examples, and claims about context persistence, model routing, Fusion, goals, loops, or autoresearch.
- [ ] Document static role definitions and explicit command examples.
- [ ] Preserve canonical single-artifact release policy and deprecated legacy artifact policy.
- [ ] Commit `docs: document minimal explicit advisory surface`.

### Task 8: Final verification and PR metadata

**Files:**
- Modify: `CHANGELOG.md` with one release-note entry if repository policy requires it.
- Modify: tests only for uncovered final observable contracts.

- [ ] Run `npm install` and `npm run check`.
- [ ] Run `npm test` and the packed minimum-node smoke test.
- [ ] Run a runtime smoke test that registers the bundle and proves no automatic model hooks/calls occur; invoke explicit Advisor/Board paths with bounded mocks.
- [ ] Verify deleted package paths, commands, dependencies, and scripts are absent while retained Board commands work.
- [ ] Inspect each branch diff against its parent; ensure no user worktree files were included.
- [ ] Commit final tests/docs as `test: verify minimal runtime surface` if needed.
- [ ] Push all three branches and create chained GitHub PRs with explicit base/head links, acceptance evidence, and “do not merge” status until human review.

## Verification commands

```bash
npm install
npm run check
npm test
npm run test:packed-min-node
```


Focused checks during PR 1:

```bash
npm test -- packages/advisor/src/extension.test.ts packages/advisor/src/board-head.test.ts packages/advisor/src/board-specialist.test.ts packages/advisor/src/board-roles.test.ts
```

Focused checks during PR 2:

```bash
npm test -- packages/bundle/src/*.test.ts
npm run check -ws --if-present
```

## Risks and mitigations

- Removing Router trajectory may expose stale Advisor assumptions: delete those imports and test empty/absent trajectory explicitly.
- Removing Context Broker may leave Advisor brief code paths: explicit Advisor must operate with only compact Advisor state.
- Deleting packages can leave docs/scripts/lockfile references: use repository search plus regenerated lockfile before each PR.
- Model fallback can accidentally multiply cost: tests must assert at most one fallback attempt.
- Board usefulness can regress without lifecycle evidence: retain bounded in-session evidence collection, but no persistence database or prompt rewrite.
