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
 * A pending_coinpay match holds an order's amounts off the book.
 *
 * The indexer's getOrderAmountRemaining subtracts every match whose status is
 * 'valid' OR 'pending_coinpay': the match has taken its share of both orders
 * and waits only on the BTC leg. Every explorer read of an order's remaining
 * amounts must do the same, or a fully matched order awaiting its COINPAY
 * shows its whole amount still on offer. The reads covered here are the order
 * list (/orders, SQL-computed give_remaining), the batch path behind action
 * detail and the orderbook (getOrderInfoBatch), the single-ORDER detail
 * query (ORDER_MATCHES), and getOrderAmountsRemaining.
 *
 * Every statement runs for real against an in-memory SQLite schema carrying
 * the columns those statements read, so the status filter is exercised as SQL
 * rather than asserted as text.
 ********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const orderSql   = require('../../../../../src/db/action_detail/orders_sql.js');
const { openIndexerTables, toSqlite } = require('../../../../helpers/indexer_ddl_sqlite.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const Database     = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['index_statuses', 'index_addresses', 'index_tickers', 'index_coins', 'index_memos',
    'index_actions', 'index_transactions', 'blocks', 'transactions', 'actions', 'orders',
    'order_statuses', 'order_edits'];
const ORDER_MATCHES_DDL = path.join(__dirname, '..', '..', '..', '..', '..', '..',
    'xchain-indexer', 'src', 'sql', 'order_matches.sql');

const SEED = `
INSERT INTO index_statuses (id, status) VALUES (1,'valid'),(2,'pending_coinpay'),(3,'open'),(4,'invalid: expired');
INSERT INTO index_addresses (id, address) VALUES (1,'maker'),(2,'taker');
INSERT INTO index_tickers (id, tick) VALUES (1,'GOLD');
INSERT INTO index_coins (id, coin) VALUES (1,'BTC');
INSERT INTO index_actions (id, action) VALUES (1,'ORDER');
INSERT INTO index_transactions (id, hash) VALUES (1,'aa'),(2,'bb');
INSERT INTO blocks (block_index, block_time) VALUES (7,1700000700);
INSERT INTO transactions (tx_index, block_index, source_id, tx_hash_id) VALUES (1,7,1,1),(2,7,2,2);
INSERT INTO actions (action_index, action_id, action_format, block_index, tx_index, source_id)
    VALUES (10,1,0,7,1,NULL),(11,1,0,7,2,NULL),(12,1,0,7,NULL,NULL);
-- Order 10 offers 10 GOLD for 0.001 BTC; order 11 takes all of it, settling by COINPAY.
INSERT INTO orders (action_index, give_coin_id, give_tick_id, give_amount, give_ownership,
    get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration,
    allow_list, block_list, payout_legs, memo_id, status_id)
    VALUES (10,1,1,'10',0,1,NULL,'0.001',0,1,100,0,0,NULL,NULL,1),
           (11,1,NULL,'0.001',0,1,1,'10',0,2,100,0,0,NULL,NULL,1);
INSERT INTO order_statuses (action_index, order_action_index, status_id) VALUES (10,10,3),(11,11,3);
`;

let sqlite = null;

function makeDb(){
    const db = new Database({ configInfo, util });
    db.doQuery = async (config, query, args) => sqlite.prepare(query).all(...(args || []));
    return db;
}

// The match between orders 10 and 11 under the given status. A match row's
// get_amount is what its give-side order handed over (10 GOLD) and its
// give_amount what the get-side order handed over (0.001 BTC).
function setMatch(statusId){
    sqlite.exec('DELETE FROM order_matches');
    sqlite.prepare(`INSERT INTO order_matches
        (action_index, give_action_index, get_action_index, give_amount, get_amount,
         give_coin_id, get_coin_id, give_tick_id, get_tick_id, status_id)
        VALUES (12,10,11,?,?,1,1,1,NULL,?)`).run('0.001', '10', statusId);
}

const CFG = { coin: 'BTC', type: 'api', data: {} };

describe('a pending_coinpay match holds the order off the book', function () {
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
        if(!sqlite) return;
        const matches = toSqlite(fs.readFileSync(ORDER_MATCHES_DDL, 'utf8'))
            .replace(/ENUM\([^)]*\)/gi, 'TEXT');
        sqlite.exec(matches);
        sqlite.exec(SEED);
    });

    for (const [label, statusId] of [['valid', 1], ['pending_coinpay', 2]]) {
        describe('match status ' + label, function () {
            beforeEach(() => setMatch(statusId));

            it('/orders lists give_remaining 0', async () => {
                const db  = makeDb();
                const cfg = Object.assign({}, CFG, { data: { search: 'maker', type: 'address',
                    sql: { where: { data: 'a2.address=? OR a3.address=?', offset: '' }, order: 'ASC', limit: 10 } } });
                const [query, args] = await db.getOrders(cfg);
                const rows = sqlite.prepare(query).all(...args);
                const maker = rows.find((r) => Number(r.action_index) === 10);
                expect(Number(maker.give_remaining)).to.equal(0);
            });

            it('getOrderInfoBatch (action detail batch, orderbook) leaves nothing remaining', async () => {
                const map = await makeDb().getOrderInfoBatch(CFG, [10, 11]);
                expect(util.bcnum(map[10].give_remaining).toFixed()).to.equal('0');
                expect(util.bcnum(map[10].get_remaining).toFixed()).to.equal('0');
                expect(util.bcnum(map[11].give_remaining).toFixed()).to.equal('0');
            });

            it('the orderbook carries no depth for the matched orders', async () => {
                const cfg = Object.assign({}, CFG, { data: { search: 'GOLD', search2: 'BTC',
                    sql: { where: { data: '((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))' } } } });
                const [book] = await makeDb().getOrderbook(cfg);
                const depth = [...book.asks, ...book.bids].map(([, amount]) => amount);
                expect(depth.length).to.equal(2);
                expect(depth.every((a) => util.bcnum(a).isZero()), JSON.stringify(book)).to.equal(true);
            });

            it('the single-ORDER detail query returns the match', () => {
                const rows = sqlite.prepare(orderSql.ORDER_MATCHES).all(10, 10);
                expect(rows.map((r) => Number(r.give_action_index))).to.deep.equal([10]);
            });

            it('getOrderAmountsRemaining nets the match out', async () => {
                const [give, get] = await makeDb().getOrderAmountsRemaining(CFG, 10);
                expect(util.bcnum(give).toFixed()).to.equal('0');
                expect(util.bcnum(get).toFixed()).to.equal('0');
            });
        });
    }

    it('an invalid match still holds nothing', async () => {
        setMatch(4);
        const map = await makeDb().getOrderInfoBatch(CFG, [10]);
        expect(util.bcnum(map[10].give_remaining).toFixed()).to.equal('10');
    });
});
