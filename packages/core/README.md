# Pi-Rogue Core

Shared helpers for the Pi-Rogue workspace.

Includes the first bounded context broker contract and in-memory implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, and text filters.
- Omitted summaries become metadata-only placeholders, keeping raw payloads out of prompt briefs by default.
- Pruning enforces per-session record/byte caps, TTL expiry on reads, and pinned-artifact retention.

Install locally from this repo root: `npm install`
