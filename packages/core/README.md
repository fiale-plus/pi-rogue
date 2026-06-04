# Pi-Rogue Core

Shared helpers for the Pi-Rogue workspace.

Includes the first bounded context broker contract and in-memory implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, and text filters.
- Pruning enforces record/byte caps, TTL expiry, and pinned-artifact retention.

Install locally from this repo root: `npm install`
