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

run_self_test() {
    local test_dir test_bin cleanup_command first_err second_err reset_err third_err
    local first_rc second_rc reset_rc third_rc

    test_dir=$(mktemp -d "${TMPDIR:-/tmp}/check-explorer-freshness.test.XXXXXX") || return 1
    printf -v cleanup_command 'rm -rf -- %q' "$test_dir"
    trap "$cleanup_command" EXIT
    test_bin="$test_dir/bin"
    mkdir "$test_bin" || return 1

    printf '%s\n' '#!/usr/bin/env bash' 'printf '\''{}\n'\''' >"$test_bin/curl"
    printf '%s\n' '#!/usr/bin/env bash' 'printf '\''%s\n'\'' "${MOCK_JQ_OUTPUT-stale:BTC}"' >"$test_bin/jq"
    printf '%s\n' '#!/usr/bin/env bash' 'printf '\''test-host\n'\''' >"$test_bin/hostname"
    chmod +x "$test_bin/curl" "$test_bin/jq" "$test_bin/hostname"

    first_err=$(PATH="$test_bin:/usr/bin:/bin" EXPLORER_FRESHNESS_ALERT_LATCH_DIR="$test_dir/latch" \
        bash "$0" 2>&1 >/dev/null)
    first_rc=$?
    second_err=$(PATH="$test_bin:/usr/bin:/bin" EXPLORER_FRESHNESS_ALERT_LATCH_DIR="$test_dir/latch" \
        bash "$0" 2>&1 >/dev/null)
    second_rc=$?

    [ "$first_rc" -eq 1 ] || { echo "self-test: first stale reading returned $first_rc, expected 1" >&2; return 1; }
    [ "$second_rc" -eq 1 ] || { echo "self-test: second stale reading returned $second_rc, expected 1" >&2; return 1; }
    case "$first_err" in
        *"explorer-freshness ALERT"*) ;;
        *) echo "self-test: first stale reading sent no alert" >&2; return 1 ;;
    esac
    [ -z "$second_err" ] || { echo "self-test: second stale reading sent another alert: $second_err" >&2; return 1; }

    reset_err=$(PATH="$test_bin:/usr/bin:/bin" MOCK_JQ_OUTPUT= \
        EXPLORER_FRESHNESS_ALERT_LATCH_DIR="$test_dir/latch" bash "$0" 2>&1 >/dev/null)
    reset_rc=$?
    third_err=$(PATH="$test_bin:/usr/bin:/bin" EXPLORER_FRESHNESS_ALERT_LATCH_DIR="$test_dir/latch" \
        bash "$0" 2>&1 >/dev/null)
    third_rc=$?

    [ "$reset_rc" -eq 0 ] || { echo "self-test: healthy reading returned $reset_rc, expected 0: $reset_err" >&2; return 1; }
    [ "$third_rc" -eq 1 ] || { echo "self-test: stale reading after reset returned $third_rc, expected 1" >&2; return 1; }
    case "$third_err" in
        *"explorer-freshness ALERT"*) ;;
        *) echo "self-test: stale reading after reset sent no alert" >&2; return 1 ;;
    esac

    echo "self-test: second stale reading sent no second alert"
}

if [ "${1:-}" = "--self-test" ]; then
    run_self_test
    exit $?
fi

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
