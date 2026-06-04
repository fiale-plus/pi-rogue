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
| Cold | Historical branch notes, archived raw logs, completed task artifacts. | Not included unless explicitly looked up. | Global byte cap with LRU pruning unless pinned. |

The broker should cap by actual bytes on disk, not only record count. A record-count cap can keep metadata scans cheap, but byte caps prevent hidden disk growth.

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

SQLite with FTS is preferred for fast lookup. JSONL remains useful as an append-only recovery ledger and for simple debugging.

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

1. Expired unpinned warm records.
2. Oldest unpinned cold records.
3. Duplicate blobs by content hash.
4. Oversized raw payloads after preserving summaries and metadata.

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

This PR now includes a first narrow implementation slice in `@fiale-plus/pi-core`:

- `BoundedContextBroker` defines the publish, lookup, pin, prune, status, and prompt-brief contract.
- `createInMemoryContextBroker` provides an in-process bounded broker for tests, prototypes, and future extension wiring.
- The in-memory broker supports stable `ctx://...` handles, byte and record caps, TTL pruning, pinned artifacts, and lookup by handle, session, kind, tag, path, command prefix, branch, and text.
- This slice is intentionally non-persistent. Durable SQLite/blob storage remains a later phase.

## Integration plan

### Phase 1: proposal and audit

- Document current extension stack and gaps.
- Define broker storage, lookup, and retention mechanics.
- Keep guardrails out of scope.

### Phase 2: brain retention discipline

- Add caps to `packages/brain` for tracked sessions and roadmap entries.
- Record context handles in brain commits instead of raw evidence text.
- Add status output that reports memory size, session count, and last prune.

### Phase 3: broker storage and lookup

- Add a `packages/context-broker` package or a narrow extension module.
- Capture large tool outputs, diffs, and subagent results into artifacts.
- Provide `/context status`, `/context lookup`, `/context pin`, and `/context prune`.
- Feed a compact broker brief into advisor and brain prompts.

### Phase 4: cheap routing advisor

- Add optional local-model routing advice.
- Cache routing decisions by payload hash.
- Log model advice and deterministic fallback decisions for debugging.

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
