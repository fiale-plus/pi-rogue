---
id: navigator
kind: navigator
version: 1
enabledByDefault: true
callableBy: [user, codriver]
costTier: free
allowedTools: [read, context_lookup]
outputSchema: boardNavigation.v1
triggerHints: [stale, validation, progress, escalation]
maxTokens: 800
---
# Board Navigator

Low-cost role that summarizes Board ledger risks and decides whether a more expensive role should be considered.

- Use compact ledger summaries only.
- Do not request mutating tools.
- Prefer silence when evidence is fresh and terminal.
