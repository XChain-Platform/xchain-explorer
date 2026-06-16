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
 * Unit tests for db.getCoinPriceUsd() — the Explorer leg of the price-oracle
 * pipeline (campaign gap "C2": hub oracle round -> price_snapshots -> Explorer
 * USD). The hub finalizes an oracle round into a price_snapshots row and serves
 * it via the `getprice` JSON-RPC; getCoinPriceUsd() fetches that and is what
 * feeds `coin.price.usd` in GET /{COIN}/api/network (db.getNetwork, db.js:~3705).
 *
 * The hub-side leg (real round -> finalized snapshot -> getprice) is covered by
 * xchain-hub/test/e2e/oracle.e2e.test.js. This closes the previously-untested
 * Explorer leg with a stub hub whose getprice response is shaped exactly like a
 * finalized round's (price string + finalized status), plus the two "invisible
 * walls" that hid this gap: the mainnet-only route gating, and graceful
 * degradation when no finalized round exists yet.
 */

'use strict';

const http        = require('http');
const proxyquire  = require('proxyquire');
const { expect }  = require('chai');
const Utility     = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

// No real MariaDB pool — getCoinPriceUsd touches no DB, only configInfo + the hub.
const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const ORACLE_BTC_USD = '100000.00000000';   // shape: 8-dp string, as the oracle publishes

// A throwaway hub JSON-RPC server. `respond(coinPair)` returns the `result` for a
// getprice call; tests swap it to simulate finalized / no-round / malformed. Every
// getprice hit is counted so caching can be asserted.
function startStubHub() {
    const state = {
        hits: 0,
        respond: (coinPair) => ({ coin_pair: coinPair, price: ORACLE_BTC_USD, status: 'finalized', round_number: 42 })
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
            if (parsed.method === 'getprice') {
                state.hits++;
                const coinPair = parsed.params && parsed.params.coin_pair;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: state.respond(coinPair) }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { error: 'unknown method' } }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            state.server = server;
            state.url = 'http://127.0.0.1:' + server.address().port;
            resolve(state);
        });
    });
}

function makeDb() {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    return new Database({ configInfo, util });
}

describe('Database#getCoinPriceUsd (C2: oracle -> Explorer USD)', function () {

    let hub;
    let savedHubUrl, savedCacheMs;

    beforeEach(async function () {
        savedHubUrl  = process.env.HUB_URL;
        savedCacheMs = process.env.PRICE_CACHE_MS;
        hub = await startStubHub();
        process.env.HUB_URL = hub.url;
        process.env.PRICE_CACHE_MS = '60000';
    });

    afterEach(function (done) {
        if (savedHubUrl === undefined) delete process.env.HUB_URL; else process.env.HUB_URL = savedHubUrl;
        if (savedCacheMs === undefined) delete process.env.PRICE_CACHE_MS; else process.env.PRICE_CACHE_MS = savedCacheMs;
        if (hub && hub.server) hub.server.close(() => done()); else done();
    });

    it('surfaces the finalized oracle USD price for a mainnet coin code', async function () {
        const db = makeDb();
        const usd = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(usd).to.equal(ORACLE_BTC_USD);
        expect(hub.hits).to.equal(1);   // it actually queried the hub
    });

    it('queries the hub for the correct {BASE}/USD pair', async function () {
        const db = makeDb();
        let seenPair = null;
        hub.respond = (coinPair) => { seenPair = coinPair; return { coin_pair: coinPair, price: '85.00000000', status: 'finalized', round_number: 7 }; };
        const usd = await db.getCoinPriceUsd({ coin: 'LTC' });
        expect(seenPair).to.equal('LTC/USD');
        expect(usd).to.equal('85.00000000');
    });

    it('returns null for a regtest route code (mainnet-only gating) without calling the hub', async function () {
        const db = makeDb();
        const usd = await db.getCoinPriceUsd({ coin: 'RBTC' });
        expect(usd).to.equal(null);
        expect(hub.hits).to.equal(0);   // gated before any hub call — this is why a regtest Explorer shows $0.00
    });

    it('returns null for a testnet route code (mainnet-only gating)', async function () {
        const db = makeDb();
        const usd = await db.getCoinPriceUsd({ coin: 'TDOGE' });
        expect(usd).to.equal(null);
        expect(hub.hits).to.equal(0);
    });

    it('returns null when no finalized round exists yet (hub reports no price data)', async function () {
        const db = makeDb();
        hub.respond = () => ({ error: 'no price data for BTC/USD' });
        const usd = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(usd).to.equal(null);
    });

    it('returns null for a non-positive / malformed price (rejects bad oracle data)', async function () {
        const db = makeDb();
        hub.respond = (coinPair) => ({ coin_pair: coinPair, price: '0', status: 'finalized' });
        const usd = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(usd).to.equal(null);
    });

    it('returns null when HUB_URL is unset', async function () {
        delete process.env.HUB_URL;
        const db = makeDb();
        const usd = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(usd).to.equal(null);
        expect(hub.hits).to.equal(0);
    });

    it('caches within PRICE_CACHE_MS — second call does not re-hit the hub', async function () {
        const db = makeDb();
        const a = await db.getCoinPriceUsd({ coin: 'BTC' });
        const b = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(a).to.equal(ORACLE_BTC_USD);
        expect(b).to.equal(ORACLE_BTC_USD);
        expect(hub.hits).to.equal(1);   // served from cache the second time
    });

    it('serves the last good value if a later hub fetch fails (cache fallback)', async function () {
        process.env.PRICE_CACHE_MS = '1';   // 1ms TTL so the cached value expires between calls
        const db = makeDb();
        const good = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(good).to.equal(ORACLE_BTC_USD);
        await new Promise((r) => setTimeout(r, 10));   // let the cache go stale
        hub.respond = () => ({ error: 'transient hub failure' });
        const fallback = await db.getCoinPriceUsd({ coin: 'BTC' });
        expect(fallback).to.equal(ORACLE_BTC_USD);   // prior good value reused, not null
        expect(hub.hits).to.equal(2);                // it re-fetched (cache was stale) before falling back
    });
});
