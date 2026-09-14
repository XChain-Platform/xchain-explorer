/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unit tests for the ANCHOR light-client surface in src/XChainExplorer.js:
 *   GET /{COIN}/api/checkpoints              → processCheckpointsRequest
 *   GET /{COIN}/api/checkpoint/{h}/verify    → processCheckpointVerifyRequest
 *
 * Covers: coin/height validation (404/400), limit clamping, the {checkpoints,
 * count} list shape, and the verify verdict: legacy count quorum, sub-quorum
 * rejection, an unmirrored snapshot, the stake-weighted branch, and the EQUIV
 * uniform-header canonical wrapping. eq/swq activation is pinned per-test so the
 * verdict does not depend on the live flag-day maps.
 */

'use strict';

const { sinon, eq, swq } = require('./explorer_checkpoints.test/helpers.js');

beforeEach(function () {
    // Default: legacy count quorum, no EQUIV header. Individual tests override.
    sinon.stub(eq,  'isEquivHeaderActive').returns(false);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
});
afterEach(function () { sinon.restore(); });

require('./explorer_checkpoints.test/routes.js');
require('./explorer_checkpoints.test/parity.js');
require('./explorer_checkpoints.test/database.js');
