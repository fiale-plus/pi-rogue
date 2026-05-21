# Autoresearch: Test Coverage Sweep

## Objective
Add tests to packages that currently lack them.

## Current State
Cycle 1/15 | Active

## Strategy
1. Core package: tests exist for risk.ts, text.ts. ✅ (2 test files, 27 tests)
2. Advisor: config and SOTA model tests added. ✅ (1 test file, 4 tests)
3. Next: Add guardrails config/scan integration tests.
4. Then: Add brain store tests (pure logic).

## What Worked
- Advisor tests: 4 tests for SOTA_MODELS list and config types. All pass.

## Dead Ends
(empty)

## Next Experiments
1. Guardrails: add tests for config normalization and shell scanning
2. Brain: add pure-logic store tests (no pi dependency)
