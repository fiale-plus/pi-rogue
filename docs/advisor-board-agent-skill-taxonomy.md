# Advisor Board agent/skill taxonomy

**Status:** Accepted for Advisor Board planning  
**Issue:** [#219](https://github.com/fiale-plus/pi-rogue/issues/219)  
**Parent:** [#218](https://github.com/fiale-plus/pi-rogue/issues/218)  
**Related:** [#101](https://github.com/fiale-plus/pi-rogue/issues/101), [#217](https://github.com/fiale-plus/pi-rogue/issues/217)

## Context

Advisor Board introduces a navigator/co-driver, read-only specialists, and an expensive head-of-board advisor. Without a crisp vocabulary, the board can become prompt soup: every useful workflow could be promoted into a "specialist", while every specialist could accidentally inherit tool workflows and permissions from skills.

The board needs a small set of reusable advisory capabilities. Specific operational workflows should remain skills or explicit commands.

## Decision

Use this taxonomy:

- **Agent**: a reusable role/capability that can handle a family of advisory tasks.
- **Skill**: a narrow task procedure or tool workflow that tells the main agent how to do a specific thing.
- **Board role Markdown**: advisory prompt/data for an agent role. It is not executable policy.
- **Runtime policy code**: the only authority for routing, budgets, permissions, eligibility, and tool allowlists.

Advisor Board specialists are **agents**. Existing narrow workflows such as `runpod-ollama`, `hf-cli`, `feature-loop`, and `qwen36-llamacpp-recovery` remain **skills**.

A board agent may recommend using a skill, but it must not silently execute that skill or inherit that skill's permissions.

## Definitions

### Agent

An agent is a durable advisory role with a broad remit and stable contract.

An agent may:

- inspect a compact board ledger or bounded context slice
- evaluate risks in its domain
- return structured findings or recommendations
- be invoked by the user, navigator/co-driver, or board policy if eligible

An agent must not gain tools or authority from its Markdown prompt. Tool access is determined by code.

### Skill

A skill is a concrete recipe for a specific workflow.

A skill may describe:

- exact commands or CLIs to use
- service-specific setup steps
- recovery procedures
- release/checklist workflows
- domain-specific scripts and operational details

Skills are loaded and executed by the main agent (or another explicitly authorized driver), not silently by a board specialist.

### Board role Markdown

Board role Markdown describes an agent's expert lens:

- identity and scope
- when the role is useful
- what evidence to inspect
- what findings to return
- what not to do

It is advisory content, not a permission grant. Frontmatter may request or document expected tools, but the runtime must validate and enforce the effective allowlist.

## Examples

### Board specialist agent

`stale-evidence-auditor`

- Family of tasks: compare old failure/test/review evidence against newer green or terminal workflow evidence.
- Good board fit because it is read-only, evidence-led, and directly addresses stale evidence loops from #217.
- It may recommend ignoring or clearing obsolete findings.
- It must not edit files, rerun commands, merge PRs, or change advisor state by itself.

### Current Pi skill

`qwen36-llamacpp-recovery`

- Specific workflow: recover and verify a local Qwen3.6 llama.cpp server.
- It contains operational steps, ports, model names, and verification commands.
- It is a skill, not a standing board member.
- A local-model specialist agent could recommend invoking this skill, but should not execute it automatically.

### Navigator/co-driver role

`navigator`

- Family of tasks: watch trajectory state, subagent returns, validation evidence, repeated failures, and cost/turn drift.
- It detects call-sites for board actions.
- It is not a mutating worker and not a generic implementation agent.
- Early versions should run in replay/shadow mode and avoid steer/interruption.

### Head-of-board role

`head-of-board`

- Family of tasks: high-impact strategic synthesis when cheaper signals or specialists cannot resolve a risk.
- It is the expensive senior advisor path.
- It receives a compact board ledger and precise escalation question, not raw monitor chatter by default.
- It is episodic, not continuously called every turn.

## Non-examples

Do not create a board specialist for every recurring workflow:

- `runpod-ollama` should remain a skill.
- `hf-cli` should remain a skill.
- `feature-loop` should remain a lifecycle skill.
- `twitter-export` should remain a sync/export skill.
- `obsidian-sync` should be a skill or command, not a board member, unless there is a broad advisory role around knowledge hygiene.

Do create a board specialist when the role answers a recurring advisory question across workflows:

- "Is this evidence stale?"
- "Is validation missing after implementation?"
- "Is this a security-sensitive change?"
- "Are subagent findings contradictory?"
- "Is the expensive advisor needed now?"

## When to create a board specialist vs a skill

Create a **board specialist agent** when all are true:

1. The role covers a family of advisory tasks, not one procedure.
2. It can operate read-only over a board ledger or bounded context slice.
3. It returns findings/advice rather than performing the workflow.
4. It is useful as a co-driver call-site detected by board policy.
5. It can be evaluated with fixtures, shadow logs, or structured outcomes.

Create a **skill** when any are true:

1. The work is a specific operational procedure.
2. The instructions are tool/service-specific.
3. The workflow may mutate files, run commands, or change external state.
4. The user/main agent should explicitly choose when to execute it.
5. It is too narrow to justify a standing board role.

## Permission and safety rule

Code owns safety.

Markdown role files and skill files cannot grant themselves:

- write/edit tools
- mutating shell access
- git/gh mutation
- settings mutation
- direct skill execution
- budget overrides
- routing authority

Runtime policy must enforce tool allowlists, role eligibility, budgets, cooldowns, and escalation thresholds.

## Relationship to #101 and #217

#101 showed that advisor routing needs trajectory-health features instead of always escalating before work and mostly abstaining during execution.

#217 showed that advisor state needs evidence epochs and terminal workflow state so stale failure snippets do not override newer green/merged evidence.

This taxonomy supports those fixes by keeping the first board roles focused on broad advisory capabilities:

- navigator/co-driver detects trajectory edge moments
- stale-evidence-auditor reviews evidence epoch conflicts
- test-reviewer can later review missing validation
- head-of-board remains an expensive escalation path, not an always-on workflow executor

## Consequences

- The initial board catalog should be small.
- Built-in roles should come before user-crafted roles.
- User-crafted roles should come before generated personal roles.
- Personal session-derived roles should be disabled by default and treated as untrusted user-derived data.
- Skills remain valuable and should be referenced by agents only as recommended explicit next steps.
