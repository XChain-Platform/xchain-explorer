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

describe('Database#getData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [data, total] when both data and count queries succeed', async () => {
        const rows      = mockResults.sendRows();
        const countRows = mockResults.countRow(42);
        let   callCount = 0;
        sinon.stub(db, 'doQuery').callsFake(async () => {
            callCount++;
            return callCount === 1 ? rows : countRows;
        });
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, 'SELECT count(*) as total FROM sends']);

        const config = cfg({ data: { method: 'getSends', search: null, query: {}, sql: { where: { data: 'm.action_index IS NOT NULL', offset: '' }, order: 'DESC', limit: 100 }, offset: { action: null, start: null, stop: null } } });
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(rows);
        expect(total).to.equal(42);
    });

    it('returns [data, null] when no count query is provided', async () => {
        const rows = mockResults.sendRows();
        sinon.stub(db, 'doQuery').resolves(rows);
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, '']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(rows);
        expect(total).to.be.null;
    });

    it('returns [[], null] when query is empty string', async () => {
        sinon.stub(db, 'getQuery').resolves(['', null, '']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal([]);
        expect(total).to.be.null;
    });

    it('passes object query directly as data without calling doQuery', async () => {
        const objectData = { custom: true };
        sinon.stub(db, 'getQuery').resolves([objectData, null, null]);
        const doQueryStub = sinon.stub(db, 'doQuery');

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.deep.equal(objectData);
        expect(doQueryStub.called).to.be.false;
        expect(total).to.be.null;
    });
});

describe('Database#getData', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns numeric count from object query when count is numeric', async () => {
        const objectData = [{ id: 1 }];
        sinon.stub(db, 'getQuery').resolves([objectData, null, 99]);
        sinon.stub(db, 'doQuery');

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(total).to.equal(99);
    });

    it('returns [false, 0] when doQuery returns false and count query exists', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        sinon.stub(db, 'getQuery').resolves(['SELECT 1', null, 'SELECT count(*) as total FROM x']);

        const config = cfg();
        const [data, total] = await db.getData(config);
        expect(data).to.equal(false);
        expect(total).to.equal(0);
    });
});

describe('Database#getAddress', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // getAddress appends controller bindings AND surfaces info.address_id (the latter
        // via getCompactableAddressId -> doQuery, F3). Stub both so these header-shape
        // assertions don't need a live pool. doQuery -> [] => info.address_id null.
        sinon.stub(db, 'getAddressControllerBindings').resolves([]);
        sinon.stub(db, 'doQuery').resolves([]);
    });
    afterEach(() => { sinon.restore(); });

    it('returns a data object with the expected top-level keys', async () => {
        const config = cfg({ data: { search: 'addr1bc' } });
        const [data] = await db.getAddress(config);
        // controllers surfaces the address's active controller bindings ([] with no binding);
        // info carries the SDK-facing address/address_id (F3, see below).
        // tracker_available flags whether this coin's xchain-utxo-tracker answered (false here:
        // no tracker stubbed, so balances/utxos stay null and the page shows "Unavailable").
        expect(data).to.have.keys(['address', 'type', 'balances', 'utxos', 'estimated_value', 'tracker_available', 'controllers', 'info']);
        expect(data.controllers).to.deep.equal([]);
        // F3: no deterministic id resolved (doQuery -> []) => address_id is null, not compacted.
        expect(data.info).to.deep.equal({ address: 'addr1bc', address_id: null });
    });

    it('surfaces a deterministic index id under info.address_id when one exists (F3)', async () => {
        db.doQuery.restore();
        sinon.stub(db, 'doQuery').resolves([{ id: 99 }]);   // block_index-stamped id
        const [data] = await db.getAddress(cfg({ data: { search: 'bc1qDet' } }));
        expect(data.info.address_id).to.equal(99);
    });

    it('echoes the search address into data.address', async () => {
        const config = cfg({ data: { search: 'bc1qtest' } });
        const [data] = await db.getAddress(config);
        expect(data.address).to.equal('bc1qtest');
    });

    it('returns balances with confirmed, pending, received fields', async () => {
        const config = cfg({ data: { search: 'addr' } });
        const [data] = await db.getAddress(config);
        expect(data.balances).to.have.keys(['confirmed', 'pending', 'received']);
    });

    it('returns utxos with confirmed and pending fields', async () => {
        const config = cfg({ data: { search: 'addr' } });
        const [data] = await db.getAddress(config);
        expect(data.utxos).to.have.keys(['confirmed', 'pending']);
    });
});

