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
 * Runs getOrderMatchSettlement and getActionLedgerAddresses against tables built
 * from the indexer's real order_matches, credits, debits, escrows and
 * index_addresses DDL, so a column the schema lacks throws here as it would in
 * MariaDB. The live feed swallows a failed settlement read, so a wrong column
 * there would silently stop COINPAY_REQUIRED; this is where it shows.
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

let sqlite, db, cfg;

function address(text) {
    return Number(sqlite.prepare('INSERT INTO index_addresses (address, block_index) VALUES (?, 1)').run(text).lastInsertRowid);
}

function ledgerRow(table, actionIndex, addressId) {
    sqlite.prepare(`INSERT INTO ${table} (action_index, address_id, tick_id, amount) VALUES (?, ?, 1, '1')`).run(actionIndex, addressId);
}

describe('system action reads against the REAL indexer DDL', function () {
    before(function () {
        sqlite = openIndexerTables(this, ['order_matches', 'credits', 'debits', 'escrows', 'index_addresses']);
    });
    beforeEach(function () {
        const configInfo = createConfigInfoStub();
        db  = new Database({ configInfo, util: new Utility(configInfo) });
        cfg = makeConfig({ coin: 'BTC' });
        sqlite.exec('DELETE FROM order_matches; DELETE FROM credits; DELETE FROM debits; DELETE FROM escrows; DELETE FROM index_addresses;');
        sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => sqlite.prepare(query).all(...(args || [])));
    });
    afterEach(() => sinon.restore());

    it('getOrderMatchSettlement returns the settlement type of a coinpay match', async function () {
        sqlite.prepare("INSERT INTO order_matches (action_index, give_action_index, give_coin_id, get_action_index, get_coin_id, settlement_type) VALUES (30, 1, 1, 2, 2, 'coinpay')").run();
        sqlite.prepare("INSERT INTO order_matches (action_index, give_action_index, give_coin_id, get_action_index, get_coin_id) VALUES (31, 3, 1, 4, 2)").run();

        const coinpay = await db.getOrderMatchSettlement(cfg, 30);
        const instant = await db.getOrderMatchSettlement(cfg, 31);

        expect(coinpay.settlement_type).to.equal('coinpay');
        expect(instant.settlement_type).to.equal('instant');
        expect(await db.getOrderMatchSettlement(cfg, 99)).to.equal(null);
    });

    it('getActionLedgerAddresses names the addresses each action credited, debited or escrowed', async function () {
        const maker = address('1maker');
        const taker = address('1taker');
        const other = address('1other');
        ledgerRow('credits', 7, maker);
        ledgerRow('debits', 7, taker);
        ledgerRow('escrows', 8, maker);
        ledgerRow('credits', 9, other);

        const map = await db.getActionLedgerAddresses(cfg, [7n, 8n]);

        expect([...map.keys()].sort()).to.deep.equal(['7', '8']);
        expect([...map.get('7')].sort()).to.deep.equal(['1maker', '1taker']);
        expect([...map.get('8')]).to.deep.equal(['1maker']);
    });
});
