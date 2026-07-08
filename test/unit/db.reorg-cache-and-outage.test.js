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
 * Regression tests for the 2026-07-03 platform-stability deepdive findings:
 *
 *   M-3: the id/action LRU caches (address_id, tick_id, action_data) were never
 *        invalidated on reorg, so after the indexer reassigned ^id / action_index
 *        the explorer could serve a different entity under the cached key. Fixed
 *        by mixing a per-coin reorg generation into the cache key and bumping it
 *        from the tip-poll loop when a reorg is observed in the blocks table.
 *
 *   M-4: doQuery swallowed a failed read into an empty result, so a transient DB
 *        outage looked like "no data". Fixed by throwing DbQueryError on a real
 *        failure (a successful empty SELECT still returns its empty array).
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database        = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });
const { DbQueryError } = Database;

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() { return new Database(mockExplorer); }
function cfg(overrides = {}) { return makeConfig({ coin: 'BTC', ...overrides }); }

// ---------------------------------------------------------------------------
// M-3: reorg-generation cache keying + invalidation
// ---------------------------------------------------------------------------

describe('M-3 reorg cache invalidation', function () {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    describe('_cacheKey / bumpReorgGeneration', function () {

        it('scopes the key to coin and current reorg generation', function () {
            expect(db._cacheKey('BTC', 5)).to.equal('BTC:0:5');
            expect(db._cacheKey('LTC', 5)).to.equal('LTC:0:5');   // coin-scoped
            db.bumpReorgGeneration('BTC');
            expect(db._cacheKey('BTC', 5)).to.equal('BTC:1:5');
            expect(db._cacheKey('LTC', 5)).to.equal('LTC:0:5');   // other coin untouched
        });

        it('makes a previously-cached entry unreachable after a reorg bump', function () {
            const key0 = db._cacheKey('BTC', 5);
            db._cacheSet(db._actionDataCache, key0, { marker: 'old' });
            expect(db._cacheGet(db._actionDataCache, db._cacheKey('BTC', 5))).to.deep.equal({ marker: 'old' });

            db.bumpReorgGeneration('BTC');
            // Same logical index, new generation: the stale entry is not returned.
            expect(db._cacheGet(db._actionDataCache, db._cacheKey('BTC', 5))).to.be.undefined;
        });
    });

    describe('getAddressId re-resolves after a reorg', function () {

        it('serves the cache until a reorg, then re-queries the DB', async function () {
            const stub = sinon.stub(db, 'doQuery').resolves([{ id: 42 }]);

            expect(await db.getAddressId(cfg(), 'addr1')).to.equal(42);
            expect(await db.getAddressId(cfg(), 'addr1')).to.equal(42);
            expect(stub.callCount).to.equal(1);   // second call served from cache

            // Reorg reassigns the id-space; the indexer now maps addr1 -> 99.
            db.bumpReorgGeneration('BTC');
            stub.resolves([{ id: 99 }]);
            expect(await db.getAddressId(cfg(), 'addr1')).to.equal(99);
            expect(stub.callCount).to.equal(2);   // cache invalidated, DB re-hit
        });
    });

    describe('getActionData re-resolves after a reorg', function () {

        it('does not serve the pre-reorg cached action under the same index', function () {
            const key = db._cacheKey('BTC', 7);
            db._cacheSet(db._actionDataCache, key, { action_index: 7, marker: 'pre-reorg' });
            expect(db._cacheGet(db._actionDataCache, db._cacheKey('BTC', 7))).to.have.property('marker', 'pre-reorg');

            db.bumpReorgGeneration('BTC');
            expect(db._cacheGet(db._actionDataCache, db._cacheKey('BTC', 7))).to.be.undefined;
        });
    });

    describe('checkReorgAndInvalidate (tip-poll detection)', function () {

        // Route doQuery by SQL: the tip query vs the previous-height hash probe.
        function stubTip(db, tipRow, atRow) {
            return sinon.stub(db, 'doQuery').callsFake(async (config, query) => {
                if (query.includes('ORDER BY block_index DESC')) return tipRow;
                if (query.includes('WHERE block_index=?'))       return atRow;
                return [];
            });
        }

        it('seeds the tip on first poll without invalidating', async function () {
            stubTip(db, [{ block_index: 100, block_hash: 'h100' }], []);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(false);
            expect(db._reorgGen.BTC || 0).to.equal(0);
            expect(db._lastTip.BTC).to.deep.equal({ index: 100, hash: 'h100' });
        });

        it('does NOT invalidate on a clean append (height up, prior-height hash intact)', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            stubTip(db, [{ block_index: 101, block_hash: 'h101' }], [{ block_hash: 'h100' }]);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(false);
            expect(db._reorgGen.BTC || 0).to.equal(0);
            expect(db._lastTip.BTC).to.deep.equal({ index: 101, hash: 'h101' });
        });

        it('invalidates when the tip height rewinds', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            stubTip(db, [{ block_index: 98, block_hash: 'h98b' }], []);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(true);
            expect(db._reorgGen.BTC).to.equal(1);
        });

        it('invalidates when the same height carries a different block hash', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            stubTip(db, [{ block_index: 100, block_hash: 'h100b' }], [{ block_hash: 'h100b' }]);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(true);
            expect(db._reorgGen.BTC).to.equal(1);
        });

        it('invalidates on a rewind-and-extend (prior height hash changed, tip higher)', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            stubTip(db, [{ block_index: 102, block_hash: 'h102' }], [{ block_hash: 'h100b' }]);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(true);
            expect(db._reorgGen.BTC).to.equal(1);
        });

        it('invalidates when the block at the prior tip height has vanished', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            stubTip(db, [{ block_index: 105, block_hash: 'h105' }], []);   // no row at height 100
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(true);
            expect(db._reorgGen.BTC).to.equal(1);
        });

        it('does nothing on an empty chain (no blocks yet)', async function () {
            stubTip(db, [], []);
            const reorg = await db.checkReorgAndInvalidate(cfg());
            expect(reorg).to.equal(false);
            expect(db._lastTip.BTC).to.be.undefined;
        });

        it('does NOT spuriously invalidate on a transient read failure', async function () {
            db._lastTip.BTC = { index: 100, hash: 'h100' };
            sinon.stub(db, 'doQuery').rejects(new DbQueryError('outage'));
            let err = null;
            try { await db.checkReorgAndInvalidate(cfg()); } catch (e) { err = e; }
            expect(err).to.be.an('error');               // propagates to the poll guard
            expect(db._reorgGen.BTC || 0).to.equal(0);   // no bump
            expect(db._lastTip.BTC).to.deep.equal({ index: 100, hash: 'h100' }); // tip unchanged
        });
    });
});

