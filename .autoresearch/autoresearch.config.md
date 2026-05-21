---
metric: coverage
measurement_command: "npx vitest run --reporter=verbose 2>&1 | grep -E '^(Tests|Test Files)' || npx vitest run --coverage"
scope: packages/*/src
mode: solo
cycles: 15
round: 1
target: "all packages have meaningful tests"
backpressure:
  - "npx vitest typecheck"
  - "npm run check -ws --if-present"
direction: maximize
checks_timeout_seconds: 120
created: 2026-05-21T23:30:00Z
prior_findings: []
---

# Autoresearch: Test Coverage Sweep

## Objective
Add tests to packages that currently lack them. Ensure 27+ tests pass across the monorepo.

## Current State
Cycle 0/15 | Not started

## Strategy
1. Core package: tests exist for risk.ts, text.ts. Good baseline.
2. Advisor: add config/state tests. No existing test file.
3. Guardrails: add risk-scan integration tests.
4. Brain: add store tests (pure logic, no pi dependency).

## What Worked
(empty)

## Dead Ends
(empty)

## Next Experiments
1. Add advisor config and state tests (packages/advisor/src)
2. Add guardrails integration tests for the tool_call handler
