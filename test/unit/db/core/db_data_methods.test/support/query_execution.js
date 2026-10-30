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

function setupMockPool(coin, fakeConn, queryTimeout) {
    db.pools = {};
    db.pools[coin] = {
        pool: { getConnection: sinon.stub().resolves(fakeConn) },
        config: queryTimeout ? { queryTimeout } : {}
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

    it('fails a frozen statement closed at the client-side wall-clock deadline', async () => {
        const clock = sinon.useFakeTimers();
        const fakeConn = {
            query:   sinon.stub().returns(new Promise(() => {})),
            release: sinon.spy(),
            destroy: sinon.spy()
        };
        setupMockPool('BTC', fakeConn, 25);

        let outcome;
        db.doQuery(cfg(), 'SELECT frozen', []).then(
            () => { outcome = 'resolved'; },
            (error) => { outcome = error; }
        );
        await clock.tickAsync(26);

        expect(outcome).to.be.an('error');
        expect(outcome.name).to.equal('DbQueryError');
        expect(outcome.cause.code).to.equal('DB_DEADLINE_EXCEEDED');
        expect(fakeConn.destroy.calledOnce).to.equal(true);
        expect(fakeConn.release.called).to.equal(false);
    });

    it('fails a frozen pool acquisition closed at the client-side wall-clock deadline', async () => {
        const clock = sinon.useFakeTimers();
        db.pools = {
            BTC: {
                pool: { getConnection: sinon.stub().returns(new Promise(() => {})) },
                config: { queryTimeout: 25 }
            }
        };

        let outcome;
        db.doQuery(cfg(), 'SELECT frozen', []).then(
            () => { outcome = 'resolved'; },
            (error) => { outcome = error; }
        );
        await clock.tickAsync(26);

        expect(outcome).to.be.an('error');
        expect(outcome.name).to.equal('DbQueryError');
        expect(outcome.cause.code).to.equal('DB_DEADLINE_EXCEEDED');
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
