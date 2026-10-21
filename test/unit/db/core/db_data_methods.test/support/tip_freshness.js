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
const { resolveRoute }       = require('../../../../../../src/explorer/request/resolve_route.js');
const { applyFallbacks }     = require('../../../../../../src/explorer/request/not_found.js');
const { sendResponse }       = require('../../../../../../src/explorer/request/send_response.js');
const { buildFederationRpc, NOT_READY } = require('../../../../../../src/federation');
const WebSocketServer        = require('../../../../../../src/ws/websocket_server.js');

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
    // The fake pool answers every query with a row, which the halt read would
    // take for an uncleared sync_halt row; default to no halt.
    db.getReplicaHaltStatus = async () => false;
}

// The freshness gate that stops a frozen replica advertising itself as available.
// decoder_lag_blocks cannot see a JOINT indexer+decoder freeze (it is an intra-replica
// difference that reads 0 in that state), so the gate measures wall-clock instead.
describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#tipMaxAgeSeconds', () => {
        it('defaults to 6 hours when no env override is set', () => {
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(21600);
        });

        it('honours the global EXPLORER_TIP_MAX_AGE_S override', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = '120';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(120);
        });

        it('lets a per-coin override win over the global one', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S      = '120';
            process.env.EXPLORER_TIP_MAX_AGE_S_RBTC = '900';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(900);
            expect(db.tipMaxAgeSeconds('BTC')).to.equal(120);
        });

        it('ignores a non-numeric override rather than reading it as 0 (which would disable the gate)', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = 'off';
            expect(db.tipMaxAgeSeconds('RBTC')).to.equal(21600);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#tipMaxFutureSkewSeconds', () => {
        it('defaults to 2 hours when no env override is set', () => {
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(7200);
        });

        it('honours the global override and lets a per-coin override win', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S      = '60';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(60);
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '900';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(900);
            expect(db.tipMaxFutureSkewSeconds('BTC')).to.equal(60);
        });

        it('ignores a non-numeric override rather than reading it as 0 (which would disable the check)', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S = 'off';
            expect(db.tipMaxFutureSkewSeconds('RBTC')).to.equal(7200);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#isTipStale', () => {
        const NOW = 1800000000;

        it('is false for a tip inside the window', () => {
            expect(db.isTipStale('RBTC', NOW - 60, NOW)).to.equal(false);
        });

        it('is true for a tip past the window', () => {
            expect(db.isTipStale('RBTC', NOW - 21601, NOW)).to.equal(true);
        });

        it('fails closed on a 0 / null / non-numeric block_time', () => {
            expect(db.isTipStale('RBTC', 0, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', null, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', 'soon', NOW)).to.equal(true);
        });

        it('is disabled by an explicit 0 threshold, even for a missing block_time', () => {
            process.env.EXPLORER_TIP_MAX_AGE_S = '0';
            expect(db.isTipStale('RBTC', NOW - 999999, NOW)).to.equal(false);
            expect(db.isTipStale('RBTC', null, NOW)).to.equal(false);
        });

        // Skew inside the tolerance stays healthy; past it the tip stops counting
        // as evidence of freshness at all.
        it('tolerates a tip dated modestly ahead of the host clock', () => {
            expect(db.isTipStale('RBTC', NOW + 6649, NOW)).to.equal(false);
        });

        it('is true for a tip dated further ahead than the skew tolerance allows', () => {
            expect(db.isTipStale('RBTC', NOW + 7201, NOW)).to.equal(true);
            expect(db.isTipStale('RBTC', NOW + 86400 * 365, NOW)).to.equal(true);
        });

        it('honours a per-coin skew tolerance and its explicit 0 opt-out', () => {
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '60';
            expect(db.isTipStale('RBTC', NOW + 61, NOW)).to.equal(true);
            process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S_RBTC = '0';
            expect(db.isTipStale('RBTC', NOW + 86400 * 365, NOW)).to.equal(false);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#isCoinTipStale', () => {
        it('reads the indexer tip and caches the verdict', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            expect(await db.isCoinTipStale('RBTC')).to.equal(false);
            const calls = db.pools['RBTC'].pool.getConnection.callCount;
            expect(await db.isCoinTipStale('RBTC')).to.equal(false);
            expect(db.pools['RBTC'].pool.getConnection.callCount).to.equal(calls);   // served from cache
        });

        it('fails closed when the indexer read throws', async () => {
            sinon.stub(db, 'getMaxBlockTime').rejects(new Error('db down'));
            expect(await db.isCoinTipStale('RBTC')).to.equal(true);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    // The snapshot every data response is annotated with. One cache fill per
    // coin per TTL: the boolean verdict above is a view of it.
    describe('#getCoinFreshness', () => {
        it('reports the tip block, its age, the stale verdict and the halt signal for a stale coin', async () => {
            poolWithBlockTime('RBTC', 1700000000);            // years old
            const f = await db.getCoinFreshness('RBTC');
            expect(f.stale).to.equal(true);
            expect(f.tip_block).to.equal(850);
            expect(f.tip_time).to.equal(1700000000);
            expect(f.tip_age_seconds).to.be.above(21600);
            expect(f.max_age_seconds).to.equal(21600);
            expect(f.replica_halted).to.be.a('boolean');
        });

        it('reports a fresh coin with no halt as live and not halted', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            sinon.stub(db, 'getReplicaHaltStatus').resolves(false);
            const f = await db.getCoinFreshness('RBTC');
            expect(f.stale).to.equal(false);
            expect(f.replica_halted).to.equal(false);
        });

        // Young tip + uncleared sync_halt row: every surface gives one verdict.
        it('gives the same stale verdict on every surface for a young tip with an active halt', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            sinon.stub(db, 'getReplicaHaltStatus').resolves(true);
            const f = await db.getCoinFreshness('RBTC');
            // header / WS WELCOME marker / 503 gate all read these
            expect(f.stale).to.equal(true);
            expect(f.replica_halted).to.equal(true);
            expect(await db.isCoinTipStale('RBTC')).to.equal(true);
            // /status: stale, delisted from available only under the opt-in
            let [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale['RBTC']).to.equal(true);
            expect(data.replica_halted['RBTC']).to.equal(true);
            process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
            expect(db.staleFailClosed()).to.equal(true);
            [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale['RBTC']).to.equal(true);
            expect(data.available['RBTC']).to.equal(undefined);
            // the federation read is pinned end to end in 'one verdict on every surface'
        });

        it('reads as stale with null tip fields when the indexer is unreadable', async () => {
            sinon.stub(db, 'getMaxBlockTime').rejects(new Error('db down'));
            const f = await db.getCoinFreshness('RBTC');
            expect(f.stale).to.equal(true);
            expect(f.tip_block).to.equal(null);
            expect(f.tip_age_seconds).to.equal(null);
        });

        it('serves the boolean verdict and the snapshot from one cache fill', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            await db.getCoinFreshness('RBTC');
            const calls = db.pools['RBTC'].pool.getConnection.callCount;
            expect(await db.isCoinTipStale('RBTC')).to.equal(false);
            expect(db.pools['RBTC'].pool.getConnection.callCount).to.equal(calls);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#staleFailClosed', () => {
        it('is off unless EXPLORER_STALE_FAIL_CLOSED=1', () => {
            expect(db.staleFailClosed()).to.equal(false);
            process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
            expect(db.staleFailClosed()).to.equal(true);
            process.env.EXPLORER_STALE_FAIL_CLOSED = 'true';
            expect(db.staleFailClosed()).to.equal(false);
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#getStatus availability gating', () => {
        // A stale coin is served with a marker, so it stays listed: `stale` is
        // the signal now, and delisting it made every client read the coin as
        // not served at all.
        it('keeps a coin with a stale tip in `available` and reports it in `stale`', async () => {
            poolWithBlockTime('RBTC', 1700000000);            // years old
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale).to.have.property('RBTC', true);
            expect(data.tip_age_seconds['RBTC']).to.be.above(21600);
            expect(data.available).to.have.property('RBTC');
            expect(data.supported).to.have.property('RBTC');
        });

        it('drops a stale coin from `available` only under the EXPLORER_STALE_FAIL_CLOSED opt-in', async () => {
            process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
            poolWithBlockTime('RBTC', 1700000000);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale).to.have.property('RBTC', true);
            expect(data.available).to.not.have.property('RBTC');
            expect(data.supported).to.have.property('RBTC');   // still a known coin
        });

        it('keeps a coin with a fresh tip available', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.stale).to.have.property('RBTC', false);
            expect(data.available).to.have.property('RBTC');
        });

        it('does not mutate the shared hub-config COIN_AVAILABLE map when it drops a coin', async () => {
            process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
            poolWithBlockTime('RBTC', 1700000000);
            const [data]  = await db.getStatus(cfg({ coin: 'RBTC' }));
            const fullCfg = await configInfo.getConfig();
            expect(data.available).to.not.have.property('RBTC');
            expect(fullCfg['COIN_AVAILABLE']).to.have.property('RBTC');
        });

        it('leaves an unmeasured coin (no pool here) alone rather than delisting it', async () => {
            db.pools = {};
            const [data]  = await db.getStatus(cfg());
            const fullCfg = await configInfo.getConfig();
            expect(data.available).to.deep.equal(fullCfg['COIN_AVAILABLE']);
            expect(Object.keys(data.stale)).to.have.lengthOf(0);
        });

        it('reports tip_age_seconds 0 and the skew in tip_future_seconds for a future-dated tip', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 6649);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(0);
            expect(data.tip_future_seconds['RBTC']).to.be.within(6640, 6649);
            expect(data.stale).to.have.property('RBTC', false);   // inside the tolerance
            expect(data.available).to.have.property('RBTC');
        });
    });
});

