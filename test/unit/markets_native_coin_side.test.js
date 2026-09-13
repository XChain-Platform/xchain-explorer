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
 * The market readers against a pair whose second side is the chain's native
 * coin: it has no index_tickers row, so an inner join on the ticker returned an
 * empty list however many orders rested on the market. Each side is labelled
 * COALESCE(ticker, coin), and a token/token pair must come back unchanged.
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

const makeDb = () => new Database(mockExplorer);

function marketConfig(method, extras = {}) {
    return makeConfig({
        coin: 'DOGE',
        data: {
            method,
            type: 'token',
            search: 'DOGESWAP',
            search2: 'DOGE',
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '' }
            },
            ...extras
        }
    });
}

// A markets row as the reader now sees it: the native side resolved to its coin.
const NATIVE_PAIR_ROW = {
    id: 1, tick1: 'DOGE', tick2: 'DOGESWAP',
    tick1_price: '0.001', tick2_price: '1000',
    tick1_bid: '0.0009', tick2_bid: '999',
    tick1_ask: '0.0011', tick2_ask: '1001',
    tick1_24hr_price: '0.001', tick2_24hr_price: '1000',
    tick1_24hr_high: '0.0012', tick2_24hr_high: '1200',
    tick1_24hr_low: '0.0008', tick2_24hr_low: '800',
    tick1_24hr_change: '1.0', tick2_24hr_change: '-1.0',
    tick1_24hr_volume: '5.0', tick2_24hr_volume: '5000',
    last_updated: 1700000000
};

afterEach(() => sinon.restore());

describe('market readers: a side with no ticker', () => {

    it('getMarkets reaches index_coins and never inner-joins the ticker', async () => {
        const db = makeDb();
        const seen = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            seen.push(q);
            if (q.includes('count(*) as total')) return [{ total: 1 }];
            return [NATIVE_PAIR_ROW];
        });
        const [data, , total] = await db.getMarkets(marketConfig('getMarkets'));
        expect(total).to.equal(1);
        expect(data).to.have.lengthOf(1);
        // Both the count and the data query, or the total disagrees with the list.
        for (const q of seen) {
            expect(q, 'an inner ticker join drops the whole pair').to.not.match(/INNER JOIN index_tickers/);
            expect(q).to.include('LEFT JOIN index_coins   c1 ON (c1.id=m.coin1_id)');
            expect(q).to.include('LEFT JOIN index_coins   c2 ON (c2.id=m.coin2_id)');
        }
        const dataQuery = seen.find(q => !q.includes('count(*) as total'));
        expect(dataQuery).to.include('COALESCE(t1.tick, c1.coin) as tick1');
        expect(dataQuery).to.include('COALESCE(t2.tick, c2.coin) as tick2');
    });

    it('getMarkets returns the pair, labelled by the coin on the tickerless side', async () => {
        const db = makeDb();
        // Stands in for the one server behaviour under test: the pair's first side has
        // no index_tickers row, so a join that REQUIRES one eliminates the whole row and
        // the endpoint answers with an empty list.
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            const nativeSideEliminated = /INNER JOIN index_tickers t1/.test(q);
            if (q.includes('count(*) as total')) return [{ total: nativeSideEliminated ? 0 : 1 }];
            return nativeSideEliminated ? [] : [NATIVE_PAIR_ROW];
        });
        // search = DOGESWAP matches tick2, so the reader flips the pair to lead with it.
        const [data, , total] = await db.getMarkets(marketConfig('getMarkets', { search: 'DOGESWAP' }));
        expect(total, 'the market must be counted').to.equal(1);
        expect(data, 'the market must be listed').to.have.lengthOf(1);
        expect(data[0].tick1).to.equal('DOGE');
        expect(data[0].tick2).to.equal('DOGESWAP');
        expect(data[0].tick1_price).to.equal('0.001');
    });

    it('getMarkets keeps a token/token pair on the keys it always returned', async () => {
        const db = makeDb();
        const tokenPair = { ...NATIVE_PAIR_ROW, tick1: 'AAA', tick2: 'BBB' };
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if (q.includes('count(*) as total')) return [{ total: 1 }];
            return [tokenPair];
        });
        const [data] = await db.getMarkets(marketConfig('getMarkets', { search: 'AAA' }));
        expect(Object.keys(data[0])).to.deep.equal([
            'id',
            'tick1', 'tick1_price', 'tick1_bid', 'tick1_ask',
            'tick1_24hr_price', 'tick1_24hr_high', 'tick1_24hr_low', 'tick1_24hr_change', 'tick1_24hr_volume',
            'tick2', 'tick2_price', 'tick2_bid', 'tick2_ask',
            'tick2_24hr_price', 'tick2_24hr_high', 'tick2_24hr_low', 'tick2_24hr_change', 'tick2_24hr_volume',
            'last_updated'
        ]);
        // search matched tick1, so the stored orientation is served as-is.
        expect(data[0].tick1).to.equal('BBB');
        expect(data[0].tick2).to.equal('AAA');
    });

    it('the market WHERE predicates match on the coin when a side has no ticker', async () => {
        const db = makeDb();
        for (const method of ['getMarket', 'getMarkets', 'getMarketOrders', 'getOrderbook', 'getMarketHistory']) {
            const where = await db.getQueryWhereSql(marketConfig(method));
            expect(where, method).to.include('COALESCE(t1.tick, c1.coin)=?');
            expect(where, method).to.not.match(/[^)]t1\.tick=\?/);
        }
    });

    it('getOrderbook reads a resting order whose give side is the native coin', async () => {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ action_index: 1 }, { action_index: 2 }]);
        sinon.stub(db, 'getOrderInfoBatch').resolves({
            // selling DOGESWAP for the native coin
            1: { give_tick: 'DOGESWAP', give_coin: 'DOGE', get_tick: null, get_coin: 'DOGE',
                 give_price: '0.001', get_price: '1000', give_remaining: '100', get_remaining: '0.1' },
            // buying DOGESWAP with the native coin: give_tick is NULL, the side IS the coin
            2: { give_tick: null, give_coin: 'DOGE', get_tick: 'DOGESWAP', get_coin: 'DOGE',
                 give_price: '1000', get_price: '0.001', give_remaining: '0.1', get_remaining: '100' }
        });
        const [data] = await db.getOrderbook(marketConfig('getOrderbook'));
        expect(data.market).to.equal('DOGESWAP/DOGE');
        expect(data.asks, 'the sell side must list').to.have.lengthOf(1);
        expect(data.bids, 'a give side of NULL is the coin, which is tick2, so this is a bid')
            .to.have.lengthOf(1);
    });

    it('getOrderInfoBatch left-joins the ticker and carries give_coin', async () => {
        const db = makeDb();
        let firstQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if (firstQuery === null) firstQuery = q;
            return [];
        });
        await db.getOrderInfoBatch(makeConfig({ coin: 'DOGE' }), [1]);
        expect(firstQuery).to.include('LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)');
        expect(firstQuery).to.include('LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)');
        expect(firstQuery).to.include('c2.coin as give_coin');
    });
});
