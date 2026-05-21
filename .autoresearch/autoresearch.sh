#!/bin/bash
set -euo pipefail

echo "=== Running tests ==="
npx vitest run --reporter=verbose 2>&1 || true

echo ""
echo "=== Per-package test count ==="
for pkg in core advisor goal guardrails brain; do
  count=$(find "packages/$pkg/src" -name "*.test.ts" 2>/dev/null | wc -l | tr -d ' ')
  echo "METRIC ${pkg}_test_files=$count"
done

# Total tests passed: extract number after "Tests" in "X Tests N passed" line
total_tests=$(npx vitest run 2>&1 | grep -E "Tests[[:space:]]+[0-9]+ passed" | sed 's/.*Tests[[:space:]]*\([0-9]*\).*/\1/')
echo "METRIC total_tests=${total_tests:-0}"
