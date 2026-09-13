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

    // The third member of the family, and the one the `state` guard could not
    // see. ATTEST / XCALL / VOTE / BET / DELEGATE carry their mutable lifecycle
    // as PLAIN COLUMNS, so a response with no `state` block was memoized in
    // whatever state it was first read in - with no TTL and reorg-only
    // invalidation, for the life of the process.
    //
    // Measured on regtest (explorer E2E session 10): after an ATTEST v2 expiry,
    // /rdoge/api/action/460 kept reporting `request_status: pending` while
    // /rdoge/api/attestations reported `expired` for the same action. ATTEST v2
    // writes no row of its own - it only flips the v0 request row's column - so
    // nothing about the cached payload's shape said it had gone stale.
    describe('[REGRESSION] a mutable lifecycle response must not be memoized', function () {

        it('refuses a pending ATTEST request, whose request_status still flips', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'ATTEST', action_index: 460, version: 0,
                request_id: 'ab'.repeat(32), request_status: 'pending',
                deadline_block: 1200, resolved_block: null, response_status: null,
            })).to.equal(false);
        });

        it('refuses the same ATTEST once expired, since the shape cannot prove a value is terminal', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'ATTEST', action_index: 460, version: 0,
                request_status: 'expired', resolved_block: 1201,
            })).to.equal(false);
        });

        it('refuses a pending XCALL, whose request_status and result_status both land later', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'XCALL', action_index: 512, version: 0, call_id: 'cd'.repeat(32),
                request_status: 'pending', result_status: null, resolved_block: null,
                execution: null, callback_delivery: null,
            })).to.equal(false);
        });

        it('refuses a VOTE poll and a BET feed/wager, the same defect on other columns', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'VOTE', action_index: 700, vote_kind: 'poll',
                poll_status: 'open', total_voters: 0, resolved_block: null,
            })).to.equal(false);
            expect(db._isCacheableAction({
                action: 'BET', action_index: 701, bet_kind: 'feed', feed_status: 'open',
            })).to.equal(false);
            expect(db._isCacheableAction({
                action: 'BET', action_index: 702, bet_kind: 'bet',
                bet_status: 'open', settled_block: null,
            })).to.equal(false);
        });

        it('refuses a DELEGATE, whose deactivation_block is written by a later revoke', function () {
            const db = makeDb();
            expect(db._isCacheableAction({
                action: 'DELEGATE', action_index: 703,
                activation_block: 900, deactivation_block: null,
            })).to.equal(false);
        });

        // Presence, not value: null IS the pending state, and it is precisely the
        // read that goes stale. A value test would cache exactly the wrong rows.
        it('a null lifecycle field blocks caching just as a populated one does', function () {
            const db = makeDb();
            expect(db._isCacheableAction({ action: 'XCALL', action_index: 512, resolved_block: null }))
                .to.equal(false);
        });

        // The guard must stay narrow: the ordinary immutable actions are the
        // reason the LRU exists at all.
        it('still caches the action types that carry no lifecycle column', function () {
            const db = makeDb();
            expect(db._isCacheableAction({ action: 'SEND', action_index: 7, status: 'valid' })).to.equal(true);
            expect(db._isCacheableAction({ action: 'ISSUE', action_index: 8, status: 'valid', tick: 'PEPECREATURE' }))
                .to.equal(true);
        });

        it('a pending ATTEST stays absent from the LRU, so the next read sees the expiry', function () {
            const db  = makeDb();
            const key = db._cacheKey('RDOGE', 460);
            const pending = { action: 'ATTEST', action_index: 460, request_status: 'pending' };
            if (db._isCacheableAction(pending)) db._cacheSet(db._actionDataCache, key, pending);
            expect(db._cacheGet(db._actionDataCache, key)).to.be.undefined;
        });

        // Drift guard: a field listed here that no detail handler selects is dead
        // weight, and one a handler selects under another name never fires. Every
        // entry must be traceable to the SQL that produces it.
        it('every listed field is selected by an action-detail handler', function () {
            const fs   = require('fs');
            const path = require('path');
            const dir  = path.join(__dirname, '../../src/action-detail');
            const src  = fs.readdirSync(dir)
                .filter((f) => f.endsWith('.js'))
                .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
                .join('\n');
            for (const field of Database.MUTABLE_ACTION_FIELDS)
                expect(src, 'no action-detail handler produces ' + field).to.contain(field);
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
