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

// Thin single-schema pool wrapper backing the embedded hub-DB mirror:
// doQuery contract (release on success AND failure), schema self-provisioning,
// and the safe-identifier guard on the schema name.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

function load() {
    const conn = { query: sinon.stub().resolves([{ ok: 1 }]), release: sinon.stub() };
    const pool = { getConnection: sinon.stub().resolves(conn), end: sinon.stub().resolves() };
    const schemaConn = { query: sinon.stub().resolves(), end: sinon.stub().resolves() };
    const mariadb = {
        createPool:       sinon.stub().returns(pool),
        createConnection: sinon.stub().resolves(schemaConn)
    };
    const HubMirrorPool = proxyquire('../../src/hub-mirror-pool.js', { mariadb });
    return { HubMirrorPool, mariadb, pool, conn, schemaConn };
}

const CFG = { host: '127.0.0.1', port: 3306, user: 'u', pass: 'p', name: 'XChain_Hub_Mirror' };

describe('HubMirrorPool', function () {

    afterEach(function () { sinon.restore(); });

    it('rejects an unsafe schema identifier at construction', function () {
        const { HubMirrorPool } = load();
        expect(() => new HubMirrorPool({ ...CFG, name: 'bad`name' })).to.throw(/not a safe identifier/);
    });

    it('binds the pool to the mirror schema', function () {
        const { HubMirrorPool, mariadb } = load();
        new HubMirrorPool(CFG);
        expect(mariadb.createPool.firstCall.args[0].database).to.equal('XChain_Hub_Mirror');
    });

    it('doQuery releases the connection on success', async function () {
        const { HubMirrorPool, conn } = load();
        const rows = await new HubMirrorPool(CFG).doQuery('SELECT 1', []);
        expect(rows).to.deep.equal([{ ok: 1 }]);
        expect(conn.release.calledOnce).to.equal(true);
    });

    it('doQuery releases the connection when the query throws', async function () {
        const { HubMirrorPool, conn } = load();
        conn.query.rejects(new Error('boom'));
        let err = null;
        try { await new HubMirrorPool(CFG).doQuery('SELECT 1', []); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(conn.release.calledOnce).to.equal(true);
    });

    it('ensureDatabase creates the schema on a schema-less connection and closes it', async function () {
        const { HubMirrorPool, mariadb, schemaConn } = load();
        await new HubMirrorPool(CFG).ensureDatabase();
        expect(mariadb.createConnection.firstCall.args[0].database).to.equal(undefined);
        expect(schemaConn.query.firstCall.args[0]).to.contain('CREATE DATABASE IF NOT EXISTS `XChain_Hub_Mirror`');
        expect(schemaConn.end.calledOnce).to.equal(true);
    });

    it('ensureDatabase closes the connection even when CREATE fails', async function () {
        const { HubMirrorPool, schemaConn } = load();
        schemaConn.query.rejects(new Error('access denied'));
        let err = null;
        try { await new HubMirrorPool(CFG).ensureDatabase(); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(schemaConn.end.calledOnce).to.equal(true);
    });
});
