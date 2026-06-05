# Pi-Rogue Context Broker

Beta context broker runtime for Pi-Rogue.

This package contains the executable in-memory bounded broker implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, and text filters.
- Omitted summaries become metadata-only placeholders, keeping raw payloads out of prompt briefs by default.
- Pruning enforces per-session record/byte caps, TTL expiry on reads, and pinned-artifact retention.

It is intentionally disabled by default in the bundle.

## Opt-in beta extension

Set `PI_CONTEXT_BROKER_ENABLED=true` before starting Pi with the bundle installed to enable the beta extension:

```bash
PI_CONTEXT_BROKER_ENABLED=true pi
```

When enabled, the bundle registers `/context` commands:

- `/context status` — enabled state, record/byte counts, pinned counts.
- `/context brief` — bounded prompt-safe broker brief with handles and summaries.
- `/context lookup <handle|text>` — exact handle rehydration or current-session text search.
- `/context pin <handle>` — protect an artifact from normal TTL/cap pruning.
- `/context prune` — run TTL/cap pruning immediately.

The command includes autocomplete for subcommands and known artifact handles. Exact handle lookup returns clipped payload text; text search returns a smaller clipped excerpt, and truncation is marked explicitly.

## Session behavior and limits

- On session start/reload, the beta backfills the current Pi session branch from `toolResult` and prompt-visible `bashExecution` entries.
- Backfill is idempotent by session entry id, skips malformed entries instead of failing the session, and honors Pi's `excludeFromContext` bash entries.
- The current implementation remains in-memory. Restarting Pi loses broker state until the current branch is backfilled again.
- Prompt integration injects only a bounded broker brief and lookup guidance. It does not yet rewrite existing raw tool-result messages out of Pi's transcript context; that deeper prompt-load reduction remains a follow-up.
- Rollback is immediate: unset `PI_CONTEXT_BROKER_ENABLED` and `/reload` or restart Pi.