describe('Database tip-freshness gate', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    describe('#getStatus availability gating', () => {
        it('classes a tip dated far ahead as stale instead of letting it read fresher than fresh', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 86400 * 30);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(0);
            expect(data.tip_future_seconds['RBTC']).to.be.above(7200);
            expect(data.stale).to.have.property('RBTC', true);
            expect(data.available).to.have.property('RBTC');   // served and marked, like any stale coin
        });

        it('reports tip_future_seconds 0 for an ordinary past-dated tip, and null when block_time is unusable', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) - 60);
            let [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_future_seconds['RBTC']).to.equal(0);
            poolWithBlockTime('RBTC', null);
            [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(data.tip_age_seconds['RBTC']).to.equal(null);
            expect(data.tip_future_seconds['RBTC']).to.equal(null);
        });

        it('never publishes a negative tip_age_seconds for any measured coin', async () => {
            poolWithBlockTime('RBTC', Math.floor(Date.now() / 1000) + 99999);
            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));
            for (const [coin, age] of Object.entries(data.tip_age_seconds)) {
                expect(age === null || age >= 0, `tip_age_seconds[${coin}] = ${age}`).to.equal(true);
            }
        });
    });
});

// A pool that answers by statement, so the real halt read runs: a young tip and
// an uncleared sync_halt row (or none), with nothing stubbed on the db itself.
function poolWithHaltRow(coin, blockTime, haltActive) {
    db.pools = {};
    db.pools[coin] = {
        pool: {
            getConnection: sinon.stub().resolves({
                query: sinon.stub().callsFake(async (sql) => {
                    if (/information_schema/.test(sql)) return [{ 1: 1 }];
                    if (/FROM sync_halt/.test(sql))     return haltActive ? [{ id: 1 }] : [];
                    return [{ max_index: 850, block_time: blockTime }];
                }),
                release: sinon.stub().resolves()
            })
        },
        config: {}
    };
}

