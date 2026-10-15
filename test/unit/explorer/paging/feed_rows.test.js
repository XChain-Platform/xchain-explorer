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
    mirrorAndExpiryRows,
    cancelEditAndGovernanceRows,
    hubOperationalAndSearchRows
} = require('../../../../src/explorer/paging/feed_rows.js');

describe('mirrorAndExpiryRows', function(){
    it('shapes a getReorgs row, keeping the lifecycle status second-to-last', function(){
        const info = { reorg_timestamp: 1000, reorg_height: 5, reorg_id: 'r1', affected_chains: 'BTC', validator_count: 3, status: 'confirmed', id: 9 };
        const c = { count_reverse: 2, method: 'getReorgs' };
        assert.deepStrictEqual(
            mirrorAndExpiryRows(info, c),
            [2, 1000, 5, 'r1', 'BTC', 3, 'confirmed', 9]
        );
    });

    it('shapes a getOrderExpires row using the standard colored-row status', function(){
        const info = { block_index: 1, timestamp: 2, source: 'S', order_action_index: 4, action_index: 9 };
        const c = { count_reverse: 3, status: 1, method: 'getOrderExpires' };
        assert.deepStrictEqual(mirrorAndExpiryRows(info, c), [3, 1, 2, 'S', 4, 1, 9]);
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(mirrorAndExpiryRows(info, { method: 'getNotAListedMethod' }), info);
    });
});

describe('cancelEditAndGovernanceRows', function(){
    it('shapes a getOrderCancels row, carrying the memo before status/action_index', function(){
        const info = { block_index: 1, timestamp: 2, source: 'S', order_action_index: 4, memo: 'why', action_index: 9 };
        const c = { count_reverse: 3, status: 1, method: 'getOrderCancels' };
        assert.deepStrictEqual(cancelEditAndGovernanceRows(info, c), [3, 1, 2, 'S', 4, 'why', 1, 9]);
    });

    it('shapes a getGovernanceVotes row with no status column', function(){
        const info = { created_at: 100, proposal_id: 'p1', voter_pubkey: 'V', vote: 'yes', id: 9 };
        const c = { count_reverse: 3, method: 'getGovernanceVotes' };
        assert.deepStrictEqual(cancelEditAndGovernanceRows(info, c), [3, 100, 'p1', 'V', 'yes', 9]);
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(cancelEditAndGovernanceRows(info, { method: 'getNotAListedMethod' }), info);
    });
});

describe('hubOperationalAndSearchRows', function(){
    it('shapes a getPeers row from the hub-mirrored operational table', function(){
        const info = { last_seen_at: 100, addr: '1.2.3.4', validator_id: 'v1', is_seed: 1, id: 9 };
        const c = { count_reverse: 3, method: 'getPeers' };
        assert.deepStrictEqual(hubOperationalAndSearchRows(info, c), [3, 100, '1.2.3.4', 'v1', 1, 9]);
    });

    it('shapes each getSearch result type from cfg.data.type', function(){
        const base = { count: 5 };
        assert.deepStrictEqual(
            hubOperationalAndSearchRows({ address: 'A' }, { ...base, method: 'getSearch', cfg: { data: { type: 'address' } } }),
            [5, 'A', null]
        );
        assert.deepStrictEqual(
            hubOperationalAndSearchRows({ tick: 'T', description: 'd' }, { ...base, method: 'getSearch', cfg: { data: { type: 'token' } } }),
            [5, 'T', 'd', null]
        );
        assert.deepStrictEqual(
            hubOperationalAndSearchRows(
                { meta_name: 'M', meta_version: 1, contract_address: 'C', snippet: 's', action_index: 9 },
                { ...base, method: 'getSearch', cfg: { data: { type: 'contract' } } }
            ),
            [5, 'M', 1, 'C', 's', 9]
        );
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(hubOperationalAndSearchRows(info, { method: 'getNotAListedMethod' }), info);
    });
});
