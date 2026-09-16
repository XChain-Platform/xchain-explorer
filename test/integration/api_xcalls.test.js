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
 * Integration tests for the XCALL (cross-chain call) read endpoints.
 *
 * Boots a real Express app against the test MariaDB and exercises:
 *   - GET /{COIN}/api/xcalls[/{query}/{block|contract|status}]  (list)
 *   - GET /{COIN}/api/xcall/{call_id}                            (lifecycle)
 *
 * Seed (fixtures/seed-baseline.sql): one completed XCALL (action 31, block 10,
 * source contract 11 → DOGE:99) plus its execution + callback rows.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;
let app, explorer, configInfo;

const CALL_ID = 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe';

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    ({ app, explorer, configInfo } = await createApp());
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

describe('API XCALL Endpoints', function () {

    it('GET /RBTC/api/xcalls/{block}/block: returns xcalls in a block', async function () {
        const res = await request.get('/RBTC/api/xcalls/10/block').expect(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(res.body.data).to.be.an('array').with.lengthOf(1);
        expect(res.body.data[0].call_id).to.equal(CALL_ID);
        expect(res.body.data[0].target_chain).to.equal('DOGE');
    });

    it('GET /RBTC/api/xcalls/{contract}/contract: returns xcalls emitted by a source contract', async function () {
        const res = await request.get('/RBTC/api/xcalls/11/contract').expect(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(res.body.data[0].call_id).to.equal(CALL_ID);
        expect(Number(res.body.data[0].contract_index)).to.equal(11);
    });

    it('GET /RBTC/api/xcalls/{status}/status: filters by request_status', async function () {
        const res = await request.get('/RBTC/api/xcalls/completed/status').expect(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(res.body.data[0].request_status).to.equal('completed');
    });

    it('GET /RBTC/api/xcalls: lists all xcalls', async function () {
        const res = await request.get('/RBTC/api/xcalls').expect(200);
        expect(Number(res.body.total)).to.be.at.least(1);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
    });

    it('GET /RBTC/api/xcall/{call_id}: returns the full lifecycle (request, execution, and callback)', async function () {
        const res = await request.get('/RBTC/api/xcall/' + CALL_ID).expect(200);
        expect(res.body).to.be.an('object');
        expect(res.body.call_id).to.equal(CALL_ID);
        expect(res.body.request_status).to.equal('completed');
        expect(res.body.method).to.equal('onArrival');
        // params_json parsed into an array
        expect(res.body.params).to.deep.equal(['x']);
        // target-chain execution outcome
        expect(res.body.execution).to.be.an('object');
        expect(res.body.execution.result_status).to.equal('ok');
        expect(Number(res.body.execution.gas_used)).to.equal(1000);
        // source-chain callback delivery
        expect(res.body.callback_delivery).to.be.an('object');
        expect(res.body.callback_delivery.callback_result_status).to.equal('ok');
    });

    it('GET /RBTC/api/xcall/{unknown}: returns 404 NOT_FOUND for an unknown call_id', async function () {
        // A single-resource lookup that resolves to nothing returns 404 (the
        // service-wide policy: HTTP status agrees with the NOT_FOUND body code;
        // a prior 400 made SDK consumers treat "does not exist" as malformed).
        const res = await request.get('/RBTC/api/xcall/' + 'f'.repeat(64));
        expect(res.status).to.equal(404);
        expect(res.body).to.be.an('object');
        expect(res.body.code).to.equal('NOT_FOUND');
    });
});
