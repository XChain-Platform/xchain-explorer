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
 * Unit tests for ChangeDetector (src/ws/change_detector.js)
 */

'use strict';

const sinon      = require('sinon');

// Helper: create a mock db object
function createMockDb(opts) {
    opts = opts || {};
    return {
        getMaxBlockIndex:       sinon.stub().resolves(opts.blockIndex || 0),
        getMaxActionIndex:      sinon.stub().resolves(opts.actionIndex || 0),
        getBlocksSince:         sinon.stub().resolves(opts.blocks || []),
        getActionsSince:        sinon.stub().resolves(opts.actions || []),
        getOrderMatchSettlement: sinon.stub().resolves(opts.settlement || null),
        getCoinpayObligation:   sinon.stub().resolves(opts.obligation || null)
    };
}

        // Whether a (block, action_index) row is inside a cursor read, as the real SQL's
        // blockPairRange (src/db/shared.js) decides it: above `since`, or past the
        // resume row inside block `since`, and never above upToBlock.
        function pairInRead(block, actionIndex, since, bounds) {
            const b = Number(block);
            const upTo  = bounds ? bounds.upToBlock : null;
            const after = bounds ? bounds.afterActionIndex : null;
            if (upTo !== null && upTo !== undefined && b > Number(upTo)) return false;
            if (after === null || after === undefined) return b > Number(since);
            return b > Number(since) || (b === Number(since) && Number(actionIndex) > Number(after));
        }

        // Feeds the fake getBetFeedsClosedSince hands back, filtered by the cursor
        // exactly as the real SQL does (pairInRead, ASC, capped).
        function withLatches(db, feeds) {
            db.getBetFeedsClosedSince = sinon.spy(async (config, since, limit, bounds) =>
                feeds.filter((f) => pairInRead(f.closed_block, f.action_index, since, bounds))
                     .sort((a, b) => (a.closed_block - b.closed_block) || (a.action_index - b.action_index))
                     .slice(0, limit));
            return db;
        }

        function feed(action_index, closed_block, extra) {
            return Object.assign({ action_index, closed_block, source: '1oracle',
                                   tick: 'BWS', feed_status: 'closed' }, extra || {});
        }

module.exports = { createMockDb, withLatches, feed, pairInRead };
