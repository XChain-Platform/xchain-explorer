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
 *
 * GET /{COIN}/api/price_history against the real DDL: one statement per source
 * (plus the DEX window's block bounds)
 * whatever the asset count, the last finalized oracle round per bucket, DEX
 * fills priced the way /market/{TICK1}/{TICK2}/history prices them, no series
 * (never zeros) for an asset with no data, and an oracle source that is
 * reported unavailable rather than empty when no hub mirror is configured.
 *
 *********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { makeConfig } = require('../../../fixtures/mock-query-args.js');
const { openWalletTables, clearTables, buildExplorer, routeHandler, drive, insert, HUB_SCHEMA } = require('./support/wallet_fixture.js');

const HOUR = 3600;
const T0   = 1700000000 - (1700000000 % HOUR);

let sqlite, explorer, seen, priceRoute;

// Rounds every 10 minutes for 6 hours, hour 3 left empty; the last round of
// hour 1 is skipped, so its finalized close is the round before it.
function seedOracle(){
    for(const pair of ['BTC/USD', 'XCHAIN/USD']){
        for(let i = 0; i < 36; i++){
            if(Math.floor(i / 6) === 3) continue;
            const status = (i === 11) ? 'skipped' : 'finalized';
            const price  = (pair === 'BTC/USD' ? 60000 : 2) + i;
            insert(sqlite, HUB_SCHEMA + '.price_snapshots', { round_number: i + 1, coin_pair: pair, price: String(price),
                block_timestamp: T0 + i * 600, validator_count: 4, consensus_proof: '{}', status });
        }
    }
}

// FOO against the native coin in both orientations, plus an invalid fill.
function seedDex(){
    const coin  = insert(sqlite, 'index_coins', { coin: 'BTC' });
    const foo   = insert(sqlite, 'index_tickers', { tick: 'FOO' });
    const valid = insert(sqlite, 'index_statuses', { status: 'valid' });
    const invalid = insert(sqlite, 'index_statuses', { status: 'invalid' });
    const action = insert(sqlite, 'index_actions', { action: 'ORDER_MATCH' });
    // The two resting orders every fill matches, as /market/../history joins them.
    const maker = insert(sqlite, 'index_addresses', { address: 'maker' });
    for(const idx of [1000, 1001]) insert(sqlite, 'orders', { action_index: idx, get_address_id: maker });
    for(let b = 0; b < 8; b++) insert(sqlite, 'blocks', { block_index: 200 + b, block_time: T0 + b * 1800 });
    const fills = [
        // [action_index, block, give FOO?, give_amount, get_amount, status]
        [1, 200, true,  '100', '0.5', valid],
        [2, 201, false, '1',   '100', valid],
        [3, 202, true,  '10',  '9',   invalid],
        [4, 204, true,  '200', '3',   valid]
    ];
    for(const [idx, block, fooGives, giveAmount, getAmount, status] of fills){
        insert(sqlite, 'actions', { action_index: idx, block_index: block, action_id: action });
        insert(sqlite, 'order_matches', { action_index: idx, give_action_index: 1000, get_action_index: 1001,
            give_coin_id: coin, give_tick_id: fooGives ? foo : null, give_amount: giveAmount,
            get_coin_id: coin, get_tick_id: fooGives ? null : foo, get_amount: getAmount, status_id: status });
    }
}

function useSeededExplorer(options){
    before(function () { sqlite = openWalletTables(this); });
    beforeEach(() => {
        clearTables(sqlite);
        seedOracle();
        seedDex();
        ({ explorer, seen } = buildExplorer(sqlite, options));
        priceRoute = routeHandler('get', '/:coin/api/price_history');
    });
    afterEach(() => sinon.restore());
}

async function get(query){
    seen.length = 0;
    return drive(priceRoute, { path: '/BTC/api/price_history', query });
}

const RANGE = { interval: 'hour', from: String(T0), to: String(T0 + 6 * HOUR - 1) };

describe('GET /{COIN}/api/price_history: statement count', function () {
    useSeededExplorer();

    it('runs the oracle read, the DEX window and the DEX read for 1 asset and for 50', async () => {
        const one = await get(Object.assign({ assets: 'XCHAIN' }, RANGE));
        const oneCount = seen.length;
        const many = ['XCHAIN', 'BTC', 'FOO', ...Array.from({ length: 47 }, (_, i) => 'NONE' + i)];
        const fifty = await get(Object.assign({ assets: many.join(',') }, RANGE));
        expect(oneCount).to.equal(3);
        expect(seen.length).to.equal(oneCount);
        expect(fifty.body.series.length).to.be.greaterThan(one.body.series.length);
    });
});

describe('GET /{COIN}/api/price_history: oracle series', function () {
    useSeededExplorer();

    it('takes the last finalized round per hour and leaves an empty hour without a point', async () => {
        const { code, body } = await get(Object.assign({ assets: 'BTC' }, RANGE));
        expect(code).to.equal(200);
        const oracle = body.series.find((s) => s.source === 'oracle');
        expect(oracle).to.include({ asset: 'BTC', pair: 'BTC/USD', quote: 'USD' });
        expect(oracle.points.map((p) => p.t)).to.deep.equal([0, 1, 2, 4, 5].map((h) => T0 + h * HOUR));
        expect(oracle.points[0]).to.deep.equal({ t: T0, price: '60005', at: T0 + 5 * 600 });
        expect(oracle.points[1].price).to.equal('60010');
        expect(body.sources.oracle).to.deep.equal({ available: true });
    });

    it('serves day buckets from the same rounds', async () => {
        const { body } = await get({ assets: 'XCHAIN', interval: 'day', from: String(T0), to: String(T0 + 6 * HOUR) });
        const dayStart = T0 - (T0 % 86400);
        expect(body.series[0].points).to.deep.equal([
            { t: dayStart, price: '12', at: T0 + 10 * 600 },
            { t: dayStart + 86400, price: '37', at: T0 + 35 * 600 }
        ]);
    });

    it('serves the widest legal range, 1000 hourly buckets, through its last bucket', async () => {
        insert(sqlite, HUB_SCHEMA + '.price_snapshots', { round_number: 999, coin_pair: 'BTC/USD', price: '70000',
            block_timestamp: T0 + 999 * HOUR + 60, validator_count: 4, consensus_proof: '{}', status: 'finalized' });
        const { code, body } = await get({ assets: 'BTC', interval: 'hour', from: String(T0), to: String(T0 + 999 * HOUR) });
        expect(code).to.equal(200);
        const points = body.series.find((s) => s.source === 'oracle').points;
        expect(points[points.length - 1]).to.deep.equal({ t: T0 + 999 * HOUR, price: '70000', at: T0 + 999 * HOUR + 60 });
    });

    it('reports the oracle unavailable, not empty, without a co-located hub DB', async () => {
        sinon.restore();
        ({ explorer, seen } = buildExplorer(sqlite, { hub: false }));
        priceRoute = routeHandler('get', '/:coin/api/price_history');
        const { body } = await get(Object.assign({ assets: 'BTC,FOO' }, RANGE));
        expect(body.sources.oracle).to.deep.equal({ available: false, code: 'ORACLE_SOURCE_NOT_CONFIGURED' });
        expect(body.series.map((s) => s.source)).to.deep.equal(['dex']);
        expect(body.missing).to.deep.equal(['BTC']);
        expect(seen).to.have.length(2);
    });
});

describe('GET /{COIN}/api/price_history: DEX series', function () {
    useSeededExplorer();

    it('prices fills in quote per whole asset, both orientations, last fill per bucket, invalid fills dropped', async () => {
        const { body } = await get(Object.assign({ assets: 'FOO' }, RANGE));
        const dex = body.series.find((s) => s.source === 'dex');
        expect(dex).to.include({ asset: 'FOO', pair: 'FOO/BTC', quote: 'BTC' });
        expect(dex.points).to.deep.equal([
            { t: T0, price: '0.01', at: T0 + 1800, fills: 2 },
            { t: T0 + 2 * HOUR, price: '0.015', at: T0 + 4 * 1800, fills: 1 }
        ]);
    });

    it('agrees with /market/FOO/BTC/history on every fill price', async () => {
        const config = makeConfig({ type: 'api', data: { method: 'getMarketHistory', search: 'FOO', search2: 'BTC',
            sql: { order: 'DESC', limit: 100, where: { data: '', offset: '' } }, query: {}, offset: { action: null, start: null } } });
        config.coin = 'BTC';
        config.data.sql.where.data = await explorer.db.getQueryWhereSql(config);
        const [market] = await explorer.db.getMarketHistory(config);
        const byAction = new Map(market.map((m) => [Number(m.action_index), String(explorer.util.bcnum(m.price).toFixed())]));
        expect(byAction.get(2)).to.equal('0.01');
        expect(byAction.get(4)).to.equal('0.015');
    });

    it('returns no series, not zeros, for assets with no data, and does not split a repeated param', async () => {
        const { body } = await get(Object.assign({ assets: ['NOPE', 'A,B'] }, RANGE));
        expect(body.series).to.deep.equal([]);
        expect(body.missing).to.deep.equal(['NOPE', 'A,B']);
        expect(body.price_unit).to.equal('quote units per 1 whole unit of the asset');
    });
});

describe('GET /{COIN}/api/price_history: refusals', function () {
    useSeededExplorer();

    for(const [label, query, code] of [
        ['no assets', {}, 'INVALID_ASSETS'],
        ['51 assets', { assets: Array.from({ length: 51 }, (_, i) => 'A' + i).join(',') }, 'TOO_MANY_ASSETS'],
        ['an unknown interval', { assets: 'BTC', interval: 'minute' }, 'INVALID_INTERVAL'],
        ['from after to', { assets: 'BTC', from: '100', to: '50' }, 'INVALID_RANGE'],
        ['1001 hourly buckets', { assets: 'BTC', interval: 'hour', from: String(T0), to: String(T0 + 1000 * HOUR) }, 'RANGE_TOO_LARGE'],
        ['a malformed fiat', { assets: 'BTC', fiat: 'U$D' }, 'INVALID_QUOTE']
    ]){
        it('refuses ' + label + ' with 400 ' + code + ' before any statement', async () => {
            const res = await get(query);
            expect(res.code).to.equal(400);
            expect(res.body.code).to.equal(code);
            expect(seen).to.have.length(0);
        });
    }
});