// Drive one data request through the real route stage, the real 503 fallback and
// the real response writer; returns what the client would see.
async function httpAnswer(coin) {
    const explorer = { db, util: db.util, headers: {}, urls: { api: {}, explorer: {}, html: {} } };
    const st = {
        config:   { COIN_SUPPORTED: { [coin]: 'x' }, COIN_AVAILABLE: { [coin]: 'x' } },
        cfg:      { coin: null, type: null, file: null, data: { method: null, offset: {} } },
        response: { code: 200, json: { rows: [] }, html: null, time: null },
        debugTimer: { started: true }, data: [], total: 0, dbError: false, badParam: false
    };
    await resolveRoute(explorer, { path: '/' + coin + '/api/blocks', query: {} }, st);
    st.cfg.data.method = 'getBlocks';
    applyFallbacks(explorer, st);
    const out = { headers: {}, status: null, body: null };
    sendResponse(explorer, { path: '/' + coin + '/api/blocks' }, {
        set(a, b) { if (typeof a === 'object') Object.assign(out.headers, a); else out.headers[a] = b; },
        status(c)  { out.status = c; },
        send(b)    { out.body = JSON.parse(b); }
    }, st, { configEnv: () => ({}), stats: { record() {}, slow() {} } });
    return out;
}

async function welcomeFrame(coin) {
    const frames = [];
    const server = new WebSocketServer({ explorer: { db, version: '1.0.0' }, broadcaster: null });
    await server.sendWelcome({
        id: 1, coin, chain: 'BTC', network: 'regtest', subscriptions: new Set(),
        ws: { readyState: 1, send: (raw) => frames.push(JSON.parse(raw)) }
    });
    return frames.find((f) => f.type === 'WELCOME');
}

