# Fable 5 prompt adaptation research

Issue: [#139](https://github.com/fiale-plus/pi-rogue/issues/139)  
Source reviewed: <https://github.com/elder-plinius/CL4R1T4S/blob/main/ANTHROPIC/CLAUDE-FABLE-5.md>  
Date: 2026-06-14

## Executive summary

The referenced Fable 5 prompt is useful as a **prompt architecture specimen**, not as text to copy. It is long, product-specific, Anthropic-branded, tool-schema-heavy, and includes many assumptions that do not match pi-rogue's current surfaces or the GPT/Qwen/OSS models we normally run. The practical extraction is a smaller, model-agnostic operating contract:

1. **Stable identity and scope boundaries**: describe pi-rogue as an explicit session-guidance/orchestration extension, not a general assistant persona.
2. **Instruction hierarchy and command discipline**: prefer explicit slash commands, avoid hidden/background-only behavior, preserve user command names, and never claim capabilities not wired into the current session.
3. **Tool-use contract**: be concrete about which tools exist, when to use them, how to validate outputs, and how to handle failures.
4. **Structured work loops**: turn large goals into bounded loops with evidence, check-ins, stop rules, and final proof.
5. **Formatting portability**: use simple Markdown/JSON contracts and short sentinel prefixes where parsing matters; avoid Claude-specific XML-heavy conventions as the only control mechanism.
6. **Safety and uncertainty handling**: explicitly classify unsafe, stale, or uncertain requests; search or ask for clarification rather than inventing product facts.
7. **Model-family overlays**: keep a shared core prompt, then apply small overlays for GPT APIs, Qwen/OSS/local models, and future large open-weight models.

Implementation slice in this PR: keep production defaults unchanged, add this research artifact, portable eval cases (`docs/prompt-evals/fable5-portability-cases.json`), and one opt-in prompt-policy candidate in `packages/core/src/prompt-policy.ts`. The candidate provides a compact universal core, model-family overlays, and a conservative model-family detector without wiring it into runtime defaults.

## Current pi-rogue surfaces affected

This repo does not currently have one global Fable-style prompt. Instead, it modifies or emits targeted prompts around advisor and orchestration features:

| Surface | Path | Current behavior relevant to this research |
|---|---|---|
| Advisor system prompts | `packages/advisor/src/extension.ts` | Defines `ADVISOR_SYSTEM` and `REVIEW_SYSTEM`; both are concise role/task prompts. Review output is JSON-only. |
| Advisor model fallback | `packages/advisor/src/extension.ts` | Resolves a configured `/advisor model <provider>/<model>`, then a SOTA fallback chain, then any available text model. This is where model-family prompt overlays would eventually need capability checks. |
| Advisor preflight injection | `packages/advisor/src/extension.ts` | On `before_agent_start`, appends advisor notes, follow-ups, review signals, session brief, and context-broker brief to the existing system prompt. This is behavioral/security-sensitive because it changes the active agent prompt. |
| Router classifier prompt | `packages/advisor/src/router.ts` | `buildRouterPrompt` asks for JSON-only route labels. This is a good candidate for portable strict-output evals. |
| Goal completion loop | `packages/orchestration/src/goal-resolution.ts`, `goal.ts`, `loop.ts` | Uses sentinel prefixes (`GOAL_DONE`, `GOAL_CONTINUE`) and direct work instructions. This is portable across model families when kept short and tested. |
| Novelty/context prompt injections | `packages/orchestration/src/novelty-guard.ts`, `packages/context-broker/src/extension.ts` | Additional `before_agent_start` system-prompt injections already steer repetition and context-handle behavior. Any universal prompt core must compose with these rather than override them. |
| Model routing profiles | `packages/router/src/config.ts`, `observe.ts`, `outcomes.ts`, `subagents.ts` | Profiles already distinguish GPT/frontier-style models from local Qwen-style workers (`local-smart` uses `qwen3.6-35b-a3b-128k`). This is the natural future home for model-family overlays/capability flags. |
| Published command surface | `README.md`, package READMEs, skill files | Commands are explicit (`/advisor`, `/goal`, `/loop`, `/autoresearch`, `/autoresearch-lab`). Repo instructions say to avoid expanding command surfaces without request. |

Implication: pi-rogue should not import a monolithic system prompt. The natural fit is a **prompt policy document + eval suite + opt-in prompt candidate first**, then runtime wiring only after cross-model evidence exists.

## What the Fable 5 prompt contains

The source prompt is organized into large policy and capability sections:

- Product/identity information and product-search fallback.
- Refusal and sensitive-domain guidance.
- Tone, formatting, evenhandedness, mistake handling, and knowledge-cutoff handling.
- Memory and persistent artifact storage rules.
- MCP/app connector suggestions and opt-in behavior.
- Computer-use guidance, file handling, artifacts, package management, and output sharing.
- Search instructions, copyright constraints, and web-fetch/search tool schemas.
- Image search, maps/weather/sports/recipe/message/file tools.
- Citation instructions, user context, available skills, network configuration, and filesystem configuration.

This is closer to a full hosted-assistant runtime contract than a reusable open-source prompt. The useful part is the decomposition: **identity → user-facing behavior → tool contracts → safety/citations → environment limits → output schemas**.

## Portable patterns worth extracting

### 1. Explicit capability inventory

Fable-style prompts repeatedly say what the assistant can and cannot access. pi-rogue should do the same, but from live extension state where possible:

- Current slash commands.
- Available tools and subagents.
- Whether web/search/model-registry features are available.
- Current filesystem/worktree constraints.
- Whether advisor/goal/loop/autoresearch state is active.

Portable value: high for GPT, Qwen, and OSS. Smaller/local models especially benefit from short, concrete capability lists.

### 2. Positive and negative examples

The prompt uses concrete examples for tool usage, formatting, and when not to act. pi-rogue should use examples sparingly in prompts that are parsed or safety-sensitive:

- Good: one JSON-only router example, one `GOAL_DONE` / `GOAL_CONTINUE` example, one explicit “do not create a new task” check-in example.
- Bad: long conversational examples embedded in every request, which can crowd out task context on local models.

Portable value: high, but token-budget-sensitive for Qwen/OSS.

### 3. Search-before-answer for stale product facts

The source prompt tells Claude to search official docs before answering about product details. For pi-rogue, the generalized rule is:

> If answering about external products, APIs, package releases, or fast-changing model capabilities, use web/code search or state that the answer may be stale.

Portable value: high. This should be a universal rule, not Anthropic-specific.

### 4. Structured tool contracts and failure handling

Fable spends many tokens on tool schemas and examples. pi already supplies tool schemas, so pi-rogue should avoid duplicating them. What should transfer is a short operational policy:

- Use read-only inspection before edits.
- Prefer exact file reads over shell `cat`.
- Validate after changes.
- Report commands run and residual risks.
- On tool failure, retry only when the failure is actionable; otherwise ask or stop.

Portable value: high. This aligns with existing repo guidance.

### 5. Bounded agentic loops

The source prompt encodes long-running work patterns around research, artifacts, and tool use. pi-rogue already has `/goal`, `/loop`, and `/autoresearch`. The extraction is not another hidden loop; it is a clearer contract for loops:

- A goal has acceptance criteria.
- A loop has an interval/instruction.
- Each iteration must either gather evidence, change files, run validation, or stop.
- Finalization needs explicit evidence.

Portable value: high, especially for OSS models that otherwise drift into summaries.

### 6. Concise parseable outputs for control surfaces

Fable uses rich tags and tool schemas. pi-rogue should favor minimal parseable contracts:

- JSON-only for classifier/reviewer internals.
- Sentinel prefixes for goal resolution.
- Markdown summaries for user-facing work.

Portable value: high. JSON and sentinel prefixes are more universal than nested XML/tag grammars.

## Claude-specific or risky patterns to avoid

| Pattern | Why not copy | Safer pi-rogue alternative |
|---|---|---|
| Anthropic/Claude identity and product facts | Wrong for GPT, Qwen, and OSS; likely stale or fictional in the source. | Describe pi-rogue extension state, not model vendor identity. |
| Hosted-product tools and schemas | Pi has its own tool schemas; duplicated schemas can conflict with runtime-provided schemas. | Rely on pi tool definitions and add only high-level tool-use policy. |
| Claude-specific XML prompting as a required convention | GPT often handles it; Qwen/OSS can overfit or leak tags; parse failures are costly. | Use Markdown for humans, JSON/sentinels for parsers. |
| Long monolithic system prompt | Local models lose instruction salience and context budget; all models become harder to evaluate. | Shared compact core + overlays + per-command prompts. |
| Hidden memory/artifact assumptions | pi memory/context-broker behavior is explicit and environment-dependent. | State only active memory/context mechanisms and cite `ctx://` handles when used. |
| Product-specific safety posture | Safety wording may not match pi-rogue, coding workflows, or model providers. | Use repo/task safety: no force-push/merge without consent, avoid unrelated changes, validate code, clarify unsafe requests. |
| “Always use tool X” clauses from another runtime | Can cause impossible tool calls and hallucinated capabilities. | “Use available tools when they materially improve correctness.” |

## Target model-family analysis

### GPT-family APIs

Expected strengths:

- Strong instruction hierarchy and structured-output adherence.
- Good JSON and tool-call discipline when prompts are short and explicit.
- Handles role/policy separation well.

Risks:

- Can be over-eager with agentic work if the prompt sounds like a hosted assistant mandate.
- May follow verbose persona/tone sections over repo-local constraints if prompt order is poor.

Overlay guidance:

- Keep core prompt concise.
- Put parseable output requirements last and unambiguous.
- Use “do not expand scope / do not merge” constraints explicitly.
- Prefer JSON schema/tool-native controls where the provider supports them.

### Qwen/OSS-family local models

Expected strengths:

- Good coding and command-following at sufficient scale.
- Often cost-effective for review, summarization, routing, and bounded implementation.

Risks:

- More sensitive to long prompts and conflicting examples.
- Can be weaker at strict JSON, hierarchy retention, and resisting tool hallucination.
- Some variants need chat-template-specific role formatting rather than elaborate in-band policy text.

Overlay guidance:

- Use shorter instructions with numbered rules.
- Repeat only the critical parse contract near the output point.
- Avoid nested XML conventions unless directly tested.
- Include negative capability statements: “If a tool is not listed, do not claim to use it.”
- Use narrower tasks and smaller validation loops.

### Future larger open-weight SOTA models (GLM/MiniMax class)

Expected strengths:

- May approach GPT/Claude-level long-context instruction following.
- Better candidates for full research/review loops and multi-file planning.

Risks:

- Provider/server templates and tool-call protocols differ.
- Safety and refusal defaults vary widely.
- Benchmarks can regress after quantization or local serving changes.

Overlay guidance:

- Treat as capability-flagged variants, not as one “OSS” bucket.
- Evaluate strict JSON, tool discipline, safety boundary, and long-loop persistence before enabling broad orchestration.
- Keep fallbacks conservative until eval evidence exists.

## Recommended prompt architecture for pi-rogue

Use three layers:

1. **Universal core**
   - Identity: “pi-rogue session guidance/orchestration extension.”
   - Scope: advisor + goal/loop/autoresearch surfaces.
   - Non-negotiables: no merge without explicit approval; do not rename commands; prefer explicit commands; protect unrelated changes; validate edits.
   - Tool discipline: inspect before edit, exact file reads, run checks, cite files/commands.
   - Output discipline: concise final reports with validation and risks.

2. **Model-family overlay**
   - GPT: rely on structured outputs and longer reasoning tasks when needed.
   - Qwen/OSS: shorten, number, avoid XML, restate parse contract at end.
   - Future SOTA OSS: enable only after eval gates pass.

3. **Command/task prompt**
   - `/advisor`: terse strategic advice, not task creation.
   - Router: JSON-only classifier.
   - Goal/loop: sentinel result plus immediate action.
   - Autoresearch: evidence-first research loop with stop rules.

Do not apply the universal core globally until the eval cases pass across the configured model matrix. The next code PR should introduce a small prompt-policy module only if a concrete caller needs it.

## Eval plan

The repo now includes `docs/prompt-evals/fable5-portability-cases.json` with portable test cases. The cases are intentionally model-agnostic and can be used manually, by a future script, or by an external model harness.

Minimum model matrix before production prompt changes:

| Family | Example target | Required evidence |
|---|---|---|
| GPT | configured GPT/Codex text model | JSON validity, command discipline, no hidden merge/scope expansion. |
| Qwen/OSS | primary local Qwen/OSS chat model | Same cases, plus context-length sensitivity and no tool hallucination. |
| Future OSS SOTA | GLM/MiniMax-class when available | Same gates before enabling broader overlay. |

Pass criteria per case:

- Required output shape is followed.
- No unavailable tools or commands are invented.
- User/repo constraints are preserved.
- The answer either takes an evidence-producing action or asks a justified clarifying question.
- Safety/permission boundaries are respected.

## Implementation guidance

This PR now includes the first two implementation steps as opt-in, non-runtime-default scaffolding:

1. `packages/core/src/prompt-policy.ts` exports `buildPiRogueSystemPromptV1`, a compact universal prompt candidate plus model-family overlays.
2. `detectPiRoguePromptFamily` maps provider/model IDs to coarse families (`gpt`, `qwen_oss`, `open_weight_sota`, `unknown`) using conservative pattern matching.
3. `packages/core/src/prompt-policy.test.ts` guards the current GPT, Qwen/OSS, future open-weight, and unknown-family behavior and checks that the candidate does not leak Claude/Fable vendor persona text.

Recommended next steps after this PR:

1. Add a prompt-preview/dev command before changing live prompt injection.
2. Run the eval cases across the configured models and commit outputs under `docs/benchmark-evidence/` only when they are reproducible and reviewed.
3. Only then consider updating `ADVISOR_SYSTEM`, `REVIEW_SYSTEM`, router prompts, or goal-loop prompts to consume `buildPiRogueSystemPromptV1` or a successor.

## Decision

For issue #139, the safe universal extraction is **not** “make pi-rogue speak like Claude Fable 5.” It is:

- document the portable design principles,
- avoid vendor/runtime-specific text,
- add model-family eval cases,
- provide one opt-in universal prompt candidate and family overlay helper,
- defer production default prompt changes until GPT and Qwen/OSS evidence exists.
