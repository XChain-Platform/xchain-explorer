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
 * An order with no MEMO must still be an order. `getOrderInfoBatch` (the order
 * book's second pass) and `getOrderInfo` (the single-order read) both joined
 * `index_memos` with an INNER JOIN. MEMO is an OPTIONAL trailing field on
 * ORDER, so every order placed without one, which is every order the wallet's
 * default Create-order form produces, was silently dropped from the book even
 * though the market row and its ask price were written correctly.
 *
 * Reproduced on regtest: the orderbook response still echoed the market pair,
 * which only happens when the underlying query found rows, so the rows were
 * found and then discarded when the batch read could not resolve them. The
 * rest of this module already LEFT JOINs index_memos everywhere else; these
 * two calls were the outliers.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

/**
 * A Database whose doQuery records the SQL it is handed and answers with
 * `rows`, so a query method can be driven with no MariaDB behind it.
 */
function makeDb(rows = []){
    const db = new Database(mockExplorer);
    const seen = [];
    db.doQuery = async (config, query, args) => { seen.push({ query, args }); return rows; };
    return { db, seen };
}

const CONFIG = { coin: 'RLTC', data: {} };

describe('an order with no MEMO is still on the book', () => {

    it('[REGRESSION] getOrderInfoBatch LEFT JOINs index_memos', async () => {
        const { db, seen } = makeDb([]);
        await db.getOrderInfoBatch(CONFIG, [1414]);
        // The batch fans out into several reads; the one that matters is the
        // order row itself, which is the only one touching index_memos.
        const memoQueries = seen.map((s) => s.query).filter((q) => q.includes('index_memos'));
        expect(memoQueries, 'the batch no longer reads the order row').to.have.lengthOf(1);
        expect(memoQueries[0], 'an INNER JOIN on an OPTIONAL field silently drops the order, and the '
            + 'order book is the surface a counterparty browses')
            .to.not.match(/INNER JOIN\s+index_memos/);
        expect(memoQueries[0]).to.match(/LEFT\s+JOIN\s+index_memos/);
    });

    it('[REGRESSION] getOrderInfo LEFT JOINs index_memos too', async () => {
        const { db, seen } = makeDb([]);
        await db.getOrderInfo(CONFIG, 1414);
        expect(seen[0].query).to.not.match(/INNER JOIN\s+index_memos/);
        expect(seen[0].query).to.match(/LEFT\s+JOIN\s+index_memos/);
    });

    it('the batch still keys its result by action_index, so the book can resolve a row', async () => {
        const { db } = makeDb([{
            action_index: 1414, give_tick: 'MKT741909', give_amount: '100',
            get_coin: 'LTC', get_tick: 'XCHAIN', get_amount: '5',
            source: 'rltc1qsrc', get_address: 'rltc1qsrc', expiration: '1793152769',
            allow_list: null, block_list: null, memo: null,
            status: 'valid', order_status: 'open', block_index: '3275', block_time: '1785376769',
        }]);
        const map = await db.getOrderInfoBatch(CONFIG, [1414]);
        expect(map[1414], 'the book looks the row up by action_index and skips what it cannot find')
            .to.be.an('object');
        expect(map[1414].memo, 'a missing memo must read as absent, not turn the order into a miss')
            .to.satisfy((m) => m === null || m === undefined || m === '');
    });
});
