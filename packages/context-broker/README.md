# Pi-Rogue Context Broker

Beta context broker runtime for Pi-Rogue.

This package contains the executable in-memory bounded broker implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, and text filters.
- Omitted summaries become metadata-only placeholders, keeping raw payloads out of prompt briefs by default.
- Pruning enforces per-session record/byte caps, TTL expiry on reads, and pinned-artifact retention.

It is intentionally disabled by default in the bundle. Runtime integration, durable storage, and `/context` commands are follow-up work.
