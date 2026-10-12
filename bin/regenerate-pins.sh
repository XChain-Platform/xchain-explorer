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
# Regenerate this repository's generated pin from the tree: the pin the
# platform's generated-pins list names for it. On an unchanged tree it writes
# nothing.
#
#   bin/regenerate-pins.sh             bin/pins/at1-explorer-identity.json
#
# Only the LIVE pin is re-taken. bin/pins/at1-explorer-identity.8f251b6.json is
# the frozen base record and is never regenerated (bin/explorer-identity.js says
# why). This repository has no separate suite-title pin: the identity carries
# the suite collection, so it is taken with the sibling repos checked out beside
# this one, as the gate has them.

set -u
cd "$(dirname "$0")/.." || exit 2

[ "$#" -gt 0 ] || set -- identity
rc=0
for pin in "$@"; do
  case "$pin" in
    identity) node bin/explorer-identity.js --out bin/pins/at1-explorer-identity.json >/dev/null ;;
    *) echo "regenerate-pins: unknown pin: $pin" >&2; exit 2 ;;
  esac
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "regenerate-pins: $pin failed (exit $status)" >&2
    rc=1
  fi
done
exit "$rc"
