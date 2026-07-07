#!/usr/bin/env bash
#
# Copyright © 2025–2026 Dankest, LLC
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sync the canonical contract-ABI extraction core (src/abi-core.js, the parser
# behind the explorer contract page's methods/abi surface) into each consuming
# service's vendored copy. Services build into independent containers without
# sibling repos, so each bundles a byte-identical copy; this script keeps them
# in sync (same pattern as xchain-indexer/bin/sync-hub-mirror-client.sh).
#
# Usage:
#   sync-abi-core.sh           Copy canonical -> every consumer (overwrites vendored copies).
#   sync-abi-core.sh --check   Verify every vendored copy is byte-identical; exit 1 on drift.
#                              Use in CI so a drifted/forgotten copy fails the build.
#
set -euo pipefail

# Repo root is two levels up from this script (xchain-explorer/bin -> xchain-explorer -> root).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../src/abi-core.js"
ROOT="$(cd "$HERE/../.." && pwd)"

# Consumer -> vendored path (relative to the consumer repo).
CONSUMERS="xchain-sdk:src/contract/abi-core.js"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

drift=0
for entry in $CONSUMERS; do
    svc="${entry%%:*}"
    rel="${entry#*:}"
    dest="$ROOT/$svc/$rel"
    if [ "$CHECK" -eq 1 ]; then
        if ! cmp -s "$SRC" "$dest"; then
            echo "DRIFT: $svc/$rel differs from canonical xchain-explorer/src/abi-core.js"
            drift=1
        fi
    else
        mkdir -p "$(dirname "$dest")"
        cp "$SRC" "$dest"
    fi
done

if [ "$CHECK" -eq 1 ]; then
    [ "$drift" -eq 0 ] && echo "OK: all vendored abi-core copies are byte-identical to canonical." || exit 1
else
    echo "Synced canonical abi-core into: $CONSUMERS"
fi
