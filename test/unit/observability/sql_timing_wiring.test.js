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
 * XChain Explorer - SQL timing integration wiring
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const express = require('express');
const proxyquire = require('proxyquire');
const request = require('supertest');

const observability = require('../../../src/observability');
const { setNetworkPools } = require('../../../src/db/connection/pool_setup.js');
const { mountJsonRpc } = require('../../../src/http/api_boot/json_rpc.js');

const TIMING_ENV = {
    SQL_TIMING_ENABLED: '1',
    SQL_TIMING_URL: 'https://timing.example.test/intake',
    SQL_TIMING_KEY: 'test-key',
    SQL_TIMING_PROJECT: 'xchain-platform',
    SQL_TIMING_REQUEST_RATE: '1',
    SQL_TIMING_STATEMENT_RATE: '0',
    SQL_TIMING_INTERVAL_MS: '60000'
};
const TIMING_KEYS = Object.keys(TIMING_ENV);

function makePool() {
    const connection = {
        query: async () => [{ ok: true }],
        release: () => {}
    };
    return {
        query: async () => [{ ok: true }],
        getConnection: async () => connection,
        end: async () => {}
    };
}

function makeDatabase() {
    return {
        pools: {},
        decoderDb: {},
        decoderPools: {},
        checkpointDb: {},
        baseCoin: {},
        decoderApiUrl: {},
        util: { isNull: (value) => value === null || value === undefined },
        decoderApiUrlFromConfig: () => ''
    };
}

function makeNetworkInfo() {
    return {
        regtest: {
            database: {
                indexer: {
                    db_host: 'indexer-db', db_port: 3306,
                    user: 'indexer', pass: 'indexer-pass', name: 'indexer'
                },
                decoder: {
                    db_host: 'decoder-db', db_port: 3306,
                    user: 'decoder', pass: 'decoder-pass', name: 'decoder'
                }
            }
        }
    };
}

describe('SQL timing explorer wiring', function () {
    const savedEnv = {};
    let timing;

    beforeEach(function () {
        for (const key of TIMING_KEYS) {
            savedEnv[key] = process.env[key];
            process.env[key] = TIMING_ENV[key];
        }
        observability._resetObservability();
    });

    afterEach(async function () {
        if (timing) await timing.stop();
        timing = null;
        for (const key of TIMING_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        observability._resetObservability();
    });

    it('emits one RPC line counting indexer, decoder, and mirror queries', async function () {
        const createdPools = [];
        const mariadb = {
            createPool: () => {
                const pool = makePool();
                createdPools.push(pool);
                return pool;
            }
        };
        const db = makeDatabase();
        setNetworkPools(db, mariadb, makeNetworkInfo(), 'BTC', 'regtest');

        const mirrorPool = makePool();
        const HubMirrorPool = proxyquire.noCallThru()('../../../src/mirror/pool.js', {
            mariadb: { createPool: () => mirrorPool }
        });
        const mirror = new HubMirrorPool({
            host: 'mirror-db', port: 3306, user: 'mirror', pass: 'mirror-pass', name: 'hub_mirror'
        });

        const shipped = [];
        const app = express();
        app.use(express.json());
        timing = observability.installSqlTiming(app, {
            service: 'xchain-explorer',
            env: TIMING_ENV,
            transport: async (outbound) => {
                shipped.push(outbound);
                return { status: 200 };
            }
        });
        mountJsonRpc(app, { env: {} }, {
            probe: async () => {
                await db.pools.RBTC.pool.query('SELECT 1');
                await db.decoderPools.RBTC.query('SELECT 2');
                await mirror.doQuery('SELECT 3');
                return 'ok';
            }
        });

        const response = await request(app).post('/').send({
            jsonrpc: '2.0', id: 1, method: 'probe', params: []
        });
        expect(response.status).to.equal(200);
        expect(response.body.result).to.equal('ok');
        await timing.flush();

        expect(createdPools).to.have.lengthOf(2);
        expect(shipped).to.have.lengthOf(1);
        const lines = shipped[0].body.trim().split('\n').map((line) => JSON.parse(line));
        expect(lines).to.have.lengthOf(1);
        expect(lines[0].route).to.equal('POST /xchain-explorer/rpc/probe');
        expect(lines[0].query_count).to.equal(3);
    });
});
