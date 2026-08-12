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
 * The action LRU assumed "action data is immutable once confirmed". That is
 * false for the three types that carry a live `state` block: DISPENSER, ORDER
 * and SWAP derive give_remaining / status / expiration / allow_list /
 * block_list from dispenses, matches, edits and closes recorded AFTER the
 * action confirmed. With no TTL and reorg-only invalidation, one cached read
 * froze that state for the life of the process.
 *
 * Measured on BTC regtest: a dispenser drained by four fills and closed by the
 * indexer kept serving `give_remaining: 200, status: open`, and restarting the
 * explorer alone - no chain change - corrected it to `0, empty`. The wallet's
 * dispenser detail page reads this endpoint, so a buyer was shown an open
 * dispenser with a full escrow and could pay one that dispenses nothing.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() { return new Database(mockExplorer); }

describe('action LRU skips responses carrying a live state block', function () {

    it('caches an action with no state block (SEND, immutable once confirmed)', function () {
        const db = makeDb();
        expect(db._isCacheableAction({ action: 'SEND', action_index: 7 })).to.equal(true);
    });

    it('[REGRESSION] refuses to cache a DISPENSER, whose state keeps changing', function () {
        const db = makeDb();
        const dispenser = {
            action: 'DISPENSER',
            action_index: 3508,
            give_escrow: '200',
            state: { give_remaining: '200', status: 'open' },
        };
        expect(db._isCacheableAction(dispenser)).to.equal(false);
    });

    it('[REGRESSION] refuses to cache ORDER and SWAP for the same reason', function () {
        const db = makeDb();
        const order = { action: 'ORDER', state: { give_remaining: '5', get_remaining: '5' } };
        const swap  = { action: 'SWAP',  state: { give_remaining: '1', get_remaining: '1' } };
        expect(db._isCacheableAction(order)).to.equal(false);
        expect(db._isCacheableAction(swap)).to.equal(false);
    });

    it('treats an empty-string or null state as cacheable rather than throwing', function () {
        const db = makeDb();
        // An action_index is required (see the regression block below); these
        // previously passed `{ state }` alone, which is also the
        // shape of a NOT-FOUND. The property being pinned here is unchanged:
        // odd `state` values are answered, not thrown on.
        expect(db._isCacheableAction({ action_index: 7, state: null })).to.equal(true);
        expect(db._isCacheableAction({ action_index: 7, state: '' })).to.equal(true);
        expect(db._isCacheableAction(null)).to.equal(false);
    });

    // The sibling of the defect above, in the other direction: the LRU was also
    // memoizing responses for actions that DO NOT EXIST YET.
    //
    // getActionData returns `{credits,debits,escrows,fee}` all null when
    // getActionType finds no row, which is the normal state of an action_index
    // between its block landing and the indexer writing its typed row. That
    // blank carries no `state`, so it was cached - with no TTL and reorg-only
    // invalidation, i.e. for the life of the process.
    //
    // Measured on BTC regtest: the endpoint served an empty body while the
    // identical detail SQL, against the same database, returned a full row.
    // Anyone who asked one moment too early blanked that action for every later
    // reader - including sdk.waitForActionIndex(), which polls this exact
    // endpoint every 2s BECAUSE the action is not there yet, and so can never
    // succeed: its first poll caches the miss it is waiting to clear.
    describe('[REGRESSION] a not-yet-indexed action must not be memoized', function () {
        it('refuses the blank getActionData builds when the action has no row', function () {
            const db = makeDb();
            expect(db._isCacheableAction({ credits: null, debits: null, escrows: null, fee: null }))
                .to.equal(false);
        });

        it('accepts the same response once the action exists', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'DEPLOY', action_index: 2206, credits: null, debits: null,
                escrows: null, fee: null,
            })).to.equal(true);
        });

        it('a miss stays absent from the LRU, so the next read recomputes', function () {
            const db  = makeDb();
            const key = db._cacheKey('BTC', 2206);
            const miss = { credits: null, debits: null, escrows: null, fee: null };
            if (db._isCacheableAction(miss)) db._cacheSet(db._actionDataCache, key, miss);
            expect(db._cacheGet(db._actionDataCache, key)).to.be.undefined;
            // ...and the real row, once written, caches normally.
            const real = Object.assign({ action: 'DEPLOY', action_index: 2206 }, miss);
            if (db._isCacheableAction(real)) db._cacheSet(db._actionDataCache, key, real);
            expect(db._cacheGet(db._actionDataCache, key)).to.deep.equal(real);
        });
    });

    it('a state-bearing action stays absent from the LRU, so a later read recomputes', function () {
        const db  = makeDb();
        const key = db._cacheKey('BTC', 3508);
        // What getActionData does now: consult the cache, then write back only
        // when the response is cacheable.
        expect(db._cacheGet(db._actionDataCache, key)).to.be.undefined;
        const fresh = { action: 'DISPENSER', state: { give_remaining: '0', status: 'empty' } };
        if (db._isCacheableAction(fresh))
            db._cacheSet(db._actionDataCache, key, fresh);
        expect(db._cacheGet(db._actionDataCache, key)).to.be.undefined;
    });
});
