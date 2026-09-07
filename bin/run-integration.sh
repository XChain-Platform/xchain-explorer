#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

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

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Preflight the fixture BEFORE any mocha process starts. Without this, a host
# where something else already holds 127.0.0.1:3307 (measured 2026-09-02
# against a native mariadbd) makes the fixture container unbindable, and
# every file below then connects to the foreign server and dies with "Access
# denied for user 'root'@'127.0.0.1'": the same misleading error, once per file,
# naming neither the port nor the collision. The check names the collision once
# and stops.
if ! node bin/db-fixture.js check; then
  echo ""
  echo "integration: NOT RUN. The fixture on 127.0.0.1:3307 is unusable (see above)."
  exit 1
fi

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
