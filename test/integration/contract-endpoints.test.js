'use strict';

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
 * Integration tests: Contract page fields + read-only simulation
 *
 * Covers the getContract computed fields (code_hash_ok / methods /
 * constructor_params, seeded as contract action 40) and the
 * POST /{COIN}/api/contract/{idx}/call simulation endpoint.
 *
 * The simulation tests need the optional xchain-vm (isolated-vm builds only
 * on Node 22); when it is unavailable they SKIP with a clear message instead
 * of failing, mirroring the endpoint's own degraded mode.
 *
 * Requires: a MariaDB instance on port 3307 (see fixtures/docker-compose.test.yml)
 */

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;
let vmAvailable = true;
try { require('xchain-vm'); } catch (e) { vmAvailable = false; }

const CONTRACT_IDX = 40;

describe('Contract endpoints (integration)', function () {

    let envBackup;

    before(async function () {
        this.timeout(30000);
        await db.setupDatabase();
        const { app } = await createApp();
        request = supertest(app);
        envBackup = process.env.EXPLORER_VM_QUERY_ENABLED;
        process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
    });

    after(async function () {
        if (envBackup === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
        else process.env.EXPLORER_VM_QUERY_ENABLED = envBackup;
        // Tear down the VM subprocess so mocha can exit cleanly.
        try { await require('../../src/vm-query.js').shutdown(); } catch (e) { /* vm never loaded */ }
        await db.teardownDatabase();
    });

    // -----------------------------------------------------------------------
    // getContract computed fields
    // -----------------------------------------------------------------------

    describe('GET /RBTC/api/contract/{idx}', function () {

        it('returns the source with a passing integrity check', async function () {
            const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
            expect(res.status).to.equal(200);
            expect(res.body.code).to.be.a('string').and.include('module.exports');
            expect(res.body.code_hash_ok).to.equal(true);
        });

        it('extracts the callable method list from the source', async function () {
            const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
            expect(res.body.methods).to.deep.equal(['fail', 'greet', 'initialize']);
        });

        it('surfaces the deploy-time constructor params', async function () {
            const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
            expect(res.body.constructor_params).to.equal('howdy');
        });

        it('reports the simulation feature flag', async function () {
            const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
            expect(res.body.vm_query_enabled).to.equal(true);
        });

        it('serves the declared abi block with view flags', async function () {
            const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
            expect(res.body.abi.version).to.equal(1);
            expect(res.body.abi.methods.greet.view).to.equal(true);
            expect(res.body.abi.methods.greet.summary).to.equal('Read the stored greeting');
            expect(res.body.abi.methods.fail).to.not.have.property('view');
        });

        it('serves the wallet handoff URL (default when env is unset)', async function () {
            const prev = process.env.EXPLORER_WALLET_URL;
            try {
                delete process.env.EXPLORER_WALLET_URL;
                const res = await request.get(`/RBTC/api/contract/${CONTRACT_IDX}`);
                expect(res.body.wallet_url).to.equal('https://wallet.xchain.io');
            } finally {
                if (prev === undefined) delete process.env.EXPLORER_WALLET_URL;
                else process.env.EXPLORER_WALLET_URL = prev;
            }
        });
    });

    // -----------------------------------------------------------------------
    // POST /{COIN}/api/contract/{idx}/call
    // -----------------------------------------------------------------------

    describe('POST /RBTC/api/contract/{idx}/call', function () {

        it('503s with VM_QUERY_DISABLED when the flag is off', async function () {
            process.env.EXPLORER_VM_QUERY_ENABLED = 'false';
            try {
                const res = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                    .send({ method: 'greet' });
                expect(res.status).to.equal(503);
                expect(res.body.code).to.equal('VM_QUERY_DISABLED');
            } finally {
                process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
            }
        });

        it('400s on an invalid contract index', async function () {
            const res = await request.post('/RBTC/api/contract/not-a-number/call')
                .send({ method: 'greet' });
            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('INVALID_CONTRACT_INDEX');
        });

        it('400s on a missing method before touching the VM', async function () {
            const res = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`).send({});
            expect(res.status).to.equal(400);
            expect(res.body.code).to.equal('BAD_METHOD');
        });

        it('404s on an unknown coin', async function () {
            const res = await request.post(`/ZZZ/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'greet' });
            expect(res.status).to.equal(404);
        });

        // Real-VM cases below: skip cleanly where isolated-vm never built.
        function vmIt(title, fn){
            it(title, async function () {
                if (!vmAvailable) {
                    console.log('        (skipped: xchain-vm/isolated-vm unavailable in this environment)');
                    return this.skip();
                }
                this.timeout(30000);
                return fn.call(this);
            });
        }

        vmIt('simulates a state-reading method against seeded state', async function () {
            const res = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'greet' });
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(true);
            // Latest seeded value for "greeting" is "howdy"; tip block is 10.
            expect(JSON.parse(res.body.returnValue)).to.equal('howdy @10');
            expect(res.body.gasUsed).to.be.a('number').and.above(0);
            expect(res.body.simulation.note).to.include('read-only');
        });

        vmIt('404s for a missing contract row', async function () {
            const res = await request.post('/RBTC/api/contract/999999/call')
                .send({ method: 'greet' });
            expect(res.status).to.equal(404);
            expect(res.body.code).to.equal('NOT_FOUND');
        });

        vmIt('reports a revert as success:false with the VM error string', async function () {
            const res = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'fail' });
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(false);
            expect(res.body.error).to.include('revert');
        });

        vmIt('reports an unknown method as success:false', async function () {
            const res = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'noSuchMethod' });
            expect(res.status).to.equal(200);
            expect(res.body.success).to.equal(false);
            expect(res.body.error).to.include('unknown method');
        });

        vmIt('returns would-be state changes without committing them', async function () {
            // initialize writes state; run it twice and confirm the DB copy is
            // untouched (greet still reads the seeded value both times).
            const w = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'initialize', params: ['overwritten'] });
            expect(w.status).to.equal(200);
            expect(w.body.success).to.equal(true);
            expect(w.body.simulation.stateChanges).to.deep.equal([{ key: 'greeting', value: 'overwritten' }]);

            const r = await request.post(`/RBTC/api/contract/${CONTRACT_IDX}/call`)
                .send({ method: 'greet' });
            expect(JSON.parse(r.body.returnValue)).to.equal('howdy @10');
        });
    });
});
