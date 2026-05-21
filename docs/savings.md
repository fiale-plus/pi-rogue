# Session savings with context-mode

Reference data from real `pi-fiale-plus` development sessions.

## This session

| Metric | Value |
|---|---|
| Session duration | 2h 22m |
| Total conversation | ~133 KB (~33,250 tokens) |
| With context-mode | ~14.7 KB (~3,675 tokens) |
| **Tokens kept out of context** | **~30,300 (88.9% reduction)** |
| Lifetime sessions tracked | 7 (922 events) |

## Cost comparison

Pricing simplified: GPT-5.5 for full context, GPT-5.4-mini for what passes through context-mode.

| Scenario | Input tokens | Rate | Cost |
|---|---|---|---|
| Without context-mode (GPT-5.5) | ~33,250 | $15/M tokens | ~$0.50 |
| With context-mode (GPT-5.4-mini) | ~3,675 | $3/M tokens | ~$0.01 |
| **Savings per session** | | | **~$0.49 (98%)** |

| Lifetime (7 sessions) | | |
|---|---|---|
| Without context-mode (GPT-5.5) | ~232,750 tokens | ~$3.50 |
| With context-mode (GPT-5.4-mini) | ~25,725 tokens | ~$0.08 |
| **Lifetime savings** | | **~$3.42** |

## How it works

[context-mode](https://github.com/mksglu/context-mode) indexes tool output (Bash, Read, Write, Edit, etc.) into a local FTS5 database. Instead of sending full output to the LLM, only a summary enters context — the raw data stays in the sandbox and is retrieved on demand via `ctx_search`.

**88.9% context reduction** means sessions last ~9× longer before compaction kicks in.

## Per-tool savings

| Tool | Calls | KB saved |
|---|---|---|
| `ctx_batch_execute` | 5 | 61.9 |
| `ctx_search` | 1 | 37.0 |
| `ctx_execute` | 5 | 14.5 |
| `ctx_index` | 4 | 5.6 |
| **Total** | **15** | **119.0** |
