# Advisor Board bounded ledger note

**Status:** Retained design note for the explicit read-only Board

The Board consumes a compact, sanitized ledger rather than a raw transcript. The ledger is an input boundary and evidence summary, not a second session runtime. It may contain bounded progress, changed-file, risk, failure, evidence-epoch, and prior-finding records.

## Explicit call boundary

Board activity is user-invoked:

```text
/pi-rogue-advisor board specialist suggest
/pi-rogue-advisor board specialist ask <role-id> <task>
/pi-rogue-advisor board head ask <decision question>
```

Normal Pi startup, turn-end, and agent-end lifecycle events do not call models. A Board suggestion may recommend a specialist or Head call, but it cannot start one automatically. Each explicit call has a role-specific model slot and bounded token/time/call budget.

## Core role contracts

- Static specialists (`reviewer`, `security`, `architecture`, `debugger`, and `reliability-perf`) inspect only read/search evidence and return structured findings.
- Head-of-Board receives the compact ledger plus a decision question and returns read-only synthesis.
- Neither specialists nor Head can edit files, run commands, change Pi configuration, switch the active model, or dispatch another role.

## Sanitization and replay

A replay fixture should verify that the same bounded ledger produces deterministic role selection and that forbidden transcript fields and mutating tools are rejected. Replay is a test/evidence mechanism only; it is not a background monitor, worker queue, or automatic escalation path.
