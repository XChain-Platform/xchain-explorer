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
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as six parallel jobs (ci, perf,
# integration, conformance, drift-guards, coverage). A pre-push venue gate that
# runs only `npm run ci` lets a push gate green locally and then go red on
# GitHub on a job the gate never ran (2026-08-15: exactly that, on three
# repos at once). This script IS the local twin of the workflow: every job's
# run-steps, transcribed, in job order. When ci.yml gains or changes a job,
# change this script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
# Every repo in .ci-siblings is required, because the ci and coverage jobs check
# out that whole roster and the guards written against a missing sibling call
# this.skip() and still print green.
#
# Database: the perf, integration and conformance jobs each get their own
# throwaway mariadb:10.11 service on 3307 with the fixture root password. perf
# and integration read that address from source (test/integration/helpers/
# db-setup.js and perf-setup.js), not from env, so their only local twin is this
# repo's committed fixture (test/integration/fixtures/docker-compose.test.yml),
# which publishes the same port with the same fixture credentials. Docker is
# therefore REQUIRED for those tiers, never skipped, and the fixture is recycled
# between them so each tier meets a fresh database the way each GitHub job does.
# The conformance tier is the one that reads env, and it goes to the SAME
# fixture rather than to the venue's own MariaDB. It creates four databases of
# its own (XChain_Conformance_*) and builds the real DDL inside them, which
# needs a privileged user; the venue's `ci` user holds CREATE globally but ALL
# only on ci_%, so pointing this at CI_DB_* got the databases created and then
# failed mid-DDL with "INDEX command denied" (measured on DankServer). GitHub
# gives this job its own throwaway container with root for exactly that reason,
# and the fixture is that container. Nothing here echoes or logs a password.
#
# SKIPPED-BY-DESIGN: none. Every run-step in ci.yml has a twin below. The
# actions-only steps (actions/checkout, setup-node, npm ci, and the two
# sibling-checkout shell steps in the conformance and coverage jobs) need no
# transcription: the venue ships the .ci-siblings checkouts beside this repo and
# need_sib refuses to run without them.
#
# Out of scope, deliberately: .github/workflows/audit.yml (schedule,
# workflow_dispatch and a path-filtered pull_request only) and
# .github/workflows/verify-tag.yml (v* tags only). Neither ever runs on a push
# to develop or master, so neither runs on the commit this gate protects.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

export CONFORMANCE_DB_HOST="${CONFORMANCE_DB_HOST:-127.0.0.1}"
export CONFORMANCE_DB_PORT="${CONFORMANCE_DB_PORT:-3307}"
export CONFORMANCE_DB_USER="${CONFORMANCE_DB_USER:-root}"
export CONFORMANCE_DB_PASS="${CONFORMANCE_DB_PASS:-testpass}"

need_sib xchain-indexer xchain-vm xchain-sdk xchain-decoder xchain-documentation \
         xchain-encoder xchain-hub

# Checked once, up front, so a venue without docker fails before the long unit
# tier rather than 20 minutes into the run.
docker info >/dev/null 2>&1 || {
  echo "ci:full: VENUE LACKS DOCKER for the perf, integration and conformance tiers" >&2
  echo "ci:full: (mariadb:10.11 on 3307); pin a docker venue with CI_VENUES=..." >&2
  exit 1
}

# A GitHub job's service container is born empty and dies with the job, so each
# DB tier below opens on a fresh fixture rather than inheriting the last one's
# rows. `down -v` first because a container left behind by a hand run already
# holds 3307. `up` routes through bin/db-fixture.js, which refuses to start when
# a FOREIGN server already holds 3307 and says so in one report naming the port
# and its holder.
FIXTURE_OK=1
db_fixture_reset() {
  npm run test:integration:down >/dev/null 2>&1
  if npm run test:integration:up; then
    FIXTURE_OK=1
    return 0
  fi
  FIXTURE_OK=0
  return 1
}

# A DB tier whose fixture never came up says NOTHING about the commit: it
# connects to whatever else answers on 3307 and prints a misleading "Access
# denied for user 'root'@'127.0.0.1'" once per test file (measured 2026-09-02
# against a native mariadbd holding the port). The tier still counts as
# red, because the gate genuinely could not verify the commit, but it reports
# the real fault instead of burying it under credential noise.
db_tier() {
  local name="$1"; shift
  if [ "$FIXTURE_OK" -eq 0 ]; then
    run_tier "$name" bash -c 'echo "ci:full: the MariaDB fixture on 127.0.0.1:3307 never came up (see the report above); this tier cannot run" >&2; exit 1'
    return
  fi
  run_tier "$name" "$@"
}

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" npm run ci

# --- job: perf (needs: ci) -------------------------------------------------
run_tier "db fixture for perf (mariadb on 3307)" db_fixture_reset
db_tier "perf (test:performance)" npm run test:performance

# --- job: integration (needs: ci) ------------------------------------------
# bin/run-integration.sh runs each integration file in its own process, the way
# the workflow invokes it; nft-endpoints creates a colocated decoder DB, so the
# fixture's root user is what the suite expects.
run_tier "db fixture for integration (mariadb on 3307)" db_fixture_reset
db_tier "integration (test:integration)" npm run test:integration

# --- job: conformance (needs: ci) ------------------------------------------
# Loads the REAL indexer, hub and decoder DDL from the sibling checkouts (the
# suite resolves them as ../xchain-*/src/sql, which is why the layout above is
# not optional) into a real MariaDB. The fixture is recycled here too; when
# CONFORMANCE_DB_* points somewhere else, the suite follows the env and simply
# leaves the fresh fixture unused.
# A run that points CONFORMANCE_DB_* somewhere other than the fixture address
# does not need the fixture at all, so a failed bring-up must not stop it.
run_tier "db fixture for conformance (mariadb on 3307)" db_fixture_reset
if [ "$CONFORMANCE_DB_HOST" = "127.0.0.1" ] && [ "$CONFORMANCE_DB_PORT" = "3307" ]; then
  db_tier  "conformance: schema canary (test:conformance)" npm run test:conformance
else
  run_tier "conformance: schema canary (test:conformance)" npm run test:conformance
fi

npm run test:integration:down >/dev/null 2>&1
echo "ci:full: db fixture torn down (no DB tiers remain)"

# --- job: drift-guards -----------------------------------------------------
# Run FROM the parent so the sync scripts see the canonical + vendored pair the
# way the workflow lays them out (hub and indexer checkouts beside this repo's).
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
sync_mirror_check() { (cd "$SIB" && "xchain-indexer/bin/sync-hub-mirror-client.sh" --check); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'
run_tier "drift: hub-mirror-client byte-identity" sync_mirror_check

# --- job: coverage (needs: ci) ---------------------------------------------
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
