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
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    DEFAULT_ANCHOR,
    ANCHOR_BY_METHOD,
    whereAnchor
} = require('../../../../src/db/query_sql/where_anchors.js');

describe('whereAnchor', function(){
    it('returns the anchor mapped to each representative query method', function(){
        const expected = {
            getBalances:      `m.address_id IS NOT NULL`,
            getBlocks:        `b1.block_index IS NOT NULL`,
            getContractState: `cs.id IS NOT NULL`,
            getTransaction:   `m.tx_index IS NOT NULL`,
            getMarket:        `m.id IS NOT NULL`
        };

        for (const [method, anchor] of Object.entries(expected))
            assert.strictEqual(whereAnchor(method), anchor);
    });

    it('exports and uses the default anchor for an unmapped method', function(){
        assert.strictEqual(DEFAULT_ANCHOR, `m.action_index IS NOT NULL`);
        assert.strictEqual(whereAnchor('unknownMethod'), DEFAULT_ANCHOR);
    });

    it('uses the default for names inherited from Object.prototype', function(){
        assert.strictEqual(whereAnchor('toString'), DEFAULT_ANCHOR);
        assert.strictEqual(whereAnchor('constructor'), DEFAULT_ANCHOR);
    });

    it('exports exactly 29 own method mappings', function(){
        assert.strictEqual(Object.keys(ANCHOR_BY_METHOD).length, 29);
    });
});
