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

// Hub operational-state cache (validator_capabilities / governance_proposals /
// governance_votes over hub JSON-RPC) and the RPC-first read path in db/index.js:
// TTL/stale cache behavior, endpoint resolution, filter param mapping, and JS
// paging parity with the SQL cursor semantics it replaces.

require('./hub_operational_cache.test/support/cache.js');
require('./hub_operational_cache.test/support/database.js');
