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
 * Unit tests for the /{COIN}/api/network action-total counters cache
 * (Database#getActionTotals).
 *
 * The counters are exact COUNT(*)s over tables the indexer only rewrites when
 * it applies a block, so a set of counts belongs to the block it was counted at.
 * A cache keyed on the coin alone with a flat TTL would let counts taken while
 * a coin was mid-recovery from a 503 COIN_DATA_STALE keep answering the
 * homepage for the rest of that TTL after the coin was healthy again; keying
 * the entry on the tip instead closes that gap.
 *
 * Verifies:
 *   - a repeated call at the same tip is served from cache
 *   - a moved tip re-counts inside the TTL
 *   - a reorg (bumped reorg generation) re-counts inside the TTL
 *   - the TTL still expires an entry at an unmoved tip
 *   - a failed tip probe neither reads nor writes the cache
 *   - coins do not share an entry
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

// getActionTotals issues four shapes of query through doQuery: the tip probe
// (via _totalsTipGeneration), the information_schema existence check, the
// UNION ALL of COUNT(*)s, and the full_node_verifications DISTINCT count. Route
// each to a canned answer so the suite exercises the cache, not the pool.
// `state` is mutable so a test can move the tip or change the counts.
function stubQueries(db, state) {
    return sinon.stub(db, 'doQuery').callsFake(async (config, sql) => {
        if (/MAX\(block_index\)/.test(sql)) {
            if (state.failTip) throw new Error('pool gone');
            return [{ tip: state.tip }];
        }
        if (/information_schema/i.test(sql))  return [{ TABLE_NAME: 'sends' }];
        if (/full_node_verifications/.test(sql)) return [{ count: 0 }];
        state.counts++;
        return [{ t: 'sends', c: state.sends }];
    });
}

function makeDb(state) {
    const db = new Database(mockExplorer);
    db.pools = { BTC: { config: { database: 'xchain_btc' }, pool: {} },
                 LTC: { config: { database: 'xchain_ltc' }, pool: {} } };
    stubQueries(db, state);
    return db;
}

function cfg(coin = 'BTC') {
    return makeConfig({ coin, data: { method: 'getNetwork' } });
}

describe('Database#getActionTotals cache', () => {
    let state, db;

    beforeEach(() => {
        // Probe the tip on every call so the tests drive the generation directly
        // rather than the memo window.
        process.env.EXPLORER_TIP_MEMO_MS = '0';
        state = { tip: 100, sends: 7, counts: 0, failTip: false };
        db = makeDb(state);
    });

    afterEach(() => {
        sinon.restore();
        delete process.env.EXPLORER_TIP_MEMO_MS;
        delete process.env.EXPLORER_TOTALS_CACHE_MS;
    });

    it('serves a repeated call at the same tip from cache', async () => {
        const a = await db.getActionTotals(cfg());
        const b = await db.getActionTotals(cfg());
        expect(a.sends).to.equal(7);
        expect(b.sends).to.equal(7);
        expect(state.counts, 'one COUNT(*) pass for both calls').to.equal(1);
    });

    // This is the whole item: counts read while a coin was still catching up
    // must not answer for the rest of the TTL once it has caught up.
    it('re-counts once the indexed tip moves, within the TTL', async () => {
        const stale = await db.getActionTotals(cfg());
        expect(stale.sends).to.equal(7);

        state.tip   = 101;
        state.sends = 4242;
        const fresh = await db.getActionTotals(cfg());
        expect(state.counts, 'a new tip is a new generation, so the counts are re-read').to.equal(2);
        expect(fresh.sends, 'the recovered coin reports its real totals immediately').to.equal(4242);
    });

    it('re-counts after a reorg bumps the coin generation, within the TTL', async () => {
        await db.getActionTotals(cfg());
        db._reorgGen.BTC = (db._reorgGen.BTC || 0) + 1;
        state.sends = 5;
        const after = await db.getActionTotals(cfg());
        expect(state.counts).to.equal(2);
        expect(after.sends).to.equal(5);
    });

    it('still expires an entry on the TTL at an unmoved tip', async () => {
        await db.getActionTotals(cfg());
        // Expiry is a stored timestamp: rewind the entry rather than sleep it out.
        for (const key of Object.keys(db._totalsCache))
            db._totalsCache[key].at -= 60 * 60 * 1000;
        state.sends = 9;
        const after = await db.getActionTotals(cfg());
        expect(state.counts).to.equal(2);
        expect(after.sends).to.equal(9);
    });

    it('neither reads nor writes the cache when the tip probe fails', async () => {
        // A tip probe that throws means the freshness check itself is broken; the
        // counts are still served (the caller gets real numbers), they are just
        // not cached, so nothing possibly-stale outlives the outage.
        state.failTip = true;
        const a = await db.getActionTotals(cfg());
        const b = await db.getActionTotals(cfg());
        expect(a.sends).to.equal(7);
        expect(b.sends).to.equal(7);
        expect(state.counts, 'no freshness check means no caching').to.equal(2);
        expect(Object.keys(db._totalsCache || {}).length,
            'a failed probe writes nothing to the cache').to.equal(0);
    });

    it('does not let one coin answer for another', async () => {
        await db.getActionTotals(cfg('BTC'));
        state.sends = 11;
        const ltc = await db.getActionTotals(cfg('LTC'));
        expect(state.counts).to.equal(2);
        expect(ltc.sends).to.equal(11);
    });
});
