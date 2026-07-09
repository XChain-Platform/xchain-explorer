#!/usr/bin/env bash
#
# Run each integration test file in its OWN mocha process for true per-file
# isolation.
#
# Why: the integration test files declare their setup/teardown as ROOT-level
# before/after hooks (outside any describe). Mocha attaches every file's root
# hooks to the single root suite and runs them together (all befores, then all
# tests, then all afters), so in one shared process a later file's before/after
# corrupts an earlier file's seeded data: each file passes in isolation but the
# combined run does not. A process per file gives each file fresh module state
# (db-setup's run-once seed guard) and a freshly imported + seeded database,
# which is what the tests were written to assume.
#
set -u

MOCHA="node ./node_modules/.bin/mocha"
FLAGS="--timeout 30000 --exit"
failed=()

for f in test/integration/*.test.js; do
  echo ""
  echo "=================================================================="
  echo "  $f"
  echo "=================================================================="
  if ! $MOCHA "$f" $FLAGS; then
    failed+=("$f")
  fi
done

echo ""
echo "=================================================================="
if [ ${#failed[@]} -eq 0 ]; then
  echo "  integration: ALL FILES PASSED"
  exit 0
fi
echo "  integration: ${#failed[@]} FILE(S) FAILED:"
for f in "${failed[@]}"; do echo "    - $f"; done
exit 1
