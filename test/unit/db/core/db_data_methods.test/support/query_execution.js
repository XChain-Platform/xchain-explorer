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

function setupMockPool(coin, fakeConn) {
    db.pools = {};
    db.pools[coin] = {
        pool: { getConnection: sinon.stub().resolves(fakeConn) },
        config: {}
    };
}

describe('Database#doQuery', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns query results on success', async () => {
        const fakeRows = mockResults.sendRows();
        const fakeConn = {
            query:   sinon.stub().resolves(fakeRows),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        const result = await db.doQuery(cfg(), 'SELECT 1', []);
        expect(result).to.deep.equal(fakeRows);
    });

    it('throws DbQueryError when a SQL error is thrown rather than reading as an empty result', async () => {
        const fakeConn = {
            query:   sinon.stub().rejects(new Error('Table not found')),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        let err = null;
        try { await db.doQuery(cfg(), 'SELECT bad', []); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.name).to.equal('DbQueryError');
        expect(err.code).to.equal('DB_ERROR');
    });

    it('throws DbQueryError when no pool exists for the coin', async () => {
        db.pools = {};
        let err = null;
        try { await db.doQuery(cfg(), 'SELECT 1', []); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.name).to.equal('DbQueryError');
    });

    it('always calls release() after a successful query', async () => {
        const fakeConn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        await db.doQuery(cfg(), 'SELECT 1', []);
        expect(fakeConn.release.calledOnce).to.be.true;
    });
});

describe('Database#doQuery', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('always calls release() even after a SQL error', async () => {
        const fakeConn = {
            query:   sinon.stub().rejects(new Error('boom')),
            release: sinon.stub().resolves()
        };
        setupMockPool('BTC', fakeConn);

        // doQuery rethrows the failure so an outage surfaces as an error, not silently
        // as empty data; release() must still run via finally.
        try { await db.doQuery(cfg(), 'SELECT 1', []); } catch (e) { /* expected */ }
        expect(fakeConn.release.calledOnce).to.be.true;
    });

    it('skips query execution when query is null', async () => {
        db.pools = {};
        const result = await db.doQuery(cfg(), null, []);
        expect(result).to.equal(false);
    });
});
