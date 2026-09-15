'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// the shared /metrics exporter and structured log shim. The suite
// pins the three properties services depend on: valid Prometheus exposition
// text, default-off wiring (no route, no timer, no socket without env), and a
// log shim that redacts credentials and never throws at a dead collector.
//
// Ported from the canonical suite at xchain-hub/test/unit/observability.test.js.
// src/observability/ here is a verbatim vendored copy, vendored and verified by
// xchain-hub/bin/sync-observability.sh. Parity is gated in the HUB, not here:
// the hub's pre-push gate (bin/ci-full.sh) and the drift-guards job of its
// ci.yml both run that script with --check against all six consumers, so a
// hand-edit to this copy reddens the hub. This file runs the same assertions
// against xchain-explorer's own copy, express version and Node engine.
// Behaviour changes belong in the canonical suite first; re-port rather than
// hand-editing, or the two drift apart silently.

require('./observability.test/support/metrics.js');
require('./observability.test/support/log_shipper.js');
require('./observability.test/support/install_observability.js');
require('./observability.test/support/log_formats.js');
require('./observability.test/support/patch_console.js');
