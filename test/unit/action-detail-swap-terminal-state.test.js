/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * A SWAP's state.give_remaining / get_remaining are seeded from the original
 * amounts by shared.applyOfferState. ORDER corrects them from order_matches
 * and DISPENSER from escrow, but a swap settles atomically and has no fills
 * table to subtract (cross_settle writes no swap_matches row, cancel and
 * expire write none), so a completed swap kept showing its full original
 * amounts as remaining. The terminal status is the escrow-gone signal.
 */

'use strict';

const { expect } = require('chai');
const shared      = require('../../src/action-detail/shared.js');
const { SWAP }    = require('../../src/action-detail/markets.js');

function swapRow(current_status) {
    return {
        action: 'SWAP', action_index: 9, give_amount: '5.00000000', get_amount: '9.00000000',
        expiration: 100, allow_list: null, block_list: null, current_status
    };
}

// afterMain needs only the shared state seed; no DB is touched for SWAP.
const ctx = { db: null, config: {}, action_index: 9, type: 'SWAP' };

describe('SWAP detail: remaining amounts on a terminal swap', function () {

    for (const status of ['complete', 'cancelled', 'expired']) {
        it('[REGRESSION] a ' + status + ' swap reports 0 remaining, not the original amounts', async function () {
            const data = swapRow(status);
            await SWAP.afterMain(ctx, data);
            expect(data.state.status).to.equal(status);
            expect(data.state.give_remaining).to.equal('0');
            expect(data.state.get_remaining).to.equal('0');
        });
    }

    for (const status of ['open', 'cancelling', 'expiring', null]) {
        it('a swap with status ' + String(status) + ' keeps the seeded remaining amounts', async function () {
            const data = swapRow(status);
            await SWAP.afterMain(ctx, data);
            expect(data.state.give_remaining).to.equal('5.00000000');
            expect(data.state.get_remaining).to.equal('9.00000000');
        });
    }

    it('the terminal whitelist is exactly complete / cancelled / expired', function () {
        expect([...shared.TERMINAL_OFFER_STATUSES].sort()).to.deep.equal(['cancelled', 'complete', 'expired']);
    });

    it('applyTerminalOfferState leaves a payload without state alone', function () {
        const data = { action: 'SWAP' };
        shared.applyTerminalOfferState(data);
        expect(data).to.deep.equal({ action: 'SWAP' });
    });
});