let db;

describe('Database#getBlock', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the first result row when query succeeds', async () => {
        const row = mockResults.blockRow()[0];
        sinon.stub(db, 'doQuery').resolves([row]);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.deep.equal(row);
    });

    it('returns null when no rows found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);

        const config = cfg({ data: { search: '9999', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.be.null;
    });

    it('includes expected block fields in the result', async () => {
        const row = mockResults.blockRow()[0];
        sinon.stub(db, 'doQuery').resolves([row]);

        const config = cfg({ data: { search: '500', sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
        const [data] = await db.getBlock(config);
        expect(data).to.include.keys(['block_index', 'timestamp', 'ledger_hash', 'actions_hash', 'contract_hash']);
    });
});

describe('Database#getBlock', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // The segment is bound against the BIGINT block_index and MariaDB coerces a
    // non-numeric string to 0, so an unguarded /api/block/zzz would answer 200
    // with BLOCK 0's real record. The refusal lives here, in the reader that
    // binds the value, so every caller is covered and not only the HTTP route.
    describe('malformed block id', () => {
        const BAD = ['zzz-no-such-entity-9999', 'junk', '9junk', '', ' ', '7.5', '-1', '1e5', '0x7', '500 ', 'null'];

        BAD.forEach((bad) => {
            it(`refuses ${JSON.stringify(bad)} instead of coercing it to a real block`, async () => {
                const query = sinon.stub(db, 'doQuery').resolves(mockResults.blockRow());
                const config = cfg({ data: { search: bad, sql: { where: { data: 'b1.block_index IS NOT NULL AND b1.block_index=?', offset: '' } } } });
                let err = null;
                try {
                    await db.getBlock(config);
                } catch (e) { err = e; }
                expect(err, 'getBlock threw').to.not.be.null;
                expect(err.name).to.equal('DbInputError');
                expect(err.code).to.equal('INVALID_BLOCK_INDEX');
                expect(query.called, 'the DB was never queried').to.be.false;
            });
        });

        it('refuses a missing segment (search null)', async () => {
            const query = sinon.stub(db, 'doQuery').resolves(mockResults.blockRow());
            const config = cfg({ data: { search: null, sql: { where: { data: 'b1.block_index IS NOT NULL', offset: '' } } } });
            let err = null;
            try {
                await db.getBlock(config);
            } catch (e) { err = e; }
            expect(err && err.code).to.equal('INVALID_BLOCK_INDEX');
            expect(query.called).to.be.false;
        });

        it('still serves block 0 when block 0 is what was actually asked for', async () => {
            const row = mockResults.blockRow()[0];
            sinon.stub(db, 'doQuery').resolves([row]);
            const config = cfg({ data: { search: '0', sql: { where: { data: 'b1.block_index IS NOT NULL AND b1.block_index=?', offset: '' } } } });
            const [data] = await db.getBlock(config);
            expect(data).to.deep.equal(row);
        });

        it('surfaces the refusal through getData, the path the route actually calls', async () => {
            const query = sinon.stub(db, 'doQuery').resolves(mockResults.blockRow());
            const config = cfg({ data: { method: 'getBlock', search: 'zzz-no-such-entity-9999', type: 'block' } });
            let err = null;
            try {
                await db.getData(config);
            } catch (e) { err = e; }
            expect(err && err.name).to.equal('DbInputError');
            expect(err.code).to.equal('INVALID_BLOCK_INDEX');
            expect(query.called, 'the DB was never queried').to.be.false;
        });
    });
});
