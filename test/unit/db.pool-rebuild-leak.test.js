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
 * setupConnectionPools() must not orphan pool handles on re-entry.
 *
 * _rebuildPoolsIfStale() re-enters setup as a lazy recovery path whenever a
 * query finds no pool, throttled to once per 10 seconds. Every pool handle the
 * rebuild drops WITHOUT calling end() keeps its connections alive until the
 * process exits, so a stack that rebuilds continuously leaks continuously.
 *
 * The guard for `this.pools` was written for exactly this reason. `decoderPools`
 * was missed, and it is the DEFAULT deployment shape rather than an edge case:
 * xchain-node installs provision per-service DB users, which is precisely the
 * condition that creates a dedicated decoder pool. A live regtest explorer had
 * accumulated 870 of its server's 1000 connections over four days, which
 * surfaced as OTHER services being unable to connect at all.
 *
 * These assert on end() call counts rather than on a live connection count,
 * because the leak is "a handle was dropped without being closed" and that is
 * observable at the handle, deterministically and with no database.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub, getFullConfig } = require('../fixtures/mock-config.js');

// A config whose DECODER credentials differ from the indexer's, which is what
// makes setupConnectionPools take the dedicated-decoder-pool branch. The stock
// fixture shares one user for both, so it never creates one and cannot see this
// defect at all.
function configWithDedicatedDecoderCreds() {
    const cfg = getFullConfig();
    for (const net of ['mainnet', 'regtest']) {
        cfg.BTC[net].database.decoder = {
            db_host: '127.0.0.1', db_port: 3306,
            user: 'decoder_user', pass: 'decoder_pass',
            name: 'XChain_BTC_' + net + '_Decoder'
        };
    }
    return cfg;
}

describe('setupConnectionPools does not orphan pools on re-entry', function () {

    let mockMariadb, Database, createdPools;

    beforeEach(function () {
        createdPools = [];
        mockMariadb = {
            createPool: sinon.stub().callsFake(() => {
                const pool = {
                    end:           sinon.stub().resolves(),
                    getConnection: sinon.stub().resolves({
                        query:   sinon.stub().resolves([]),
                        release: sinon.stub().resolves()
                    })
                };
                createdPools.push(pool);
                return pool;
            })
        };
        Database = proxyquire(process.env.POOL_REBUILD_TEST_DB_SRC || '../../src/db.js', { mariadb: mockMariadb });
    });

    afterEach(function () {
        sinon.restore();
    });

    function freshDb() {
        return new Database({
            configInfo: createConfigInfoStub(configWithDedicatedDecoderCreds()),
            util:       new Utility()
        });
    }

    it('creates a dedicated decoder pool when decoder creds differ (guards the fixture)', async function () {
        const db = freshDb();
        await db.setupConnectionPools();
        expect(Object.keys(db.decoderPools).length).to.be.greaterThan(0,
            'fixture no longer produces a dedicated decoder pool, so the rest of ' +
            'this suite would pass vacuously');
    });

    it('ends every decoder pool it drops on rebuild', async function () {
        const db = freshDb();
        await db.setupConnectionPools();
        const firstRoundDecoderPools = Object.values(db.decoderPools);

        await db.setupConnectionPools();

        for (const pool of firstRoundDecoderPools) {
            expect(pool.end.callCount).to.equal(1,
                'a decoder pool was dropped without end(); its connections leak ' +
                'until the process exits');
        }
    });

    it('ends every indexer pool it drops on rebuild', async function () {
        const db = freshDb();
        await db.setupConnectionPools();
        const firstRoundIndexerPools = [...new Set(
            Object.values(db.pools).map(entry => entry.pool).filter(Boolean))];

        await db.setupConnectionPools();

        for (const pool of firstRoundIndexerPools) {
            expect(pool.end.callCount).to.equal(1, 'an indexer pool was dropped without end()');
        }
    });

    it('leaves no pool handle unclosed across repeated rebuilds', async function () {
        // The shape of the production failure: rebuild many times and assert that
        // every handle except the live generation has been closed. At 10s
        // throttling this is roughly two minutes of a continuously-rebuilding
        // explorer.
        const db = freshDb();
        const REBUILDS = 12;
        for (let i = 0; i < REBUILDS; i++) await db.setupConnectionPools();

        const live = new Set([
            ...Object.values(db.pools).map(e => e.pool).filter(Boolean),
            ...Object.values(db.decoderPools)
        ]);
        const leaked = createdPools.filter(p => !live.has(p) && p.end.callCount === 0);

        expect(leaked.length).to.equal(0,
            leaked.length + ' of ' + createdPools.length + ' pool handles were ' +
            'orphaned without end() over ' + REBUILDS + ' rebuilds');
    });

    it('closes each shared handle exactly once', async function () {
        // The setup loop deliberately assigns ONE pool object to several keys when
        // they resolve to the same host/port/user/database, so a naive per-key
        // close would call end() repeatedly on the same handle.
        const db = freshDb();
        await db.setupConnectionPools();
        const before = [...new Set(Object.values(db.pools).map(e => e.pool).filter(Boolean))];

        await db.setupConnectionPools();

        for (const pool of before) {
            expect(pool.end.callCount).to.equal(1,
                'a shared pool handle was closed ' + pool.end.callCount + ' times');
        }
    });

    it('survives a pool whose end() rejects, and still closes the others', async function () {
        // Closing runs on the way to replacing the map, so one uncooperative pool
        // must not abort the rebuild and strand every handle behind it.
        const db = freshDb();
        await db.setupConnectionPools();
        const all = [...new Set([
            ...Object.values(db.pools).map(e => e.pool).filter(Boolean),
            ...Object.values(db.decoderPools)
        ])];
        all[0].end = sinon.stub().rejects(new Error('connection reset'));

        await db.setupConnectionPools();

        for (const pool of all.slice(1)) {
            expect(pool.end.callCount).to.equal(1,
                'a failing end() on one pool stopped the others from being closed');
        }
    });
});
