# Advisor loop diagnostics

Advisor review loops observed in this repo came from two coupled failure modes:

1. **Scope drift**: the advisor shifted from the user's meta-task (for example, "why is the advisor looping?") into implementation work that the advisor itself had suggested.
2. **No durable diagnostic evidence**: after the shift, there was no persisted event explaining that the same advice was being repeated or why stale follow-ups were kept, so later reviews treated the advisor-suggested scope as still incomplete.

The advisor extension now records durable JSONL diagnostics under the advisor feature directory (`~/.pi/agent/pi-rogue/advisor/diagnostics.jsonl`) for loop and convergence decisions:

- `advisor_loop_detected`: near-identical advice repeated across changing context within the same task family.
- `stale_followup_dropped`: task-scoped follow-up was discarded because its task scope was missing or no longer matches the active task.
- `stale_review_signals_dropped`: task-scoped review signals were discarded for the same reason.
- `review_repeated_snapshot_skipped`: repeated material snapshot was skipped after safety/failure checks allowed suppression.
- `review_closeout_cleared`: clean closeout evidence cleared stale follow-up/review/loop state.
- `review_running_recovered`: a persisted running review was recovered after restart.

Diagnostics intentionally store short, sanitized snippets and hashes rather than full prompts. They are for operator/debug visibility only; they do not change command surfaces or ask the agent to do implementation work.
