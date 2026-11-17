'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The reconcile's ALTERs run before the mirror client starts, so one refused by the
// pool's 30 s read limit leaves that coin's mirror unstarted. Every statement the
// reconcile writes must reach doQuery flagged as DDL, its probes must not be, and the
// pool must run a flagged statement under the migration-scale limit.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const { ensureMirrorColumns } = require('../../../../src/mirror/migrate.js');

// A pool whose mariadb is a stub, so the statement handed to conn.query is visible.
function stubbedPool() {
    const conn = { query: sinon.stub().resolves([]), release: sinon.stub() };
    const mariadb = { createPool: sinon.stub().returns({ getConnection: sinon.stub().resolves(conn) }) };
    const HubMirrorPool = proxyquire('../../../../src/mirror/pool.js', { mariadb });
    return { pool: new HubMirrorPool({ host: 'h', port: 3306, user: 'u', pass: 'p', name: 'XChain_Hub_Mirror' }), conn };
}

// A connection where price_snapshots exists with no columns or indexes, recording each call.
function recordingDb(calls) {
    return {
        doQuery(sql, params, opts) {
            calls.push({ sql, ddl: Boolean(opts && opts.ddl) });
            if (/^SHOW TABLES LIKE/i.test(sql)) return Promise.resolve(params[0] === 'price_snapshots' ? [{ t: 1 }] : []);
            if (/^SHOW (FULL )?COLUMNS|^SHOW INDEX/i.test(sql)) return Promise.resolve([]);
            return Promise.resolve();
        }
    };
}

describe('hub-mirror DDL statement limit', function () {
    afterEach(function () { sinon.restore(); });

    it('the reconcile flags every ALTER it runs as ddl and no SHOW probe', async function () {
        const calls = [];
        const applied = await ensureMirrorColumns(recordingDb(calls), () => {});
        const ddl = calls.filter((c) => !/^SHOW /i.test(c.sql));
        expect(applied.length).to.be.at.least(1);
        expect(ddl.map((c) => c.sql)).to.deep.equal(applied);
        expect(ddl.every((c) => c.ddl), 'an ALTER ran under the read limit').to.equal(true);
        expect(calls.filter((c) => /^SHOW /i.test(c.sql)).some((c) => c.ddl)).to.equal(false);
    });

    it('the pool runs a ddl statement under the migration-scale limit and a read under its own', async function () {
        const { pool, conn } = stubbedPool();
        await pool.doQuery('ALTER TABLE `price_snapshots` ADD KEY k (a)', undefined, { ddl: true });
        await pool.doQuery('SELECT 1', []);
        expect(conn.query.firstCall.args[0]).to.deep.equal({ sql: 'ALTER TABLE `price_snapshots` ADD KEY k (a)', timeout: 3600000 });
        expect(conn.query.secondCall.args[0]).to.equal('SELECT 1');
        expect(conn.release.callCount).to.equal(2);
    });
});
