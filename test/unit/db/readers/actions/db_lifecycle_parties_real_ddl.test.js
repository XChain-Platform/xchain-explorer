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
 * Runs getLifecycleParties against tables built from the indexer's real DDL, so
 * every join column it names must exist. A party is the placer of the order,
 * swap, dispenser or feed the system action settled, found through that parent
 * row: a royalty credit on the same action, or a cross-chain fill row whose give
 * side is a settlement action rather than an order, must name nobody.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { openIndexerTables }    = require('../../../../helpers/indexer_ddl_sqlite.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['actions', 'index_addresses', 'credits', 'debits', 'escrows', 'orders', 'swaps', 'dispensers', 'bet_feeds',
    'order_matches', 'swap_matches', 'order_expires', 'swap_expires', 'dispenser_expires',
    'dispenser_closes', 'coinpay_expires', 'coinpay_obligations', 'bet_feed_statuses', 'cross_chain_settlements'];

let sqlite, db, cfg;

function run(sql, ...args) { return sqlite.prepare(sql).run(...args); }

// An address row, and an action placed by it (or by nobody) at `index`.
function placed(index, address) {
    let id = null;
    if (address) id = Number(run('INSERT INTO index_addresses (address, block_index) VALUES (?, 1)', address).lastInsertRowid);
    run('INSERT INTO actions (action_index, block_index, action_id, source_id) VALUES (?, 1, 1, ?)', index, id);
    return id;
}

function seed() {
    placed(1, '1maker');  run('INSERT INTO orders (action_index) VALUES (1)');
    placed(2, '1taker');  run('INSERT INTO orders (action_index) VALUES (2)');
    placed(3, '1swapA');  run('INSERT INTO swaps (action_index) VALUES (3)');
    placed(4, '1swapB');  run('INSERT INTO swaps (action_index) VALUES (4)');
    placed(5, '1vendor'); run('INSERT INTO dispensers (action_index) VALUES (5)');
    placed(6, '1oracle'); run('INSERT INTO bet_feeds (action_index) VALUES (6)');
    const royalty = placed(7, '1royalty');
    // A cross-chain settlement with a source, recorded as an order fill whose give side is itself.
    placed(8, '1relayer');
    run('INSERT INTO order_matches (action_index, give_action_index, give_coin_id, get_action_index, get_coin_id) VALUES (20, 1, 1, 2, 1)');
    run('INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES (20, ?, 1, \'1\')', royalty);
    run('INSERT INTO order_matches (action_index, give_action_index, give_coin_id, get_action_index, get_coin_id) VALUES (8, 8, 2, 2, 1)');
    run('INSERT INTO swap_matches (action_index, give_action_index, give_coin_id, give_tick_id, get_action_index, get_coin_id, get_tick_id) VALUES (21, 3, 1, 1, 4, 1, 1)');
    run('INSERT INTO order_expires (action_index, order_action_index) VALUES (22, 1)');
    run('INSERT INTO swap_expires (action_index, swap_action_index) VALUES (23, 4)');
    run('INSERT INTO dispenser_expires (action_index, dispenser_action_index) VALUES (24, 5)');
    run('INSERT INTO dispenser_closes (action_index, dispenser_action_index) VALUES (25, 5)');
    const payer = Number(run('INSERT INTO index_addresses (address, block_index) VALUES (\'1payer\', 1)').lastInsertRowid);
    const payee = Number(run('INSERT INTO index_addresses (address, block_index) VALUES (\'1payee\', 1)').lastInsertRowid);
    run('INSERT INTO coinpay_obligations (action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index) VALUES (30, ?, ?, 1, \'0.1\', 9, 1)', payer, payee);
    run('INSERT INTO coinpay_expires (action_index, obligation_action_index) VALUES (26, 30)');
    run('INSERT INTO bet_feed_statuses (action_index, feed_action_index) VALUES (27, 6)');
    run("INSERT INTO cross_chain_settlements VALUES (28, 'order-settle', 1, 1, 'BTC', 1, 'LTC', 9)");
    run("INSERT INTO cross_chain_settlements VALUES (29, 'swap-settle', 3, 1, 'BTC', 3, 'DOGE', 9)");
    run("INSERT INTO cross_chain_settlements VALUES (30, 'order-noop', 2, 1, 'BTC', 2, 'LTC', 10)");
    run("INSERT INTO cross_chain_settlements VALUES (31, 'retired', 4, 1, NULL, NULL, NULL, NULL)");
}

