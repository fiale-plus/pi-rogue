# Pi-Rogue Context Broker

Beta context broker runtime for Pi-Rogue.

This package contains the executable in-memory bounded broker implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, tier, and text filters.
- Omitted summaries become metadata-only placeholders, keeping raw payloads out of prompt briefs by default.
- Artifacts are classified as hot/warm/cold on publish; prompt briefs render hot first, warm second, and exclude cold unless explicitly queried.
- Pruning enforces per-session record/byte caps, optional global (cross-session) record/byte caps, tier-specific caps, TTL expiry on reads, and pinned-artifact retention.

It is registered by default in the bundle, with an explicit env kill switch.

## Mainline extension

The bundle registers a `context_lookup` LLM tool plus `/context` commands by default. To disable the runtime for rollback:

```bash
PI_CONTEXT_BROKER_ENABLED=false pi
```

When active, the bundle registers:

- `/context status` — enabled state, record/byte counts, pinned counts, and routing telemetry.
- `/context brief` — bounded prompt-safe broker brief with handles and summaries.
- `/context lookup <handle|text>` — exact handle rehydration or current-session text search.
- `/context pin <handle>` — protect an artifact from normal TTL/cap pruning.
- `/context export <handle>` — write full payload to a temp file without dumping it into prompt.
- `/context prune` — run TTL/cap pruning immediately.

The command includes autocomplete for subcommands and known artifact handles. Exact handle lookup returns clipped payload text; text search returns a smaller clipped excerpt, and truncation is marked explicitly.

Optional durability is available with `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR=/path/to/store`. Durable mode now defaults to SQLite (`artifacts.sqlite`) with an FTS index for text lookup, so exact handles, tier, and pin state survive restarts without replay reconstruction. Set `PI_CONTEXT_BROKER_BACKEND=jsonl` to use the legacy JSONL/blob backend.

- `PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES` controls when large `toolResult` / `bashExecution` payloads are rewritten in-context. The default is `0` (rewritten), so raw tool evidence is replaced by handles by default.

For quieter sessions, set `PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES` to a higher value to only rewrite larger outputs.


## Session behavior and limits

- On session start/reload, the runtime backfills the current Pi session branch from `toolResult` and prompt-visible `bashExecution` entries.
- Backfill is idempotent by session entry id, skips malformed entries instead of failing the session, and honors Pi's `excludeFromContext` bash entries.
- Without durable mode, restarting Pi loses broker state until the current branch is backfilled again.
- Prompt integration injects a bounded, tier-aware broker brief and lookup guidance; the LLM also gets a `context_lookup` tool for exact handle dereferencing. Payloads that hit hostile-binary heuristics are represented in prompt as handles plus short guidance to export the full content.
- The `context` hook rewrites prompt-visible `toolResult` and `bashExecution` payloads in the LLM-bound message copy to broker handles and summaries, reducing prompt load while preserving exact `/context lookup` rehydration.
- Pi `excludeFromContext` bash entries are not backfilled or rewritten into broker prompts.
- Basic secret redaction runs before broker storage and display for common token/password/API-key patterns.
- Optional global caps can be configured via env vars:
  - `PI_CONTEXT_BROKER_GLOBAL_MAX_RECORDS`
  - `PI_CONTEXT_BROKER_GLOBAL_MAX_BYTES`
- Rollback is immediate: set `PI_CONTEXT_BROKER_ENABLED=false` and `/reload` or restart Pi. Disable durable writes by unsetting `PI_CONTEXT_BROKER_DURABLE` and `PI_CONTEXT_BROKER_STORE_DIR`.
