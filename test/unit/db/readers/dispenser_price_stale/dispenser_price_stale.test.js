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
 * Price-source availability for open fiat-priced dispensers.
 *********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TIP = 2000000;
const WINDOW = 86400;

function makeDb(){
    const configInfo = createConfigInfoStub();
    return new Database({ configInfo, util: new Utility(configInfo) });
}

function dispenser(action_index, fields = {}){
    return {
        action_index,
        status: 'valid',
        current_status: 'open',
        give_coin: 'BTC',
        give_tick: 'TOKEN',
        get_coin: 'BTC',
        fiat_code: 'USD',
        oracle_address: null,
        ...fields
    };
}

describe('Database#getDispenserPriceStaleBatch', function () {
    afterEach(() => sinon.restore());

    it('flags fresh and stale Mode A and Mode B fixtures using the settlement windows', async () => {
        const db = makeDb();
        sinon.stub(db, 'getMaxBlockTime').resolves(TIP);
        sinon.stub(db, 'oracleMirrorSource').callsFake((config, table) => ({ table }));
        const snapshots = [
            { coin_pair: 'BTC/USD', price: '50000', block_timestamp: TIP - WINDOW },
            { coin_pair: 'DOGE/USD', price: '0.20', block_timestamp: TIP - WINDOW - 1 },
            { coin_pair: 'LTC/EUR', price: '80', block_timestamp: TIP - 1000 - WINDOW },
            { coin_pair: 'BTC/GBP', price: '40000', block_timestamp: TIP - 2000 - WINDOW - 1 }
        ];
        const oraclePrices = [
            { source_address: 'oracle-fresh', coin: 'LTC', tick: 'MODEB', fiat: 'EUR',
              effective_at: TIP - 1000 },
            { source_address: 'oracle-unpaired', coin: 'BTC', tick: 'MODEB', fiat: 'GBP',
              effective_at: TIP - 2000 }
        ];
        const query = sinon.stub(db, 'doQuery').callsFake(async (config, sql) => {
            if(/FROM\s+price_snapshots/i.test(sql)) return snapshots;
            if(/FROM\s+oracle_prices/i.test(sql)) return oraclePrices;
            return [];
        });
        const rows = [
            dispenser(1),
            dispenser(2, { get_coin: 'DOGE' }),
            dispenser(3, { give_coin: 'LTC', give_tick: 'MODEB', get_coin: 'LTC',
                fiat_code: 'EUR', oracle_address: 'oracle-fresh' }),
            dispenser(4, { give_tick: 'MODEB', fiat_code: 'GBP',
                oracle_address: 'oracle-unpaired' })
        ];

        const result = await db.getDispenserPriceStaleBatch(makeConfig({ coin: 'BTC' }), rows);

        expect(result).to.deep.equal({ 1: false, 2: true, 3: false, 4: true });
        expect(query.callCount).to.equal(2);
    });
});

describe('Database#getDispenserPriceStaleBatch', function () {
    afterEach(() => sinon.restore());

    it('returns boolean false without price reads for non-fiat or non-open rows', async () => {
        const db = makeDb();
        const tip = sinon.stub(db, 'getMaxBlockTime');
        const query = sinon.stub(db, 'doQuery');
        const rows = [
            dispenser(5, { fiat_code: null }),
            dispenser(6, { current_status: 'cancelled' }),
            dispenser(7, { status: 'invalid' })
        ];

        const result = await db.getDispenserPriceStaleBatch(makeConfig({ coin: 'BTC' }), rows);

        expect(result).to.deep.equal({ 5: false, 6: false, 7: false });
        expect(tip.called).to.equal(false);
        expect(query.called).to.equal(false);
    });

    it('fails safe when the current tip time is unavailable', async () => {
        const db = makeDb();
        sinon.stub(db, 'getMaxBlockTime').resolves(0);
        sinon.stub(db, 'doQuery');
        const result = await db.getDispenserPriceStaleBatch(makeConfig({ coin: 'BTC' }), [dispenser(8)]);
        expect(result).to.deep.equal({ 8: true });
    });

    it('uses the full two-window snapshot range needed for Mode B pairing', async () => {
        const db = makeDb();
        sinon.stub(db, 'getMaxBlockTime').resolves(TIP);
        sinon.stub(db, 'oracleMirrorSource').callsFake((config, table) => ({ table }));
        const query = sinon.stub(db, 'doQuery').resolves([]);
        await db.getDispenserPriceStaleBatch(makeConfig({ coin: 'BTC' }), [
            dispenser(9, { oracle_address: 'oracle', give_tick: 'MODEB' })
        ]);
        const snapshotCall = query.getCalls().find((call) => /FROM\s+price_snapshots/i.test(call.args[1]));
        expect(snapshotCall.args[2].slice(-2)).to.deep.equal([TIP - (2 * WINDOW), TIP]);
        expect(snapshotCall.args[1]).to.match(/status\s*=\s*'finalized'/i);
        expect(snapshotCall.args[1]).to.match(/price\s+IS\s+NOT\s+NULL/i);
    });
});