const parties = (map, index) => [...(map.get(String(index)) || [])].sort();

// Open the real-DDL tables, seed them and stub the query path before each case.
function installHooks() {
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
    });
    beforeEach(function () {
        const configInfo = createConfigInfoStub();
        db  = new Database({ configInfo, util: new Utility(configInfo) });
        cfg = makeConfig({ coin: 'BTC' });
        for (const t of TABLES) sqlite.exec('DELETE FROM ' + t);
        seed();
        sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => sqlite.prepare(query).all(...(args || [])));
    });
    afterEach(() => sinon.restore());
}

describe('getLifecycleParties against the REAL indexer DDL', function () {
    installHooks();

    it('names the placers of every system action family in one query', async function () {
        const batch = [
            { action: 'ORDER_MATCH', action_index: 20n }, { action: 'SWAP_MATCH', action_index: 21n },
            { action: 'ORDER_EXPIRE', action_index: 22n }, { action: 'SWAP_EXPIRE', action_index: 23n },
            { action: 'DISPENSER_EXPIRE', action_index: 24n }, { action: 'DISPENSER_CLOSE', action_index: 25n },
            { action: 'COINPAY_EXPIRE', action_index: 26n }, { action: 'BET_EXPIRE', action_index: 27n },
            { action: 'CROSS_SETTLE', action_index: 28n }, { action: 'CROSS_SETTLE', action_index: 29n },
            { action: 'CROSS_SETTLE', action_index: 30n }, { action: 'CROSS_SETTLE', action_index: 31n },
            { action: 'SEND', action_index: 1n }
        ];
        const map = await db.getLifecycleParties(cfg, batch);

        expect(db.doQuery.callCount).to.equal(1);
        expect(parties(map, 20)).to.deep.equal(['1maker', '1taker']);
        expect(parties(map, 21)).to.deep.equal(['1swapA', '1swapB']);
        expect(parties(map, 22)).to.deep.equal(['1maker']);
        expect(parties(map, 23)).to.deep.equal(['1swapB']);
        expect(parties(map, 24)).to.deep.equal(['1vendor']);
        expect(parties(map, 25)).to.deep.equal(['1vendor']);
        expect(parties(map, 26)).to.deep.equal(['1payee', '1payer']);
        expect(parties(map, 27)).to.deep.equal(['1oracle']);
        expect(parties(map, 28)).to.deep.equal(['1maker']);
        expect(parties(map, 29)).to.deep.equal(['1swapA']);
        expect(parties(map, 30)).to.deep.equal(['1taker']);
        expect(parties(map, 31)).to.deep.equal([]);
        expect(map.has('1')).to.equal(false);
    });

});

describe('getLifecycleParties against the REAL indexer DDL', function () {
    installHooks();

    it('never names a royalty recipient or a settlement action standing in for an order', async function () {
        const map = await db.getLifecycleParties(cfg, [
            { action: 'ORDER_MATCH', action_index: 20n }, { action: 'ORDER_MATCH', action_index: 8n }
        ]);
        expect(parties(map, 20)).to.not.include('1royalty');
        expect(parties(map, 8)).to.deep.equal(['1taker']);
    });

    it('keys a system action with no party row and reads nothing for a batch without one', async function () {
        const map = await db.getLifecycleParties(cfg, [{ action: 'ORDER_EXPIRE', action_index: 99n }]);
        expect([...map.keys()]).to.deep.equal(['99']);
        expect(parties(map, 99)).to.deep.equal([]);

        db.doQuery.resetHistory();
        const none = await db.getLifecycleParties(cfg, [{ action: 'SEND', action_index: 1n }, { action: 'DISPENSE', action_index: 2n }]);
        expect(none.size).to.equal(0);
        expect(db.doQuery.called).to.equal(false);
    });

    it('returns each ledger address once per action however many rows paid it', async function () {
        const id = sqlite.prepare('SELECT id FROM index_addresses WHERE address=\'1maker\'').get().id;
        for (let i = 0; i < 3; i++) run('INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES (40, ?, 1, \'1\')', id);
        const rows = [];
        db.doQuery.restore();
        sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
            const out = sqlite.prepare(query).all(...(args || []));
            rows.push(...out);
            return out;
        });
        const map = await db.getActionLedgerAddresses(cfg, [40n]);
        expect([...map.get('40')]).to.deep.equal(['1maker']);
        expect(rows).to.have.lengthOf(1);
    });
});
