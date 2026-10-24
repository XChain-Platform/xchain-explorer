#!/usr/bin/env bash
# Copyright © 2025–2026 Dankest, LLC
# SPDX-License-Identifier: AGPL-3.0-or-later
# Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
#
# Alert when any non-regtest coin this explorer serves is stale-gated or its
# replica carries an active sync halt. Prints the problem to STDERR once per
# unhealthy episode and exits 1, so a cron line with MAILTO mails the operator;
# silent rc=0 when healthy.
#
# Exists because a consensus-divergence halt (xchain-sync protecting the
# replica) once sat unnoticed for ~12 hours: the explorer's freshness gate
# correctly 503'd the coin, and nothing told anyone. The two safety layers
# each need this third one, the operator signal.
#
# Cron line (stderr must flow to MAILTO, so do NOT append 2>&1):
#   */15 * * * * <checkout>/bin/check-explorer-freshness.sh >/dev/null
#
# Regtest coins (R-prefixed) are excluded: dormant regtest replicas on a
# production box are expected and would alert forever.
set -u

STATUS_URL="${EXPLORER_STATUS_URL:-http://127.0.0.1:18080/BTC/api/status}"
ALERT_LATCH_DIR="${EXPLORER_FRESHNESS_ALERT_LATCH_DIR:-${TMPDIR:-/tmp}/check-explorer-freshness.alerted}"

command -v jq >/dev/null 2>&1 || { echo "check-explorer-freshness: jq is required" >&2; exit 1; }

json=$(curl -sf -m 30 "$STATUS_URL") || {
    echo "explorer-freshness on $(hostname): status endpoint unreachable at $STATUS_URL (explorer down?)" >&2
    exit 1
}

bad=$(echo "$json" | jq -r '
  [((.stale // {}) | to_entries[] | select(.value == true) | "stale:" + .key),
   ((.replica_halted // {}) | to_entries[] | select(.value == true) | "halted:" + .key)]
  | map(select((split(":")[1] | startswith("R")) | not))
  | join(" ")')

if [ -n "$bad" ]; then
    if mkdir "$ALERT_LATCH_DIR" 2>/dev/null; then
        echo "explorer-freshness ALERT on $(hostname): $bad (freshness gate tripped or sync halt active; check the sync client journal for the coin, and $STATUS_URL)" >&2
    elif [ ! -d "$ALERT_LATCH_DIR" ]; then
        echo "explorer-freshness ALERT on $(hostname): $bad (freshness gate tripped or sync halt active; check the sync client journal for the coin, and $STATUS_URL; alert latch unavailable at $ALERT_LATCH_DIR)" >&2
    fi
    exit 1
fi
rmdir "$ALERT_LATCH_DIR" 2>/dev/null || true
exit 0
