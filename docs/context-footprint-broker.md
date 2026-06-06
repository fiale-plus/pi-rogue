# Context footprint broker proposal

This proposal separates context growth minimization from guardrails. Guardrails decide whether an operation is allowed. The context broker decides what stays in the live model prompt, what is offloaded, how it is indexed, and how it can be looked up later.

## Goals

- Keep the active model prompt small by default.
- Preserve large payloads for later lookup without pasting them into every turn.
- Make retrieval fast enough for normal agent loops.
- Keep storage bounded by byte caps, record caps, and retention policy.
- Prefer explicit handles over raw transcript replay.
- Let a cheap local model advise routing decisions, without making it the only source of truth.

## Current baseline

Pi already has useful pieces, but they are not coordinated as a first-class context system.

| Piece | Current value | Gap |
|---|---|---|
| `context-mode` | Stores tool output externally and sends compact summaries plus evidence IDs. `docs/savings.md` measured ~88.9% prompt reduction in one real session. | Not owned by Pi-Rogue and not integrated with memory retention, payload caps, or commandable lookup. |
| `packages/brain` | Tracks active branch, last commit, sessions, and branch notes. It already tells agents to cite context-mode evidence IDs. | `state.sessions`, branch docs, and roadmap entries are append-only and do not define bounded retention. |
| `repo-arch` | Provides repository-level knowledge and lookup. | Focused on repo structure, not transient session payloads, command outputs, approvals, or tool deltas. |
| `pi-subagents` | Can isolate work into separate agent contexts. | Subagent results still need a compact artifact contract so parent prompts do not absorb full child transcripts. |
| Advisor extensions | Existing local advisor patterns use capped message windows and cheap models for review/routing. | Advisor context is still assembled ad hoc rather than supplied by a broker with stable handles. |
| Pi compaction | User config keeps recent tokens and reserves compaction budget. | Compaction is reactive after context growth, not proactive payload routing. |

The missing layer is a context broker that owns artifact storage, indexing, live prompt budgeting, and lookup handles.

## Community patterns to preserve

Research from current agent tools points to a few useful patterns:

- VS Code Copilot treats autonomy and context budget together: higher autonomy requires tighter context discipline and explicit approval policy.
- Copilot approval UX supports scopes such as session, workspace, and always, plus exact or prefix command matching. That is useful inspiration for lifetimes, but approval mechanics stay outside this proposal.
- Claude Code supports session resume and compaction. The broker should make resume explicit by storing durable handles, not just relying on transcript reconstruction.
- Cursor separates mode behavior. Pi-Rogue should similarly keep context commands explicit instead of hiding broker decisions behind unrelated flows.
- Pi extension hooks can inspect tool calls and session state, but sibling tool calls may run concurrently. Broker writes need atomic append or per-session locking.

## Proposed design

Introduce a `context-broker` layer with three outputs:

- A small live prompt brief.
- Stable lookup handles for offloaded artifacts.
- A bounded local store for raw payloads and summaries.

The broker stores payloads outside the model prompt and returns compact records like:

```text
ctx://session/2026-06-03T18-55-00Z/tool/npm-test/sha256-4f7c...
kind=tool_output bytes=84231 summary="npm test passed; 2 suites; no failures"
tags=test,packages/orchestration
expires=2026-06-10T18:55:00Z
```

Agents should cite handles in memory, advisor briefs, and final summaries instead of replaying full logs.

## Storage tiers

| Tier | Contents | Prompt behavior | Retention |
|---|---|---|---|
| Hot | Current goal, recent user constraints, active files, latest failures, pinned handles. | Always eligible for prompt brief. | Small count cap and token cap. |
| Warm | Recent command outputs, diffs, screenshots, dependency logs, subagent artifacts. | Summaries and handles only. Raw payload retrieved on demand. | Session TTL and byte cap. |
| Cold | Historical branch notes, archived raw logs, completed task artifacts. | Not included in default briefs unless explicitly queried; exact lookup remains available. | Global/session byte cap with LRU pruning unless pinned. |

