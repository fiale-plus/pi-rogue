# Passive harmonization status catalog

Phase 4 adds a read-only `pi-rogue.harmonization-status.v1` catalog built at the bundle composition boundary. It preserves the existing registration order:

1. Advisor
2. Router
3. Orchestration
4. Context Broker

Each entry is a `FeatureStatusV1` snapshot owned by its feature. The catalog is an introspection/reporting projection only: it cannot start or stop work, select a model, mutate policy, dispatch workers, or write state.

## Privacy boundary

Status serialization validates the schema and rejects unknown/prohibited fields, including prompts, transcripts, payloads, paths, credentials, raw content, and user identifiers. Adapters expose bounded categorical state only; they do not expose state paths, model responses, or user content.

The checked-in implementation provides read-only adapters for Advisor, Router, Orchestration, and Context Broker. Adapter failures become an explicit `error` entry without forwarding exception text.

## Deterministic local report

```sh
npm run harmonization:status -- --output /tmp/pi-rogue-harmonization-status.v1.json
```

The command uses synthetic, representative status fixtures and is a schema/process check—not a production usage, spend, quality, or savings claim. Runtime collection remains local and passive. Representative runtime evidence must be sampled and reviewed separately before any consolidation or deletion decision.
