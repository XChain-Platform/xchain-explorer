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
        expect(db._isCacheableAction({ state: null })).to.equal(true);
        expect(db._isCacheableAction({ state: '' })).to.equal(true);
        expect(db._isCacheableAction(null)).to.equal(true);
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