The broker classifies every artifact as `hot`, `warm`, or `cold` on publish. Explicit `tier` input wins, pinned artifacts are hot, failed/error-tagged tool outputs are hot, normal tool outputs are warm, and archived/completed artifacts are cold. The broker caps by actual bytes, not only record count. A record-count cap can keep metadata scans cheap, but byte caps prevent hidden disk growth.

## Data model

Use append-friendly metadata plus content-addressed blobs.

```ts
interface ContextArtifact {
  id: string;
  sessionId: string;
  kind: "tool_output" | "diff" | "file_snapshot" | "subagent_result" | "advisor_brief" | "memory_note";
  createdAt: string;
  updatedAt: string;
  bytes: number;
  sha256: string;
  blobPath: string;
  summary: string;
  tags: string[];
  paths: string[];
  command?: string;
  branch?: string;
  tier: "hot" | "warm" | "cold";
  ttl?: string;
  pinned?: boolean;
  parentIds?: string[];
}
```

Suggested files under `~/.pi/agent/fiale-plus/context-broker/`:

- `artifacts.sqlite`: metadata, FTS index, tags, path mappings, parent links.
- `blobs/<sha256-prefix>/<sha256>`: raw payloads.
- `sessions/<session-id>/events.jsonl`: append-only event log for recovery and audit.
- `summaries/<artifact-id>.md`: human-readable compact summaries for quick reads.

The shipped durable backend uses `artifacts.sqlite` with FTS for fast text lookup. JSONL remains available as a legacy/debug backend via `PI_CONTEXT_BROKER_BACKEND=jsonl`.

## Lookup mechanics

Lookup should support cheap deterministic filters before semantic expansion:

- `id`: exact handle lookup.
- `session`: current session, branch session, or all sessions.
- `kind`: tool output, diff, subagent result, advisor brief, memory note.
- `path`: file or directory touched.
- `command`: exact or normalized command prefix.
- `tag`: user or broker-assigned labels.
- `time`: since, until, last N.
- `text`: FTS search over summaries and selected raw payload excerpts.

The default query path should be:

1. Exact handle match.
2. Current-session metadata filter.
3. FTS over summaries.
4. Optional raw payload scan only for narrowed candidates.

This keeps common lookups fast and avoids resurrecting large blobs into context accidentally.

## Prompt contract

The broker should inject a compact brief instead of raw history:

```text
## Context Broker
Budget: 1800 tokens
Hot:
- Current goal: ...
- Active constraints: ...
- Last failure: ctx://... summary=...
Pinned:
- ctx://... summary=...
Lookup: use /context lookup or broker lookup tool before asking the user to repeat data.
Rule: never paste raw broker payloads unless the user asks or the payload is below the inline threshold.
```

Inline thresholds should be small and explicit. For example, inline summaries under 2 KB, but keep raw payloads as handles unless requested.

### Advisor and brain consumption

Advisor and brain should consume the broker brief as their default context substrate instead of rebuilding large ad hoc transcript excerpts:

```text
## Context Broker
- ctx://session/<session>/<kind>/<sha>/<id> kind=tool_output bytes=84231 summary="npm test passed; 2 suites; no failures"
Lookup: use broker lookup by handle/path/tag/kind/session before asking the user to repeat data.
Rule: do not paste raw broker payloads into advisor or brain prompts unless explicitly requested or below the inline threshold.
```

This is efficient for advisor usage because the advisor usually needs to triage task state, risk, failures, and decisions, not reread every raw log line. The brief should include enough metadata for routing and review: handle, kind, session/origin, byte count, hash prefix, paths/tags, and a concise summary or metadata-only placeholder.

