/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const readers = require('../../../../../src/db/readers/action_detail_io/lists.js');

function fakeReader(rows) {
    return {
        isListEditResolutionActiveAtTip: async () => true,
        getListOwnerAddresses: async () => ({}),
        getListHeadIndex: async () => 140,
        doQuery: async (config, sql) => {
            assert.match(sql, /l1\.item_id/);
            return rows;
        }
    };
}

describe('current membership for union lists', function () {
    it('reads raw member list indexes and sorts them numerically', async function () {
        const state = await readers.getListCurrentMembership.call(
            fakeReader([{ item_id: 10, address: 'wrong' }, { item_id: 9, tick: 'WRONG' }]),
            { coin: 'RBTC' }, 100, 3
        );
        assert.deepEqual(state.current_list, [9, 10]);
        assert.equal(state.membership_action_index, 140);
    });

    it('omits an unresolved member instead of turning it into action zero', async function () {
        const state = await readers.getListCurrentMembership.call(
            fakeReader([{ item_id: null }, { item_id: 9 }]), { coin: 'RBTC' }, 100, 3
        );
        assert.deepEqual(state.current_list, [9]);
    });
});
