# Qwen execution-worker failure triage

This note documents how to distinguish a local Qwen inference failure from a Pi subagent-runner budget outcome. It is an operational guardrail; Pi-Rogue does not own the llama.cpp server lifecycle or the installed `pi-subagents` runner. The actual machine-readable runner outcome fix belongs upstream; Pi-Rogue tracks the integration and operating contract here.

## Diagnosis checklist

1. Confirm the configured worker target is the expected model:

   ```bash
   curl -fsS http://127.0.0.1:8004/v1/models
   ```

   The response must include `qwen3.6-35b-a3b-ud-q4-k-m` and the expected context metadata.

2. Confirm the endpoint is responsive:

   ```bash
   curl -fsS http://127.0.0.1:8004/health
   ```

3. Run a minimal generation smoke test before retrying a worker task:

   ```bash
   curl -fsS --max-time 60 http://127.0.0.1:8004/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"qwen3.6-35b-a3b-ud-q4-k-m","messages":[{"role":"user","content":"Reply with exactly OK."}],"max_tokens":4,"temperature":0}'
   ```

4. Inspect the child-run result and runner message. A message such as:

   ```text
   Tool budget soft limit reached after 30 tool calls (soft 30, hard 45)
   ```

   is a **tool-call budget** outcome from `pi-subagents`, not a turns quota and not proof that Qwen or llama.cpp failed. The runner has separate tool-budget and turn-budget controls.

5. Treat these as separate diagnoses:

   - `tool budget ...`: bound the task, checkpoint findings, and continue in a new child run.
   - `turn budget ...`: the child exceeded its configured assistant-turn budget.
   - endpoint/model error: investigate the local server and model identity.
   - timeout/cancellation: investigate the runner deadline or explicit cancellation.

## Safe operating pattern

- Keep the frontier model as controller and reviewer.
- Use explicit, run-scoped worker approval; AC power alone is not consent.
- Split repository exploration into bounded chunks of roughly 20 tool calls or fewer.
- Ask each child to return a checkpoint/artifact before the soft budget and to stop browsing when its budget warning appears.
- Do not silently fall back to a paid/frontier worker when the approved local worker fails.
- Preserve the child result, budget counts, and artifact path when opening or updating a ticket.

## Current incident

The July 17, 2026 investigation’s Qwen child ran from `2026-07-16T23:55:57.725Z` to `2026-07-17T00:04:27.544Z` UTC, used the expected `llamacpp-qwen-unsloth` model, completed 20 assistant turns and 44 `bash` tool calls, and reached the `pi-subagents` tool-budget warning at 30 calls (hard limit 45). The local server independently passed health, exact-model, and `OK` smoke checks. The incident therefore does not support a turns-quota or current llama.cpp-health diagnosis. The runner should expose a stable, resumable budget outcome. Pi-Rogue tracks the integration and operating contract in [issue #371](https://github.com/fiale-plus/pi-rogue/issues/371), related to [issue #356](https://github.com/fiale-plus/pi-rogue/issues/356); the runtime implementation belongs in the `pi-subagents` project.

This workaround does not change model settings, context size, budgets, fallback policy, or server lifecycle.
