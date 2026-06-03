# Session savings with context-mode and advisor

Reference data from real `pi-fiale-plus` development sessions.

## context-mode savings (this session)

context-mode indexes tool output into a local FTS5 database, sending only summaries to the LLM instead of full raw output.

For the proposed next layer that turns this into bounded storage, stable handles, and fast lookup mechanics, see [Context footprint broker proposal](context-footprint-broker.md).

| Metric | Value |
|---|---|
| Session duration | 2h 22m |
| Total conversation | ~133 KB (~33,250 tokens) |
| With context-mode | ~14.7 KB (~3,675 tokens) |
| **Tokens kept out of context** | **~30,300 (88.9% reduction)** |
| Lifetime sessions tracked | 7 (922 events) |

### Cost: GPT-5.5 vs GPT-5.4-mini

| Scenario | Tokens | Rate | Cost |
|---|---|---|---|
| Without context-mode (GPT-5.5) | ~33,250 | $15/M input | ~$0.50 |
| With context-mode (GPT-5.4-mini) | ~3,675 | $3/M input | ~$0.01 |
| **Savings per session** | | | **~$0.49 (98%)** |

### Per-tool breakdown

| Tool | Calls | KB saved |
|---|---|---|
| `ctx_batch_execute` | 5 | 61.9 |
| `ctx_search` | 1 | 37.0 |
| `ctx_execute` | 5 | 14.5 |
| `ctx_index` | 4 | 5.6 |
| **Total** | **15** | **119.0** |

---

## Advisor routing savings (lifetime)

Advisor replaces every-turn GPT-5.5 calls with a mix: GPT-5.5 only for strategic advisor/review calls, GPT-5.4-nano for everything else.

### Usage stats

| Metric | Value |
|---|---|
| Advisor calls (cached) | 52 unique |
| Review calls (cached) | 44 unique |
| Advisor output tokens | ~24,590 (~473 avg/call) |
| Review output tokens | ~7,509 (~171 avg/call) |
| Total turns in tracked sessions | 3,071 |
| Total session IDs tracked | 7,189 |

### Scenario comparison

Pricing used: GPT-5.5 ($15/M in, $60/M out), GPT-5.4-nano ($1/M in, $4/M out).

| Scenario | Input cost | Output cost | **Total** |
|---|---|---|---|
| **All on GPT-5.5** (no advisor) | $23.03 | $36.85 | **$59.88** |
| GPT-5.5 for 52 advisor calls | $0.73 | $1.93 | $2.66 |
| GPT-5.4-nano for 3,071 baseline turns | $1.49 | $2.33 | $3.82 |
| **With advisor routing** | $2.22 | $4.26 | **$6.47** |

**Savings: $53.41 (89.2%)** vs running everything on GPT-5.5.

### What the advisor budget buys

The ~$2.66 spent on GPT-5.5 advisor calls buys:
- 52 architectural/strategic recommendations
- 44 post-review assessments
- Cache deduplication (identical questions don't re-fire)
- Session-aware context (brief, recent files, errors)

Without advisor routing, every one of the 3,071 turns would pay GPT-5.5 prices regardless of whether it's a strategic decision or a mechanical edit.

### How it works

```
         ┌─────────────────────────┐
         │  User asks a question   │
         └─────────────────────────┘
                     │
         ┌──────────▼──────────┐
         │  before_agent_start  │
         │  (preflight)         │
         │  inject advisor      │
         │  instructions +      │
         │  session brief       │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  Agent runs on       │
         │  GPT-5.4-nano        │
         │  (model default)     │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  Advisor tool called?│
         │  ──► GPT-5.5 for    │
         │     strategic advice │
         │  ──► cached? return  │
         │     cached result    │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  turn_end / agent_end│
         │  post-review on      │
         │  GPT-5.5 (light:     │
         │  only on changes)    │
         └─────────────────────┘
```
