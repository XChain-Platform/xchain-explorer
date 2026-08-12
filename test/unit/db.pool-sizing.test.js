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
 * Pool sizes are per dbType and operator-tunable.
 *
 * The indexer pool (page renders) and the decoder pool (status tip, mempool,
 * raw FILE bytes) were both literals in db.js, the decoder one at 3. An
 * operator whose decoder-backed views were queueing had no knob at all, and
 * raising the indexer pool would have dragged the decoder pool with it.
 *
 * Asserted at the mariadb.createPool config rather than against a live server,
 * because the defect is "the pool was created with a size nothing can change".
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const poolSizing = require('../../src/poolSizing.js');
const { createConfigInfoStub, getFullConfig } = require('../fixtures/mock-config.js');

const POOL_ENV_KEYS = [
    'DB_POOL_SIZE', 'DB_POOL_SIZE_INDEXER', 'DB_POOL_SIZE_DECODER', 'DB_POOL_SIZE_HUB_MIRROR',
    'DB_QUERY_TIMEOUT', 'DB_QUERY_TIMEOUT_INDEXER', 'DB_QUERY_TIMEOUT_DECODER'
];

// Decoder credentials that differ from the indexer's: the xchain-node install
// shape, and the only branch that creates a dedicated decoder pool.
function configWithDedicatedDecoderCreds(){
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

describe('explorer pool sizing is per dbType', function () {

    let Database, poolConfigs, saved;

    beforeEach(function () {
        poolConfigs = [];
        const mockMariadb = {
            createPool: sinon.stub().callsFake((cfg) => {
                poolConfigs.push(cfg);
                return {
                    end:           sinon.stub().resolves(),
                    getConnection: sinon.stub().resolves({
                        query:   sinon.stub().resolves([]),
                        release: sinon.stub().resolves()
                    })
                };
            })
        };
        Database = proxyquire('../../src/db.js', { mariadb: mockMariadb });

        saved = {};
        for (const k of POOL_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(function () {
        for (const k of POOL_ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    function freshDb() {
        return new Database({
            configInfo: createConfigInfoStub(configWithDedicatedDecoderCreds()),
            util:       new Utility()
        });
    }

    // Pools are created indexer-first, then the dedicated decoder pool for that
    // key, so bucket them by database name rather than by call order.
    function limitsByKind() {
        const decoder = poolConfigs.filter(c => /Decoder/i.test(String(c.database)));
        const indexer = poolConfigs.filter(c => !/Decoder/i.test(String(c.database)));
        return { indexer, decoder };
    }

    it('sizes the indexer and decoder pools independently by default', async function () {
        const db = freshDb();
        await db.setupConnectionPools();
        const { indexer, decoder } = limitsByKind();

        expect(indexer.length).to.be.greaterThan(0);
        expect(decoder.length).to.be.greaterThan(0, 'fixture must produce a dedicated decoder pool');
        for (const cfg of indexer)
            expect(cfg.connectionLimit).to.equal(poolSizing.DEFAULT_POOL_SIZE.indexer);
        for (const cfg of decoder)
            expect(cfg.connectionLimit).to.equal(poolSizing.DEFAULT_POOL_SIZE.decoder);
        expect(poolSizing.DEFAULT_POOL_SIZE.indexer)
            .to.be.greaterThan(poolSizing.DEFAULT_POOL_SIZE.decoder);
    });

    it('lets an operator raise the decoder pool without touching the indexer pool', async function () {
        process.env.DB_POOL_SIZE_DECODER = '12';
        const db = freshDb();
        await db.setupConnectionPools();
        const { indexer, decoder } = limitsByKind();

        for (const cfg of decoder) expect(cfg.connectionLimit).to.equal(12);
        for (const cfg of indexer)
            expect(cfg.connectionLimit).to.equal(poolSizing.DEFAULT_POOL_SIZE.indexer);
    });

    it('applies the legacy flat DB_POOL_SIZE to both when no scoped value is set', async function () {
        process.env.DB_POOL_SIZE = '7';
        const db = freshDb();
        await db.setupConnectionPools();
        for (const cfg of poolConfigs) expect(cfg.connectionLimit).to.equal(7);
    });

    it('resolves the query timeout per dbType too', async function () {
        process.env.DB_QUERY_TIMEOUT_DECODER = '5000';
        const db = freshDb();
        await db.setupConnectionPools();
        const { indexer, decoder } = limitsByKind();
        for (const cfg of decoder) expect(cfg.queryTimeout).to.equal(5000);
        for (const cfg of indexer) expect(cfg.queryTimeout).to.equal(30000);
    });
});

describe('explorer poolSizing resolver', function () {

    it('clamps out-of-range values so one setting cannot exhaust max_connections', function () {
        expect(poolSizing.resolvePoolSize('indexer', { DB_POOL_SIZE_INDEXER: '9999' }))
            .to.equal(poolSizing.MAX_POOL_SIZE);
        expect(poolSizing.resolvePoolSize('indexer', { DB_POOL_SIZE_INDEXER: '0' }))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE.indexer);
        expect(poolSizing.resolvePoolSize('indexer', { DB_POOL_SIZE_INDEXER: '-3' }))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE.indexer);
    });

    it('ignores malformed values instead of writing NaN into the pool config', function () {
        expect(poolSizing.resolvePoolSize('decoder', { DB_POOL_SIZE_DECODER: 'many' }))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE.decoder);
        expect(poolSizing.resolvePoolSize('decoder', { DB_POOL_SIZE_DECODER: '  ' }))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE.decoder);
    });

    it('maps a dashed dbType onto an underscored env name', function () {
        expect(poolSizing.resolvePoolSize('hub-mirror', { DB_POOL_SIZE_HUB_MIRROR: '6' })).to.equal(6);
        expect(poolSizing.resolvePoolSize('hub-mirror', {}))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE['hub-mirror']);
    });

    it('treats an unknown dbType as the indexer profile', function () {
        expect(poolSizing.resolvePoolSize('checkpoint', {}))
            .to.equal(poolSizing.DEFAULT_POOL_SIZE.indexer);
    });
});
