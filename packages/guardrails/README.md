# Pi-Rogue Guardrails

Shell command risk checks and approvals for Pi.

Low-friction defaults:
- `ask` mode triggers approvals only for high-risk patterns (`danger`)
- `warn` patterns are allowed by default unless you run `/guardrails warn on`
- `/guardrails session on` can temporarily disable all shell prompts for the rest of the current Pi session
- `/guardrails llm-model auto|local|provider/model` configures the review model (`local` uses the local binary gate path without provider calls)
- destructive high-risk commands create a capped restore ledger entry (git pre-state snapshots, 30m restore window) for safer execution

Install locally from this repo root: `npm install`
