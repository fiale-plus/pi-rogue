# Pi-Rogue Context Broker

Beta context broker runtime for Pi-Rogue.

This package contains the executable in-memory bounded broker implementation:

- `createInMemoryContextBroker()` stores artifacts behind stable `ctx://...` handles.
- Lookups support handle, session, kind, tag, path, command prefix, branch, tier, and text filters.
- Supported artifact kinds include tool outputs, diffs, file snapshots, subagent results, advisor briefs, memory notes, and compact `fusion_result` summaries.
- Omitted summaries become metadata-only placeholders, keeping raw payloads out of prompt briefs by default.
- Artifacts are classified as hot/warm/cold on publish; prompt briefs render hot first, warm second, and exclude cold unless explicitly queried.
- Aging cools unpinned artifacts from hot to warm and from warm to cold; compaction remains cleanup/removal, not a separate cooling trigger.
- Pruning enforces per-session record/byte caps, optional global (cross-session) record/byte caps, tier-specific caps, TTL expiry on reads, and pinned-artifact retention.

It is registered by default in the bundle, with an explicit env kill switch.

## Mainline extension

The bundle registers a `context_lookup` LLM tool plus `/pi-rogue-context` commands by default (legacy `/context` is not registered). To disable the runtime for rollback:

```bash
PI_CONTEXT_BROKER_ENABLED=false pi
```

When active, the bundle registers:

- `/pi-rogue-context status` — enabled state, record/byte counts, pinned counts, routing telemetry, and prompt rewrite savings bytes.
- `/pi-rogue-context brief` — bounded prompt-safe broker brief with handles and summaries.
- `/pi-rogue-context lookup <handle|text>` — exact handle rehydration or current-session text search.
- `/pi-rogue-context pin <handle>` — protect an artifact from normal TTL/cap pruning.
- `/pi-rogue-context export <handle>` — write full payload to a temp file without dumping it into prompt.
- `/pi-rogue-context prune` — run TTL/cap pruning immediately.

The command includes autocomplete for subcommands and known artifact handles. Exact handle lookup returns clipped payload text; text search returns a smaller clipped excerpt, and truncation is marked explicitly. Exact-handle misses and text/filter misses use distinct messages, and `/pi-rogue-context status` reports exact/text miss counters.

Optional durability is available with `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR=/path/to/store`. Durable state directories are created/tightened to owner-only `0700`, and SQLite, sidecar, JSONL metadata, blob, recovery, and shared-state files are created/tightened to `0600` independent of umask. Custom paths must be owned by the current user and must not themselves be symbolic links; insecure pre-existing owner-owned modes are tightened, while links, non-regular targets, and foreign-owned targets are rejected. Do not point multiple OS users at one store directory.

Durable mode now defaults to SQLite (`artifacts.sqlite`) with an FTS index for text lookup, so exact handles, tier, and pin state survive restarts without replay reconstruction. Set `PI_CONTEXT_BROKER_BACKEND=jsonl` to use the legacy JSONL/blob backend. Durable mode applies default global retention caps when env caps are not set: 2,048 records and 256 MiB across sessions.

- `PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES` controls when large `toolResult` / `bashExecution` payloads are rewritten in-context. The default is `8192` bytes; minimum is `2048` bytes.
- `PI_CONTEXT_BROKER_HOT_TO_WARM_MS` controls unpinned artifact cooling from hot to warm. The default is 2 hours.
- `PI_CONTEXT_BROKER_WARM_TO_COLD_MS` controls unpinned artifact cooling from warm/hot to cold. The default is 12 hours.

For more aggressive prompt reduction, set `PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES=2048` (minimum supported value).
For quieter sessions, set it to a higher value to only rewrite larger outputs.

## Tier lifecycle policy

- Publish-time classification remains deterministic: explicit `tier`, `hot`/`warm`/`cold` tags, error tags, completed/archive tags, and artifact kind choose the base tier.
- Cooling only retiers unpinned artifacts for prompt visibility and cap pressure; it does not delete payloads.
- Pinned artifacts stay hot and are retained through compaction cleanup.
- Cold artifacts remain retrievable by exact handle/search, but are excluded from the default prompt brief unless explicitly queried.
- `/compact` / `session_compact` cleanup purges unpinned artifacts for the session; cooling is age-based and separate from compaction cleanup.

## Payload display policy

- Hostile/binary payloads are unsafe or control-heavy. They are stored/exportable but omitted from prompt lookup output with `/pi-rogue-context export` guidance.
- Opaque payloads are printable but low-value/high-token, such as large base64-like blobs, hex dumps, minified single-line output, or compressed-looking text. They are also stored/exportable but omitted from prompt lookup output with `/pi-rogue-context export` guidance.
- Normal code, logs, and test output remain visible subject to normal byte clipping.


## Session behavior and limits

- On session start/reload, the runtime backfills the current Pi session branch from `toolResult` and prompt-visible `bashExecution` entries.
- Backfill is idempotent by session entry id, skips malformed entries instead of failing the session, and honors Pi's `excludeFromContext` bash entries.
- Without durable mode, restarting Pi loses broker state until the current branch is backfilled again.
- Prompt integration injects a bounded, tier-aware broker brief and lookup guidance; the LLM also gets a `context_lookup` tool for exact handle dereferencing. Payloads that hit hostile-binary heuristics are represented in prompt as handles plus short guidance to export the full content.
- The `context` hook rewrites prompt-visible `toolResult` and `bashExecution` payloads in the LLM-bound message copy to broker handles and summaries, reducing prompt load while preserving exact `/pi-rogue-context lookup` rehydration.
- Current-turn `context_lookup` results are left visible so the model can consume requested exact evidence once. Historical `context_lookup` results that already have a later assistant response are omitted from later prompt assembly to avoid recursive prompt growth.
- Pi `excludeFromContext` bash entries are not backfilled or rewritten into broker prompts.
- Basic secret redaction runs before broker storage and display for common token/password/API-key patterns.
- Prompt rewrite threshold defaults to 8192 bytes. Configure it with `/pi-rogue-context config threshold <bytes>` (autocomplete includes common presets), or set `PI_CONTEXT_BROKER_REWRITE_THRESHOLD_BYTES` before startup for an env override.
- Optional global caps can be configured via env vars:
  - `PI_CONTEXT_BROKER_GLOBAL_MAX_RECORDS`
  - `PI_CONTEXT_BROKER_GLOBAL_MAX_BYTES`
- Durable mode defaults to global caps of 2,048 records and 256 MiB when those env vars are unset; in-memory mode remains per-session capped unless global caps are explicitly provided.
- Rollback is immediate: set `PI_CONTEXT_BROKER_ENABLED=false` and `/reload` or restart Pi. Disable durable writes by unsetting `PI_CONTEXT_BROKER_DURABLE` and `PI_CONTEXT_BROKER_STORE_DIR`.