// ---------------------------------------------------------------------------
// M-4: failed read propagates instead of masquerading as an empty result
// ---------------------------------------------------------------------------

describe('M-4 DB outage propagates (getData)', function () {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getData rejects when the underlying data query fails', async function () {
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'doQuery').rejects(new DbQueryError('SQL query failed: gone'));

        let err = null;
        try { await db.getData(cfg({ data: { method: 'getSends', search: null } })); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.name).to.equal('DbQueryError');
    });

    it('getData still returns a successful empty result without throwing', async function () {
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, '']);
        sinon.stub(db, 'doQuery').resolves([]);   // successful empty SELECT

        const [data, total] = await db.getData(cfg({ data: { method: 'getSends', search: null } }));
        expect(data).to.deep.equal([]);
        expect(total).to.be.null;
    });
});

// ---------------------------------------------------------------------------
// M-4: /status stays resilient (a health endpoint must not 500 on a per-coin
// read failure now that doQuery throws)
// ---------------------------------------------------------------------------

describe('M-4 getStatus degrades a failed per-coin read to null', function () {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the status report with null block fields instead of throwing', async function () {
        // One serving coin with a pool present, but its block reads fail.
        db.pools = { BTC: { pool: {}, config: {} } };
        sinon.stub(db, 'getMaxBlockIndex').rejects(new DbQueryError('outage'));
        sinon.stub(db, 'getMaxBlockTime').rejects(new DbQueryError('outage'));
        sinon.stub(db, 'getDecoderTip').resolves(null);

        const [data] = await db.getStatus(cfg());
        expect(data).to.have.property('last_block');
        expect(data.last_block.BTC).to.be.null;
        expect(data.decoder_lag_blocks.BTC).to.be.null;
    });
});
