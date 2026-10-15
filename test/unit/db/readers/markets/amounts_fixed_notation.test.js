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
 * No amount or price leaves the explorer in exponent notation.
 *
 * The indexer stores some text columns in exponent notation: market prices
 * and volumes ('2e-10', '1e+24') and token supply ('1e+21'). A string passes
 * util.jsonStringify untouched, so /markets, /market/T1/T2, the WebSocket
 * market and token snapshots, /balances, /holders and /rich_list each serve
 * those fields through util.plainDecimal, which rewrites exactly the
 * exponent-notation values and leaves every digit of the value as it was.
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { applyPostPasses }      = require('../../../../../src/db/query_sql/data_post.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

const EXPO = /[0-9]e[+-]?[0-9]/i;

// Every string anywhere in the value that looks like an exponent-notation number.
function exponentStrings(value){
    const found = [];
    JSON.stringify(value, (k, v) => { if(typeof v === 'string' && EXPO.test(v) && /^[+-]?[0-9.]+e/i.test(v)) found.push(k + '=' + v); return v; });
    return found;
}

const MARKET_ROW = {
    id: 1, tick1: 'EIGHT', tick2: 'ZERO', last_updated: 1700000000,
    tick1_price: '2e-10', tick1_bid: '2.333333333333333333333333333333333333333333333333333333e-10',
    tick1_ask: '1e-24', tick1_24hr_price: '2e-10', tick1_24hr_high: '2e-10', tick1_24hr_low: '2e-10',
    tick1_24hr_change: '0', tick1_24hr_volume: '1e-8',
    tick2_price: '5000000000', tick2_bid: '1e+24', tick2_ask: '1e+24', tick2_24hr_price: '5000000000',
    tick2_24hr_high: '5000000000', tick2_24hr_low: '5000000000', tick2_24hr_change: '-0.5', tick2_24hr_volume: '2e-18'
};

function makeDb(route){
    const db = new Database({ configInfo, util });
    db.getCanonicalTick = async (config, value) => value;
    sinon.stub(db, 'doQuery').callsFake(async (c, q) => route(String(q)));
    return db;
}

function listCfg(extra){
    return makeConfig(Object.assign({ coin: 'BTC' }, extra, { data: Object.assign({
        sql: { where: { data: '1=1', offset: '' }, order: 'ASC', limit: 10 } }, (extra && extra.data) || {}) }));
}

describe('util.plainDecimal', function () {
    it('rewrites exponent notation exactly', () => {
        expect(util.plainDecimal('2e-10')).to.equal('0.0000000002');
        expect(util.plainDecimal('1e+24')).to.equal('1000000000000000000000000');
        expect(util.plainDecimal('-5E-3')).to.equal('-0.005');
        // A 73-digit mantissa keeps every digit.
        expect(util.plainDecimal('1.234567890123456789012345678901234567890123456789012345678901234567890123e+5'))
            .to.equal('123456.7890123456789012345678901234567890123456789012345678901234567890123');
    });

    it('leaves every other value as it was', () => {
        for(const v of ['5.0', '0', '100000000.00000000', 'abc', '1e5x', 'ff1e3', '', null, undefined, 12])
            expect(util.plainDecimal(v), String(v)).to.equal(v);
    });
});

describe('market routes serve fixed decimal notation', function () {
    afterEach(() => sinon.restore());

    it('/markets', async () => {
        const db = makeDb((q) => /count\(\*\)/i.test(q) ? [{ total: 1 }] : [Object.assign({}, MARKET_ROW)]);
        const [data] = await db.getMarkets(listCfg({ data: { search: null } }));
        expect(data).to.have.length(1);
        expect(exponentStrings(data)).to.deep.equal([]);
        expect(data[0].tick2_bid).to.equal('0.0000000002333333333333333333333333333333333333333333333333333333');
        expect(data[0].tick1_bid).to.equal('1000000000000000000000000');
    });

    it('/market/T1/T2', async () => {
        const db = makeDb(() => [Object.assign({}, MARKET_ROW)]);
        const [row] = await db.getMarket(listCfg({ data: { search: 'EIGHT', search2: 'ZERO' } }));
        expect(exponentStrings(row)).to.deep.equal([]);
        expect(row.tick2_24hr_change).to.equal('-0.5');
    });

    it('the WebSocket market snapshot', async () => {
        const db = makeDb(() => [{ tick1: 'EIGHT', tick2: 'ZERO', last_price: '2e-10', volume_24h: '1e-8',
            bid: '2.5e-10', ask: '1e+24' }]);
        const info = await db.getMarketInfo(makeConfig({ coin: 'BTC' }), 'EIGHT', 'ZERO');
        expect(info).to.include({ last_price: '0.0000000002', volume_24h: '0.00000001',
            bid: '0.00000000025', ask: '1000000000000000000000000' });
    });

    it('the WebSocket token snapshot supply', async () => {
        const db = makeDb(() => [{ tick: 'BIG', supply: '1e+21', decimals: 18, description: '', holders: 1 }]);
        const info = await db.getTokenInfo(makeConfig({ coin: 'BTC' }), 'BIG');
        expect(info.supply).to.equal('1000000000000000000000');
    });
});

describe('supply routes serve fixed decimal notation', function () {
    afterEach(() => sinon.restore());

    for (const method of ['getBalances', 'getHolders']) {
        it(method + ' rows', async () => {
            const db = makeDb(() => []);
            const rows = [{ tick: 'BIG', amount: '1000', supply: '1e+21', decimals: 18, coin_price: '1e-9' }];
            await applyPostPasses(db, makeConfig({ coin: 'BTC', data: { method } }), rows);
            expect(rows[0]).to.include({ amount: '1000', supply: '1000000000000000000000', coin_price: '0.000000001' });
        });
    }

    it('/rich_list', async () => {
        const db = makeDb((q) => {
            if(/FROM index_tickers WHERE tick=/.test(q)) return [{ id: 3 }];
            if(/FROM\s+tokens m/.test(q)) return [{ tick: 'BIG', supply: '1e+21', max_supply: '1e+24', max_mint: '1e+21',
                decimals: 18, lock_max_supply: 0, lock_mint: 0, description: '', owner: 'o', action_index: 9, block_index: 2 }];
            if(/holder_count/.test(q)) return [{ holder_count: 1, held_total: '1000000000000000000000.000000000000000000' }];
            return [{ address: 'o', amount: '1e+21' }];
        });
        const [body] = await db.getRichList(makeConfig({ coin: 'BTC', type: 'api', data: { search: 'BIG' } }));
        expect(exponentStrings(body)).to.deep.equal([]);
        expect(body.supply).to.equal('1000000000000000000000');
        expect(body.max_supply).to.equal('1000000000000000000000000');
        expect(body.holders[0].amount).to.equal('1000000000000000000000');
        expect(body.holders[0].percent).to.equal('100.00000000');
    });
});
