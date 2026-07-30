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
 * An order with no MEMO must still be an order.
 *
 * `getOrderInfoBatch` (the order book's second pass) and `getOrderInfo` (the
 * single-order read) both joined `index_memos` with an INNER JOIN. MEMO is an
 * OPTIONAL trailing field on ORDER, so every order placed without one -
 * which is every order the wallet's Create order form produces unless the
 * user opens "Advanced options" - was dropped by that join.
 *
 * MEASURED on Litecoin regtest 2026-07-29, three structurally identical open
 * token-for-token orders:
 *   1367 CVUYAUNMP -> XCHAIN, memo "plain-order"  -> book: asks [["1","100"]]
 *   1353 CVGFBPJQQ -> XCHAIN, memo "e3-undercap"  -> book: asks [["1","1000"]]
 *   1414 MKT741909 -> XCHAIN, memo null           -> book: asks []
 * The market row and its ask price were written correctly in all three cases
 * (`/markets/MKT741909` carried tick1_ask 20), so the order was on the market
 * and only the BOOK could not see it. The tell that it was a join and not a
 * filter: the orderbook response still echoed `"market":"MKT741909/XCHAIN"`,
 * which `getOrderbook` sets only when its own query returned rows - the rows
 * were found and then discarded when the batch read could not resolve them.
 *
 * The rest of this file's own module already LEFT JOINs index_memos in 50
 * other places; these two were the outliers.
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
