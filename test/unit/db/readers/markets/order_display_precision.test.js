'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The explorer's order "remaining" and order-book depth must equal what the indexer
// computes (64-digit subtraction, exact sums, decimal-string output), never a whole-unit
// rounding or a mathjs object.

const assert = require('assert');
const sinon = require('sinon');
const Utility = require('../../../../../src/lib/utility.js');
const detail = require('../../../../../src/action-detail/markets.js');
const orderReaders = require('../../../../../src/db/readers/action_detail_io/orders.js');
const marketReaders = require('../../../../../src/db/readers/markets/orders.js');

const util = new Utility({});

const cases = [
    { name: '8dp partial', order: { give: '10', get: '25' }, fills: [{ give: '1.4', get: '3.5' }], expect: ['8.6', '21.5'] },
    { name: 'two partials', order: { give: '10.5', get: '21' }, fills: [{ give: '0.25', get: '0.5' }, { give: '0.25', get: '0.5' }], expect: ['10', '20'] },
    { name: '18dp dust', order: { give: '1', get: '1' }, fills: [{ give: '0.000000000000000001', get: '0.000000000000000001' }], expect: ['0.999999999999999999', '0.999999999999999999'] },
    { name: 'sub-half remaining', order: { give: '1', get: '3' }, fills: [{ give: '0.6', get: '1.8' }], expect: ['0.4', '1.2'] },
];

const fillRows = (fills) => fills.map((f, i) => ({ give_action_index: 60 + i, get_action_index: 50, give_amount: f.give, get_amount: f.get }));

describe('explorer order remaining and book depth keep fractional amounts', function () {
    afterEach(() => sinon.restore());

    for (const c of cases) {
        it('reader getOrderAmountsRemaining: ' + c.name, async function () {
            const self = {
                util,
                doQuery: sinon.stub()
                    .onFirstCall().resolves([{ give_coin_id: 1, give_tick_id: 1, give_amount: c.order.give, get_coin_id: 1, get_tick_id: 2, get_amount: c.order.get }])
                    .onSecondCall().resolves(fillRows(c.fills)),
            };
            const [g, t] = await orderReaders.getOrderAmountsRemaining.call(self, {}, 50);
            assert.deepStrictEqual([util.bcnum(g).toFixed(), util.bcnum(t).toFixed()], c.expect);
        });

        it('detail page ORDER.afterQuery3: ' + c.name, function () {
            const data = { give_amount: c.order.give, get_amount: c.order.get, state: {}, status: 'valid' };
            detail.ORDER.afterQuery3({ db: { util }, action_index: 50 }, data, fillRows(c.fills));
            assert.deepStrictEqual([data.state.give_remaining, data.state.get_remaining], c.expect);
        });
    }

    it('getOrderbook sums a multi-order level exactly and returns decimal strings', async function () {
        const mk = (give_remaining) => ({ give_tick: 'AAA', give_coin: 'BTC', get_tick: 'BBB', get_coin: 'BTC', give_price: '2', get_price: '0.5', give_remaining, get_remaining: '1' });
        const orders = { 1: mk('0.3'), 2: mk('0.3'), 3: mk('0.000000000000000001'), 4: { ...mk('7'), give_price: '3' } };
        const self = Object.create(marketReaders);
        self.util = util;
        self.doQuery = sinon.stub().resolves([{ action_index: 1 }, { action_index: 2 }, { action_index: 3 }, { action_index: 4 }]);
        self.getOrderInfoBatch = sinon.stub().resolves(orders);
        const [book] = await self.getOrderbook({ data: { search: 'AAA', search2: 'BBB', sql: { where: { data: '' } } } });
        assert.deepStrictEqual(book.asks, [['2', '0.600000000000000001'], ['3', '7']]);
        for (const row of book.asks) assert.strictEqual(typeof row[1], 'string');
    });
});
