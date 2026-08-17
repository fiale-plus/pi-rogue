# @fiale-plus/pi-rogue

`@fiale-plus/pi-rogue` is the **single consolidated public artifact** for Pi-Rogue. It bundles the shared `@fiale-plus/pi-core` helpers and the internal `@fiale-plus/pi-rogue-advisor` extension. Direct leaf-package releases remain paused; users install this artifact.

## Install

```bash
pi install npm:@fiale-plus/pi-rogue
```

Requires `@earendil-works/pi-coding-agent >=0.80.6 <0.81.0` and Node.js `>=22.19.0`.

For local monorepo development:

```bash
npm install
```

The published artifact is loaded through Pi's TypeScript package loader. Its `.ts` entrypoint is not a generic plain-Node JavaScript/declaration contract; Pi loads the extension and bundled Advisor skill through the package metadata.

## Supported surface

The bundle registers only these command roots:

1. `/pi-rogue` — `status`, `help`, `doctor`, and explicit local `closeout` evidence bookkeeping.
2. `/pi-rogue-advisor` — explicit Advisor and Board status, model selection, specialist calls, Head-of-Board calls, and one-shot questions.

The `advisor` tool is also explicit. Registering the bundle does not start model work.

### Advisor and Board commands

```text
/pi-rogue status
/pi-rogue closeout start [summary]
/pi-rogue closeout add-evidence <handle|path|note>
/pi-rogue closeout record success|partial|failed|abandoned
/pi-rogue closeout show|export
/pi-rogue-advisor status
/pi-rogue-advisor settings
/pi-rogue-advisor model list [advisor|specialist|head]
/pi-rogue-advisor model [advisor|specialist|head] <provider>/<model>|null
/pi-rogue-advisor board watch status|off|shadow|intervene
/pi-rogue-advisor board watch head status|on|off
/pi-rogue-advisor board specialist status
/pi-rogue-advisor board specialist suggest
/pi-rogue-advisor board specialist ask <role-id> <task>
/pi-rogue-advisor board head status
/pi-rogue-advisor board head ask <decision question>
/pi-rogue-advisor <question>
```

The built-in specialist roles are `reviewer`, `security`, `architecture`, `debugger`, and `reliability-perf`. They use read/search-only tools, compact sanitized ledger input, and suggest-only output. Head-of-Board receives the compact Board ledger, is read-only, and is bounded by token, time, and call limits. Neither role can edit files, execute commands, dispatch another role, or change Pi state.

## Model map and bounds

Advisor configuration keeps three independent model slots:

```json
{
  "models": {
    "advisor": null,
    "specialist": null,
    "head": null
  },
  "board": {
    "specialists": "suggest",
    "maxSpecialistCalls": 3,
    "specialistMaxTokens": 900,
    "headMaxTokens": 1200
  }
}
```

`null` means bounded role-appropriate selection from authenticated compatible text models. `model list` shows the available catalog, selected/recommended candidate per role, and model facts including reasoning support, context window, token limit, and declared input/output cost—without making an LLM call. The policy is explainable rather than a universal quality claim: Advisor balances quality, specialists prefer efficiency, and Head prefers reasoning/context. Explicit values override discovery; unavailable or unauthenticated overrides are retained but warned about. Resolution stops after the explicit model and at most one preferred fallback. It never scans an unbounded provider list and never changes Pi's global active model.

The active **main Pi model is owned by Pi**, not this package. A cheap/fast starting point is often `pi --model openrouter/deepseek/deepseek-v4-flash` when that provider is authenticated; check `/list-models` for the current registry. Provider prices and model IDs change. `/pi-rogue-advisor status` reports the active Pi model alongside the independent Advisor, specialist, and Head slots.

## Zero-background-call guarantee

The deterministic Board watcher runs in `shadow` mode by default and makes zero model calls. `intervene` mode can queue a visible, non-binding next-turn Board suggestion without triggering a turn, changing the active model, or mutating the workspace. Head escalation is separately disabled by default and can be enabled explicitly. Closeout lifecycle collection snapshots bounded local facts only after a user starts a closeout. The regular Advisor, specialists, and explicit Head remain on-demand; automatic Head escalation is bounded, read-only, deduplicated, and fail-closed.

## Release status

- **Published:** yes, as the single public artifact.
- **Direct Advisor package releases:** paused; the leaf package is internal and bundled here.
- **Legacy package names:** retained only as deprecation/tombstone tracks where applicable.

Only `pi-rogue-<semver>` tags and releases are produced. See [`docs/release.md`](../../docs/release.md) for the canonical policy and packed smoke verification.
