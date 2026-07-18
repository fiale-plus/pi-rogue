# Pi-Rogue Core

Shared helpers for the Pi-Rogue workspace.

Includes shared bounded context broker contracts and passive feature-status contracts:

- `FeatureStatusV1` — a versioned, read-only status snapshot with feature-owned diagnostics
- `BoundedContextBroker`
- `ContextArtifact` / `ContextArtifactInput`
- lookup, retention, and status type definitions

`FeatureStatusV1` deliberately has no lifecycle hooks, callbacks, model policy, event bus, or control authority. Consumers must ignore unknown diagnostic fields. Router and Orchestration provide package-owned read-only adapters; the bundle does not become a controller.

The executable in-memory implementation lives in `@fiale-plus/pi-rogue-context-broker`.

Install locally from this repo root: `npm install`