The quality contract is lookup-first rather than summary-only. If advisor or brain needs exact evidence, diffs, error text, or payload-specific wording, it should dereference the handle and work from the retrieved artifact. Missing or expired handles must be reported explicitly instead of asking the user to repeat context by default.

## Retention and caps

Suggested defaults:

| Cap | Default | Reason |
|---|---:|---|
| Live broker brief | 1,500-2,500 tokens | Fits in normal system/context prelude without dominating the turn. |
| Hot artifacts | 32 records | Keeps current work visible. |
| Warm artifacts per session | 256 records or 128 MB | Covers normal command-heavy sessions. |
| Global broker store | 2-5 GB | Large enough for logs, bounded enough for laptops. |
| Unpinned warm TTL | 7 days | Enough to recover recent work. |
| Cold unpinned TTL | 30 days | Enough for follow-up PRs without indefinite growth. |

Pruning order:

1. Expired unpinned records by tier TTL.
2. Tier-specific caps, oldest unpinned cold records first, then warm, then hot.
3. Overall per-session caps using the same cold→warm→hot removal priority.
4. Duplicate blobs by content hash.
5. Oversized raw payloads after preserving summaries and metadata.

Pinned artifacts survive normal TTL pruning but still count toward a visible pinned-byte budget.

## Cheap model routing

A small local model can advise how to route new payloads:

```text
store_raw=true
summary_level=brief
tags=test,package:orchestration
ttl=7d
prompt_include=false
reason="large test output; passing; summary and handle are enough"
```

The model should be advisory only. Deterministic rules remain the fallback:

- Payload below inline threshold: summarize and optionally inline.
- Payload above threshold: store raw, create summary, return handle.
- Failed command: hot summary plus handle.
- Passing command: warm summary plus handle.
- Diff or file snapshot: store as artifact and link touched paths.
- User-pinned item: keep hot or warm until explicitly unpinned.

This keeps routing lightning fast and prevents a weak model from losing important state.

## Implementation status

The current implementation is split across a shared contract package and a runtime package:

- `@fiale-plus/pi-core` owns the `BoundedContextBroker` contract and shared artifact/query/status types.
- `@fiale-plus/pi-rogue-context-broker` owns `createInMemoryContextBroker`, the executable in-process bounded broker for tests and extension wiring.
- The in-memory and durable brokers support stable `ctx://...` handles, per-session byte/record caps, optional global cross-session caps, TTL pruning on reads, pinned artifacts, and lookup by handle, session, kind, tag, path, command prefix, branch, and text.
- Omitted summaries render as metadata-only placeholders so raw payload text is not injected into prompt briefs by default.
- The bundle registers the context broker by default in mainline. Rollback is `PI_CONTEXT_BROKER_ENABLED=false` followed by `/reload` or restart.
- Bundle consumers can explicitly import the runtime from `@fiale-plus/pi-rogue-bundle/context-broker`; the private leaf package is not a separate public install target.
- The command surface registers `/context status`, `/context brief`, `/context lookup <handle|text>`, `/context pin <handle>`, `/context export <handle>`, and `/context prune` with autocomplete, plus an LLM-callable `context_lookup` tool for exact handle dereferencing.
- On reload/session start, the runtime backfills the current session branch from `toolResult` and prompt-visible `bashExecution` entries, deduped by session entry id, tolerant of malformed entries, and honoring Pi's `excludeFromContext` bash entries.
- Prompt integration injects a bounded broker brief and uses the `context` hook to rewrite prompt-visible `toolResult` and `bashExecution` payloads to broker handles/summaries by default while preserving exact lookup.
- Optional durability via `PI_CONTEXT_BROKER_DURABLE=true` or `PI_CONTEXT_BROKER_STORE_DIR` stores SQLite metadata/payloads with FTS so lookup handles, tier, and pin state survive restarts without replay reconstruction. SQLite is loaded lazily only when durable SQLite is selected; the legacy JSONL/blob backend remains selectable with `PI_CONTEXT_BROKER_BACKEND=jsonl`.
- Common token/password/API-key patterns are redacted before broker storage and display; hostile/binary payloads remain export-only for prompt-facing lookup output; `excludeFromContext` bash entries are not brokered into prompts.

