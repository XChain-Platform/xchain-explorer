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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, makeDb, cfg } = require('./helpers.js');
const { clearTipEnvironment, restoreTipEnvironment, configurePool } = require('./tip_freshness_helpers.js');

let db;
let savedEnv;

function setupTipTest() {
    db = makeDb();
    savedEnv = clearTipEnvironment();
}

function restoreTipTest() {
    restoreTipEnvironment(savedEnv);
    sinon.restore();
}

function poolWithBlockTime(coin, blockTime) {
    configurePool(db, coin, blockTime);
}

const status = require('../../../src/content/json/xchain-platform-api.json')
                .components.schemas.ExplorerStatus;


    // Puts the indexer `lag` blocks behind the decoder with its own tip dated
    // `tipAgeSec` in the PAST, which is the only shape this state ever has.
    function laggingBy(lag, tipAgeSec = 60) {
        poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - tipAgeSec);
        sinon.stub(db, 'getMaxBlockIndex').resolves(850);
        sinon.stub(db, 'getDecoderTip').resolves(850 + lag);
    }

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    // A consensus wait and a wedge look identical from outside, and shipping only
    // tip_future_seconds meant they stayed identical: that field measures the block
    // already COMMITTED, which is always past-dated, so it reads 0 for the entire
    // duration of the wait it appears to describe. An external report read a
    // steady-state testnet4 future-stamp wait as a stuck indexer on exactly that
    // evidence. These pin the discriminator that can actually tell them apart.
    describe('#getStatus indexer-state discriminator', () => {
        it('labels a future-dated next block as a consensus wait and says when it clears', async () => {
            laggingBy(12);
            const nextTime = Math.floor(Date.now() / 1000) + 1195;
            sinon.stub(db, 'getDecoderBlockTime').resolves(nextTime);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.indexer_state['RBTC']).to.equal('future_block_wait');
            expect(data.next_block_time['RBTC']).to.equal(nextTime);
            expect(data.next_block_future_seconds['RBTC']).to.be.within(1185, 1195);
            expect(data.indexer_wait_clears_at['RBTC']).to.equal(new Date(nextTime * 1000).toISOString());
        });

        it('reads the block being WAITED ON, not the one already committed', async () => {
            laggingBy(12);
            const stub = sinon.stub(db, 'getDecoderBlockTime').resolves(Math.floor(Date.now() / 1000) + 600);
            await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(stub.calledWith(sinon.match({ coin: 'RBTC' }), 851)).to.equal(true);
        });

        // The regression this whole field exists for: during a real wait the OLD
        // field reads a perfectly healthy 0. If this ever passes with a non-zero
        // tip_future_seconds, the discriminator has stopped being necessary and the
        // reasoning in the schema needs revisiting.
        it('stays honest while tip_future_seconds reads 0 through the same wait', async () => {
            laggingBy(12);
            sinon.stub(db, 'getDecoderBlockTime').resolves(Math.floor(Date.now() / 1000) + 1195);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_future_seconds['RBTC']).to.equal(0);
            expect(data.indexer_state['RBTC']).to.equal('future_block_wait');
            expect(data.next_block_future_seconds['RBTC']).to.be.above(0);
        });

        it('calls a next block that is already admissible `behind`, with no clearing time', async () => {
            laggingBy(12);
            sinon.stub(db, 'getDecoderBlockTime').resolves(Math.floor(Date.now() / 1000) - 30);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.indexer_state['RBTC']).to.equal('behind');
            expect(data.next_block_future_seconds['RBTC']).to.equal(0);
            expect(data.indexer_wait_clears_at['RBTC']).to.equal(null);
        });

        it('reports `live` with no next-block fields when the indexer is at the decoder tip', async () => {
            laggingBy(0);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.indexer_state['RBTC']).to.equal('live');
            expect(data.next_block_time['RBTC']).to.equal(null);
            expect(data.indexer_wait_clears_at['RBTC']).to.equal(null);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#getStatus indexer-state discriminator', () => {
        it('degrades to null rather than guessing when the decoder block_time is unreadable', async () => {
            laggingBy(12);
            sinon.stub(db, 'getDecoderBlockTime').resolves(null);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.indexer_state['RBTC']).to.equal(null);
            expect(data.next_block_time['RBTC']).to.equal(null);
            expect(data.next_block_future_seconds['RBTC']).to.equal(null);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#getDecoderBlockTime', () => {
        it('returns null for an unknown or unsafe decoder DB name instead of querying', async () => {
            const q = sinon.stub(db, 'doDecoderQuery').resolves([{ block_time: 123 }]);
            db.decoderDb = {};
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 5)).to.equal(null);
            db.decoderDb = { BTC: 'bad name; DROP TABLE' };
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 5)).to.equal(null);
            expect(q.called).to.equal(false);
        });

        it('binds the height rather than interpolating it', async () => {
            db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
            const q = sinon.stub(db, 'doDecoderQuery').resolves([{ block_time: 1787694027 }]);
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 851)).to.equal(1787694027);
            expect(q.firstCall.args[1]).to.match(/block_index = \?/);
            expect(q.firstCall.args[2]).to.deep.equal([851]);
        });

        it('returns null on a non-numeric height, a missing row, or a failed read', async () => {
            db.decoderDb = { BTC: 'XChain_BTC_Mainnet_Decoder' };
            const q = sinon.stub(db, 'doDecoderQuery').resolves([]);
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 'abc')).to.equal(null);
            expect(q.called).to.equal(false);
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 851)).to.equal(null);
            q.rejects(new Error('no cross-DB grant'));
            expect(await db.getDecoderBlockTime({ coin: 'BTC' }, 851)).to.equal(null);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    // The published schema is the contract third parties code against, and it is
    // served as a static asset that no other suite compares to the producer. That is
    // how it kept describing `available` as a fixed config echo for the whole life of
    // the freshness gate. Pinning it to getStatus makes the next field addition fail
    // here instead of shipping a wrong contract.
    describe('published OpenAPI contract for /status', () => {
        it('documents every field getStatus returns, and no field it does not', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            const [data]   = await db.getStatus(cfg({ coin: 'RBTC' }));
            const returned = Object.keys(data).sort();
            const declared = Object.keys(status.properties).sort();
            expect(returned.filter((k) => !declared.includes(k)),
                'fields /status returns that ExplorerStatus does not declare').to.deep.equal([]);
            expect(declared.filter((k) => !returned.includes(k)),
                'fields ExplorerStatus declares that /status does not return').to.deep.equal([]);
        });

        it('describes available as gate-filtered rather than a static config echo', () => {
            expect(status.properties.available.description).to.match(/stale/i);
            expect(status.properties.available.description).to.match(/supported/);
        });

        it('describes stale and tip_age_seconds, including the fail-closed default', () => {
            expect(status.properties.stale.description).to.match(/EXPLORER_TIP_MAX_AGE_S/);
            expect(status.properties.stale.description).to.match(/21600/);
            expect(status.properties.stale.description).to.match(/available/);
            expect(status.properties.stale.additionalProperties.type).to.equal('boolean');
            expect(status.properties.tip_age_seconds.description).to.match(/seconds/i);
            expect(status.properties.tip_age_seconds.additionalProperties.type)
                .to.deep.equal(['integer', 'null']);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('published OpenAPI contract for /status', () => {

        it('states that tip_age_seconds is never negative and that tip_future_seconds carries the skew', () => {
            expect(status.properties.tip_age_seconds.description).to.match(/never negative|non-negative/i);
            expect(status.properties.tip_age_seconds.description).to.match(/tip_future_seconds/);
            expect(status.properties.tip_future_seconds.description).to.match(/ahead/i);
            expect(status.properties.tip_future_seconds.description).to.match(/EXPLORER_TIP_MAX_FUTURE_SKEW_S/);
            expect(status.properties.tip_future_seconds.additionalProperties.type)
                .to.deep.equal(['integer', 'null']);
        });

        it('documents the three indexer_state values and points readers away from tip_future_seconds', () => {
            const d = status.properties.indexer_state.description;
            expect(d).to.match(/future_block_wait/);
            expect(d).to.match(/'live'/);
            expect(d).to.match(/'behind'/);
            // The trap that produced the false report: say plainly that the older
            // field cannot answer this, or the next integrator repeats it.
            expect(d).to.match(/tip_future_seconds/);
            expect(d).to.match(/reads 0|always past-dated/i);
            expect(status.properties.indexer_state.additionalProperties.type)
                .to.deep.equal(['string', 'null']);
        });

        it('documents the next-block fields as measuring the block being waited on', () => {
            expect(status.properties.next_block_time.description).to.match(/last_block \+ 1/);
            expect(status.properties.next_block_future_seconds.description).to.match(/ahead/i);
            expect(status.properties.indexer_wait_clears_at.description).to.match(/ISO-8601/);
            expect(status.properties.indexer_wait_clears_at.additionalProperties.type)
                .to.deep.equal(['string', 'null']);
        });
    });
});

// Marks the coin as measured (getStatus's per-coin gate only runs for a
// coin with a live pool); doQuery is stubbed directly below so no real
// connection is ever opened through this placeholder pool object.
function markPooled(coin) {
    db.pools = {};
    db.pools[coin] = { pool: {}, config: {} };
}

// Dispatches by SQL text so the same stub answers the existence check,
// the halt-row read, AND the unrelated last_block/last_block_time queries
// getStatus also issues in the same per-coin pass. A fresh block_time
// keeps `stale` out of the way of these assertions.
function stubQueries({ tableExists = true, activeHalt = false, failOn = null } = {}) {
    return sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
        if (/information_schema\.TABLES/.test(query)) {
            if (failOn === 'exists') throw new Error('existence check failed');
            return tableExists ? [{ 1: 1 }] : [];
        }
        if (/FROM sync_halt/.test(query)) {
            if (failOn === 'halt') throw new Error('halt read failed');
            expect(query).to.match(/cleared_at IS NULL/);
            expect(args).to.deep.equal(['indexer']);
            return activeHalt ? [{ id: 1 }] : [];
        }
        if (/MAX\(block_index\)/.test(query)) return [{ max_index: 850 }];
        if (/block_time/.test(query)) return [{ block_time: Math.floor(Date.now() / 1000) - 60 }];
        return [];
    });
}

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    // replica_halted publishes xchain-sync's durable consensus-divergence halt
    // (sync_halt, cleared_at IS NULL) beside `stale`, since a halted replica keeps
    // reporting a small lag until its source mints past it and neither `stale` nor
    // tip_age_seconds can see that state (2026-08-10: two chains sat halted a full
    // day while every existing instrument read green). null must never collapse to
    // false: a consumer reads false as healthy, and this field exists precisely
    // because an absent signal was mistaken for a good one.
    describe('Database#getStatus replica_halted (fail-closed halt signal)', () => {
        beforeEach(() => { db = makeDb(); });
        afterEach(() => { sinon.restore(); });

        it('reads true when an active (uncleared) halt row exists', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: true });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted).to.have.property('RBTC', true);
        });

        it('reads false when the table was read successfully and holds no active halt', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: false });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted).to.have.property('RBTC', false);
        });

        it('reads null, never false, when the sync_halt table does not exist', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: false });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });

        it('reads null, never false, when the table-existence check itself fails', async () => {
            markPooled('RBTC');
            stubQueries({ failOn: 'exists' });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('Database#getStatus replica_halted (fail-closed halt signal)', () => {
        beforeEach(() => { db = makeDb(); });
        afterEach(() => { sinon.restore(); });

        it('reads null, never false, when the halt-row read fails after the table is confirmed present', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, failOn: 'halt' });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.replica_halted.RBTC).to.equal(null);
            expect(data.replica_halted.RBTC).to.not.equal(false);
        });

        it('does not remove a halted coin from `available` (stale composes separately, out of scope here)', async () => {
            markPooled('RBTC');
            stubQueries({ tableExists: true, activeHalt: true });
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.available).to.have.property('RBTC');
        });

        it('reads null directly (no pool for the coin) rather than false', async () => {
            db.pools = {};
            const result = await db.getReplicaHaltStatus('ZZZ');
            expect(result).to.equal(null);
        });
    });
});