async function federationAnswer(coin) {
    const rpc = buildFederationRpc(() => ({ db }), {
        env: {},
        getConfig: async () => ({ COIN_NETWORKS: { BTC: 'Bitcoin' }, COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' } })
    });
    try { return await rpc.getanchoraction({}, { req: { path: '/' + coin + '/api/' } }); }
    catch (e) { return { thrown: e.message }; }
}

// The row's acceptance: a coin with a young tip and an uncleared sync_halt row
// gets one verdict from the XChain-Freshness header, the WS WELCOME marker, the
// opt-in 503, /status and the federation read. Each surface runs its real code
// over the same real db; only the pool underneath answers canned rows.
describe('Database tip-freshness gate: one verdict on every surface', () => {
    beforeEach(setupTipTest);
    afterEach(restoreTipTest);

    const young = () => Math.floor(Date.now() / 1000) - 60;

    for (const haltActive of [true, false]) {
        const label = haltActive ? 'active' : 'cleared';

        it('agrees across header, WS WELCOME, status and federation for a young tip, halt ' + label, async () => {
            poolWithHaltRow('RBTC', young(), haltActive);

            const http = await httpAnswer('RBTC');
            expect(http.status).to.equal(200);
            expect(http.headers['XChain-Freshness']).to.equal(haltActive ? 'stale' : 'live');
            expect(!!http.body.freshness).to.equal(haltActive);

            const welcome = await welcomeFrame('RBTC');
            expect(!!welcome.stale).to.equal(haltActive);
            expect(!!welcome.data.stale).to.equal(haltActive);

            const [status] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(status.stale['RBTC']).to.equal(haltActive);
            expect(status.available).to.have.property('RBTC');   // marked, still listed

            const fed = await federationAnswer('RBTC');
            if (haltActive) expect(fed).to.deep.equal({ error: NOT_READY });
            else expect(fed.error).to.not.equal(NOT_READY);
        });

        it('agrees on the opt-in refusal for a young tip, halt ' + label, async () => {
            process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
            poolWithHaltRow('RBTC', young(), haltActive);

            const http = await httpAnswer('RBTC');
            expect(http.status).to.equal(haltActive ? 503 : 200);
            if (haltActive) expect(http.body.code).to.equal('COIN_DATA_STALE');

            const [status] = await db.getStatus(cfg({ coin: 'RBTC' }));
            expect(status.stale['RBTC']).to.equal(haltActive);
            expect(status.available.RBTC === undefined).to.equal(haltActive);
        });
    }
});
