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
    chainAndBalanceRows,
    tokenAndTradeRows,
    contractAndStakeRows,
    stakeLifecycleRows
} = require('../../../../src/explorer/paging/list_rows.js');

describe('chainAndBalanceRows', function(){
    it('shapes a getBalances row from the count/amount/percent/value context', function(){
        const info = { tick: 'XCP' };
        const c = { count: 3, amount: '10', percent: '5', value: '1.5', method: 'getBalances' };
        assert.deepStrictEqual(chainAndBalanceRows(info, c), [3, 'XCP', '10', '5', '1.5', null]);
    });

    it('shapes a getBlocks row using actions from the context', function(){
        const info = { block_index: 100, timestamp: 111 };
        const c = { actions: 7, method: 'getBlocks' };
        assert.deepStrictEqual(chainAndBalanceRows(info, c), [100, 111, 7, 100]);
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(chainAndBalanceRows(info, { method: 'getNotAListedMethod' }), info);
    });
});

describe('tokenAndTradeRows', function(){
    it('shapes a getSends row with destination before status/action_index', function(){
        const info = { block_index: 1, timestamp: 2, source: 'S', tick: 'XCP', amount: '5', destination: 'D', action_index: 9 };
        const c = { count_reverse: 42, status: 1, method: 'getSends' };
        assert.deepStrictEqual(
            tokenAndTradeRows(info, c),
            [42, 1, 2, 'S', 'XCP', '5', 'D', 1, 9]
        );
    });

    it('shapes a getHolders row from count/amount/percent/value', function(){
        const info = { address: 'A' };
        const c = { count: 6, amount: '20', percent: '10', value: '3', method: 'getHolders' };
        assert.deepStrictEqual(tokenAndTradeRows(info, c), [6, 'A', '20', '10', '3', null]);
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(tokenAndTradeRows(info, { method: 'getNotAListedMethod' }), info);
    });
});

describe('contractAndStakeRows', function(){
    it('shapes a getContracts row', function(){
        const info = {
            block_index: 1, timestamp: 2, source: 'S', meta_name: 'M', code_hash: 'H',
            api_version: 1, cooldown_blocks: 5, slash_destination: 'X', action_index: 9
        };
        const c = { count_reverse: 3, status: 1, method: 'getContracts' };
        assert.deepStrictEqual(
            contractAndStakeRows(info, c),
            [3, 1, 2, 'S', 'M', 'H', 1, 5, 'X', 1, 9]
        );
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(contractAndStakeRows(info, { method: 'getNotAListedMethod' }), info);
    });
});

describe('stakeLifecycleRows', function(){
    it('shapes a getCollects row', function(){
        const info = { block_index: 1, timestamp: 2, source: 'S', amount: '5', action_index: 9 };
        const c = { count_reverse: 3, status: 1, method: 'getCollects' };
        assert.deepStrictEqual(stakeLifecycleRows(info, c), [3, 1, 2, 'S', '5', 1, 9]);
    });

    it('shapes a getSlashEvents row with no status column', function(){
        const info = {
            block_index: 1, timestamp: 2, slashed_pubkey: 'P', target_contract_index: 4,
            tick: 'XCP', amount: '5', destination: 'D', execution_index: 8
        };
        const c = { count_reverse: 3, method: 'getSlashEvents' };
        assert.deepStrictEqual(stakeLifecycleRows(info, c), [3, 1, 2, 'P', 4, 'XCP', '5', 'D', 8]);
    });

    it('returns info unchanged for a method the function does not shape', function(){
        const info = { anything: 'goes' };
        assert.strictEqual(stakeLifecycleRows(info, { method: 'getNotAListedMethod' }), info);
    });
});
