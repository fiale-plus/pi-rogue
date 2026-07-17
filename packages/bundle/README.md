# @fiale-plus/pi-rogue

`@fiale-plus/pi-rogue` is the single public Pi extension for Pi-Rogue.

It keeps the controller-facing runtime in one installable artefact and provides four focused capabilities:

- **Context** — bounded, durable context artifacts and lookup handles;
- **Advisor** — explicit strategic advice plus bounded review/check-in controls;
- **Router** — offline route telemetry and opt-in model-routing policy;
- **Orchestration** — explicit goals, loops, and controlled research workflows.

Internal implementation modules are bundled into this package. They are not separate user-facing products or independent release tracks.

## Install

```bash
pi install npm:@fiale-plus/pi-rogue
```

Requires `@earendil-works/pi-coding-agent >=0.80.6 <0.81.0` and Node.js `>=22.19.0`. The Node floor supports the default durable context backend, which uses built-in `node:sqlite`.

For local monorepo development:

```bash
npm install
```

The supported runtime surface is Pi's TypeScript package loader. The `.ts` entrypoints are intended for Pi extensions, not as a generic plain-Node JavaScript or declaration-library contract.

## Default boundaries

- The context broker is registered by default and can be disabled with `PI_CONTEXT_BROKER_ENABLED=false`.
- Context artifacts use durable SQLite/FTS storage by default under `~/.pi/agent/pi-rogue/context-broker`.
- Context storage can be changed explicitly with `PI_CONTEXT_BROKER_DURABLE`, `PI_CONTEXT_BROKER_STORE_DIR`, and `PI_CONTEXT_BROKER_BACKEND`.
- Advisor and orchestration remain controller-owned; they do not replace the active Pi model.
- Router defaults to observation and does not mutate model policy unless explicitly enabled.
- Goals, loops, and research runs are explicit operations; there is no hidden background execution by default.

## Command surface

The bundle registers these commands:

1. `/pi-rogue` — management cockpit (`status|help|doctor`);
2. `/pi-rogue-advisor` — strategic advisor controls and one-shot questions;
3. `/pi-rogue-router` — route telemetry and explicit routing controls;
4. `/pi-rogue-orchestration` — goals, loops, and research controls;
5. `/pi-rogue-context` — bounded context status, lookup, export, and maintenance.

Use `/pi-rogue status` for the aggregate view. Use `/pi-rogue doctor` for setup diagnostics.

## Context broker

The context broker stores large tool results as bounded artifacts and exposes lookup handles such as `ctx://...` instead of reinserting full payloads into every prompt.

Useful commands include:

```text
/pi-rogue-context status
/pi-rogue-context brief
/pi-rogue-context lookup <handle-or-text>
/pi-rogue-context config threshold <bytes>
/pi-rogue-context prune
```

The legacy `/context` command alias is not registered.

## Advisor and router

The advisor is explicit about its role: the hosted/controller model remains responsible for planning, consequential decisions, and final review. Use `/pi-rogue-advisor status` and `/pi-rogue-advisor settings` to inspect the current policy.

The router is an offline telemetry and policy layer:

```text
/pi-rogue-router status
/pi-rogue-router mode observe
/pi-rogue-router models
/pi-rogue-router profiles
```

`observe` is the safe default. Any model-switching behavior must be enabled explicitly and remains bounded by the configured policy.

## Orchestration

Orchestration owns explicit goals, loops, and research lifecycle controls. It does not silently start work or replace the controller. Future execution-worker delegation remains opt-in and parent-reviewed.

## Release policy

Only `@fiale-plus/pi-rogue` is a public Pi-Rogue release artefact. Internal modules ship through this package; legacy package names remain deprecated migration tracks.

Release tags use `pi-rogue-<semver>`. The published tarball is smoke-tested through the supported Pi host before publication.
