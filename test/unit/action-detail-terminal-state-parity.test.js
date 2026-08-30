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
 *
 * Two defects on the same surface, both found by driving Tier-4 expiries on
 * regtest and reading sibling actions SIDE BY SIDE rather than one at a time.
 *
 * 1. TERMINAL give_remaining disagreed across three sibling families. An
 *    expired ORDER read `status: expired` beside `give_remaining: 100` - i.e.
 *    it advertised 100 tokens it will never give - and an expired DISPENSER did
 *    the same, while an expired SWAP correctly read 0. (Measured: order 1306,
 *    dispenser 1308, swap 1307, all terminal in block 3539.)
 *
 *    The near-miss worth remembering: terminal zeroing was believed to be
 *    swap-only because SWAP has no fills table, while ORDER subtracts
 *    order_matches and DISPENSER derives escrow as create + refills - payouts.
 *    Those derivations DO reach 0 on their own - but only when the offer was
 *    filled or drained. Expire or cancel it UNFILLED and there is no match to
 *    subtract and no payout to net out, so the full amount survives into the
 *    terminal state.
 *
 *    The registry detail that decides the fix: afterQuery3 runs only when
 *    query3 returned rows, so an unfilled expiry never reaches it - which is
 *    exactly the failing case. ORDER therefore zeroes in afterMain too, which
 *    is safe because afterQuery3 recomputes from give_amount, not from state.
 *
 * 2. BET_EXPIRE served NO top-level status, so its page printed
 *    `Action Status: -` on a valid action while its five sibling terminal
 *    system actions all read `valid`. It owns no table with a status_id and
 *    `actions` has no status column, so there is nothing stored to select; its
 *    existence is its validity (the action index is minted only after the
 *    idempotence guard passes, inside the block's atomic write).
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const shared     = require('../../src/action-detail/shared.js');
const markets    = require('../../src/action-detail/markets.js');
const dispensers = require('../../src/action-detail/dispensers.js');
const governance = require('../../src/action-detail/governance.js');

// The registry's own contract, reproduced from db.js: afterQuery2/afterQuery3
// run ONLY when their query returned rows. A test that always calls afterQuery3
// would hide the very case defect 1 lived in.
async function runHandler(handler, data, { query2Rows = [], query3Rows = [] } = {}, ctx = {}) {
    const fullCtx = { db: { util: require('../../src/utility.js').prototype ? null : null }, ...ctx };
    if (handler.afterMain) await handler.afterMain(fullCtx, data);
    if (query2Rows.length && handler.afterQuery2) await handler.afterQuery2(fullCtx, data, query2Rows);
    if (query3Rows.length && handler.afterQuery3) await handler.afterQuery3(fullCtx, data, query3Rows);
    return data;
}

describe('terminal offer state is consistent across ORDER, SWAP and DISPENSER', () => {

    describe('the shared whitelist', () => {
        it('treats complete, cancelled and expired as terminal', () => {
            expect([...shared.TERMINAL_OFFER_STATUSES].sort())
                .to.deep.equal(['cancelled', 'complete', 'expired']);
        });

        // A dispenser's 'empty' is terminal but deliberately absent: its escrow
        // derivation already reaches 0 when it drained, so adding it would change
        // nothing observable, and a drained dispenser reporting residual escrow is
        // an anomaly to surface rather than to zero away.
        it('deliberately excludes a drained dispenser\'s empty', () => {
            expect([...shared.TERMINAL_OFFER_STATUSES]).to.not.include('empty');
            const data = { state: { status: 'empty', give_remaining: '7', get_remaining: '3' } };
            shared.applyTerminalOfferState(data);
            expect(data.state.give_remaining).to.equal('7');
        });

        it('does NOT treat in-flight states as terminal', () => {
            // The indexer's rollback treats 'cancelling' / 'expiring' as still live,
            // so zeroing them would blank escrow that is still held.
            for (const live of ['open', 'cancelling', 'expiring']) {
                const data = { state: { status: live, give_remaining: '100', get_remaining: '50' } };
                shared.applyTerminalOfferState(data);
                expect(data.state.give_remaining, live).to.equal('100');
                expect(data.state.get_remaining, live).to.equal('50');
            }
        });

        it('zeroes both legs on every terminal status', () => {
            for (const done of shared.TERMINAL_OFFER_STATUSES) {
                const data = { state: { status: done, give_remaining: '100', get_remaining: '50' } };
                shared.applyTerminalOfferState(data);
                expect(data.state.give_remaining, done).to.equal('0');
                expect(data.state.get_remaining, done).to.equal('0');
            }
        });
    });

    describe('ORDER - the unfilled-expiry case the registry skips afterQuery3 for', () => {
        // This is defect 1's exact shape: order 1306, expired, never matched.
        it('zeroes an expired order that has NO order_matches rows', async () => {
            const handler = markets.ORDER || null;
            expect(handler, 'ORDER handler must be exported').to.not.equal(null);
            const data = { give_amount: '100', get_amount: '50', current_status: 'expired' };
            // query3Rows empty => afterQuery3 is NOT called, per the registry contract.
            await runHandler(handler, data, { query3Rows: [] });
            expect(data.state.give_remaining).to.equal('0');
            expect(data.state.get_remaining).to.equal('0');
            expect(data.state.status).to.equal('expired');
        });

        it('leaves an OPEN unmatched order advertising its full amount', async () => {
            const handler = markets.ORDER;
            const data = { give_amount: '100', get_amount: '50', current_status: 'open' };
            await runHandler(handler, data, { query3Rows: [] });
            expect(data.state.give_remaining).to.equal('100');
            expect(data.state.get_remaining).to.equal('50');
        });
    });

    describe('DISPENSER', () => {
        it('exposes an afterMain that applies terminal state', () => {
            const handler = dispensers.DISPENSER;
            expect(handler, 'DISPENSER handler must be exported').to.be.an('object');
            expect(handler.afterMain, 'DISPENSER must have an afterMain').to.be.a('function');
            // A bare `afterMain: shared.applyOfferState` reference is the pre-fix
            // shape and cannot zero anything; the fix wraps it.
            expect(handler.afterMain).to.not.equal(shared.applyOfferState);
        });
    });

    describe('SWAP keeps the behaviour it already had', () => {
        it('still wraps applyOfferState rather than referencing it bare', () => {
            const handler = markets.SWAP;
            expect(handler.afterMain).to.be.a('function');
            expect(handler.afterMain).to.not.equal(shared.applyOfferState);
        });
    });
});

describe('BET_EXPIRE serves a top-level status like its five sibling system actions', () => {

    it('sets status to valid in afterMain', async () => {
        const handler = governance.BET_EXPIRE;
        expect(handler, 'BET_EXPIRE handler must be exported').to.be.an('object');
        const data = {};
        await handler.afterMain({}, data);
        expect(data.status).to.equal('valid');
    });

    it('does NOT surface the feed lifecycle state as the action status', async () => {
        // The main query aliases it `feed_status` on purpose: an expired FEED is
        // not an invalid ACTION, and printing "Action Status: expired" would be
        // worse than the dash this fix replaces.
        const handler = governance.BET_EXPIRE;
        const data = { feed_status: 'expired' };
        await handler.afterMain({}, data);
        expect(data.status).to.equal('valid');
        expect(data.feed_status).to.equal('expired');
    });

    it('still seeds the refund tally zeroes it already owned', async () => {
        const handler = governance.BET_EXPIRE;
        const data = {};
        await handler.afterMain({}, data);
        expect(data.refund_count).to.equal(0);
        expect(data.refund_amount).to.equal('0');
    });
});
