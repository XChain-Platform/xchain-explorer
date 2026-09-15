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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, mockResults, makeDb, cfg } = require('./helpers.js');

let db;

describe('Database#getTransaction', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns a data object with tx_index, tx_hash, block_index, timestamp, source, actions, tx_data', async () => {
        const txRow      = mockResults.transactionRow();
        const actionRows = mockResults.actionRows();

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            if(call === 1) return txRow;
            if(call === 2) return actionRows;
            return [];
        });
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (cfg, actions) => actions);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data).to.have.property('tx_index', 1);
        expect(data).to.have.property('tx_hash', 'abc123');
        expect(data).to.have.property('block_index', 500);
        expect(data).to.have.property('actions').that.is.an('array');
    });

    it('populates data.actions from the second doQuery call', async () => {
        const txRow      = mockResults.transactionRow();
        const actionRows = mockResults.actionRows();

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            if(call === 1) return txRow;
            if(call === 2) return actionRows;
            return [];
        });
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (cfg, actions) => actions);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.actions).to.have.length(2);
        expect(data.actions[0].action_index).to.equal(100);
    });

    it('sets tx_data to null when getTransactionData returns null', async () => {
        sinon.stub(db, 'doQuery').callsFake(async () => mockResults.transactionRow());
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.tx_data).to.be.null;
    });
});

describe('Database#getTransaction', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('sets tx_data from getTransactionData when it returns a row with .data', async () => {
        const txRow     = mockResults.transactionRow();
        const decoderRow = { tx_index: 1, block_index: 500, hash: 'abc123', fee: 1000, amount: 50000, data: 'XCHN...' };

        let call = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            call++;
            return call === 1 ? txRow : mockResults.actionRows();
        });
        sinon.stub(db, 'getTransactionData').resolves(decoderRow);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'abc123', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.tx_data).to.equal('XCHN...');
    });

    it('returns empty actions array when first doQuery returns no transaction', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);

        const config = cfg({ data: { search: 'notfound', type: 'tx_hash', sql: { where: { data: 'm.tx_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getTransaction(config);
        expect(data.actions).to.deep.equal([]);
    });
});

describe('Database#getAddressId', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the id when address is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.addressIdRow());

        const id = await db.getAddressId(cfg(), 'addr1');
        expect(id).to.equal(42);
    });

    it('returns null when address is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const id = await db.getAddressId(cfg(), 'unknown');
        expect(id).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const id = await db.getAddressId(cfg(), 'addr1');
        expect(id).to.be.null;
    });
});

describe('Database#getTickId', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the id when tick is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.tickIdRow());

        const id = await db.getTickId(cfg(), 'XCHAIN');
        expect(id).to.equal(7);
    });

    it('returns null when tick is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const id = await db.getTickId(cfg(), 'MISSING');
        expect(id).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const id = await db.getTickId(cfg(), 'XCHAIN');
        expect(id).to.be.null;
    });

    it('resolves a ^id reference directly to its numeric id, no DB lookup', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTickId(cfg(), '^7')).to.equal(7);
        expect(await db.getTickId(cfg(), '^1234')).to.equal(1234); // NOT truncated to 123
        expect(dq.called).to.equal(false);
    });

    it('falls through to a name lookup when the ^body is non-numeric', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTickId(cfg(), '^abc')).to.be.null;
    });
});

describe('Database#getActionType', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the action type string when action_index is found', async () => {
        sinon.stub(db, 'doQuery').resolves(mockResults.actionTypeRow('SEND'));

        const type = await db.getActionType(cfg(), 100);
        expect(type).to.equal('SEND');
    });

    it('returns null when action_index is not found (empty results)', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const type = await db.getActionType(cfg(), 9999);
        expect(type).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const type = await db.getActionType(cfg(), 100);
        expect(type).to.be.null;
    });

    it('returns different action types correctly', async () => {
        const types = ['ISSUE', 'MINT', 'DISPENSER', 'ORDER', 'SWEEP'];
        for(const expected of types){
            sinon.restore();
            const db2 = makeDb();
            sinon.stub(db2, 'doQuery').resolves(mockResults.actionTypeRow(expected));
            const type = await db2.getActionType(cfg(), 1);
            expect(type).to.equal(expected);
        }
    });
});

describe('Database#getToken escrow_action_index', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('selects t1.escrow_action_index and surfaces it under info', async () => {
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (cfgArg, query) => {
            // getToken now also runs follow-up lookups (tick id, controller
            // bindings); capture only the main token SELECT.
            if(query.includes('FROM\n                        tokens t1'))
                captured = query;
            const rows = mockResults.tokenRow();
            rows[0].escrow_action_index = 4242;
            return rows;
        });
        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(captured).to.include('t1.escrow_action_index');
        expect(data.info.escrow_action_index).to.equal(4242);
    });

    it('is null for a token whose ownership is not escrowed', async () => {
        sinon.stub(db, 'doQuery').callsFake(async () => {
            const rows = mockResults.tokenRow();
            rows[0].escrow_action_index = null;
            return rows;
        });
        const config = cfg({ data: { search: 'XCHAIN' } });
        const [data] = await db.getToken(config);
        expect(data.info.escrow_action_index).to.be.null;
    });
});