## Priority roadmap

### 1. Prompt-load replacement hardening

- Keep default-on rollout guarded by `PI_CONTEXT_BROKER_ENABLED=false` rollback.
- Keep end-to-end smoke coverage for reload, context assembly, lookup fidelity, durable restart, and rollback.
- Continue expanding replacement policies beyond size-only thresholds as routing telemetry accumulates.

### 2. Runtime artifact capture

- Capture large tool outputs, test logs, diffs, file snapshots, advisor briefs, brain notes, and subagent results.
- Store raw payloads behind handles; inject only summaries, metadata, and handles into live prompts.
- Preserve deterministic routing defaults before adding model advice.
- Integrate with Pi session files deliberately: raw session files remain intact, but LLM-bound message copies can be rewritten by the `context` hook so the model sees broker summaries/handles while raw payload remains retrievable from broker storage.
- Continue measuring prompt-size savings from rewritten tool payloads during mainline rollout.

### 3. Advisor and brain integration

- Feed `renderBrief()` output into advisor and brain prompts. The bundle registers the context broker before advisor/orchestration, and the main agent has a `context_lookup` tool.
- Replace large hand-assembled transcript excerpts inside advisor/brain internals with broker handles and summaries.
- Require advisor/brain flows to dereference handles before asking the user to repeat data or before making evidence-sensitive claims.
- Track lookup frequency, missing-handle frequency, and answer quality during rollout.

### 4. Durable storage and resume

- SQLite metadata/payload storage with FTS is implemented for the durable backend.
- Still missing: separate blob files by SHA-256, summary sidecar files, and session event JSONL audit logs.
- Add per-session locking or atomic append for concurrent tool calls.
- Make session resume reconstruct briefs from durable handles instead of transcript replay across branch boundaries.
- Persist broker metadata as custom entries or sidecar JSONL only after defining branch/resume semantics; `CustomEntry` does not enter LLM context, while `CustomMessageEntry` does.

### 5. Retrieval quality and safety

- Add FTS over summaries and selected safe excerpts.
- Add secret redaction before indexing and before display.
- Keep binary/unknown payloads metadata-only by default.
- Add prompt-injection tests for hostile raw payloads stored behind handles.

### 6. Payload routing model

- Collect broker routing logs first: size, kind, command, tags, summary source, prompt inclusion, TTL, and outcome.
- Train a separate payload-routing classifier only after enough labeled examples exist.
- Keep deterministic caps, secret checks, and user pins authoritative over model advice.

## Hidden issues

- Disk growth can hide in blobs even when metadata count looks small. Caps must calculate real byte usage.
- Context compaction can hide important handles if the broker brief is not regenerated each turn.
- Concurrent tool calls can race when writing session events. Use atomic writes or a per-session lock.
- Raw payload lookup can leak secrets. Integrate with secret-redaction tools before indexing and before display.
- Cross-session lookup can expose unrelated task context. Default to current session unless the user asks wider.
- Large binary payloads should be stored by hash and summarized as metadata only.
- Summaries can drift from raw payloads. Store summary generation time, model/rule source, and payload hash.
- Restore-like artifacts need explicit TTLs and byte caps so recovery data does not become unbounded.

## Acceptance criteria for an implementation PR

- Live prompt contains bounded broker summaries and handles, not raw large payloads.
- Lookup by handle, path, tag, kind, and current session works without scanning all raw blobs.
- Store pruning enforces both byte and record caps.
- Pinned artifacts are visible in status and protected from normal TTL pruning.
- Brain and advisor consume broker briefs instead of assembling large ad hoc context.
- Tests cover pruning order, exact-handle lookup, concurrent writes, and prompt-size limits.
