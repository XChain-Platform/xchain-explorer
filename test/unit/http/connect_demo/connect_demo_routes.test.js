/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { expect } = require('chai');
const {
    createConnectDemoStore,
    mountConnectDemoRoutes
} = require('../../../../src/http/connect_demo_routes.js');
const {
    applyRateLimits,
    connectDemoPolicyFor,
    isConnectDemoPath
} = require('../../../../src/http/api_boot/rate_limits.js');

const ID = 'Abcdefghijklmnopqrstu_';
const ID_2 = 'Bcdefghijklmnopqrstu_-';
const ROOT = path.join(__dirname, '../../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function buildApp(options = {}){
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json({ limit: '10kb' }));
    mountConnectDemoRoutes(app, options);
    return app;
}

describe('connect demo callback receiver', function () {
    it('registers an id, reports pending, accepts a callback, and returns it', async function () {
        let clock = 1000;
        const app = buildApp({ now: () => clock });

        const expected = await request(app)
            .post('/connect-demo/expect/' + ID)
            .set('X-Forwarded-For', '192.0.2.1')
            .send({});
        expect(expected.status).to.equal(201);
        expect(expected.body).to.deep.equal({ expected: true, exp: 601000 });

        const pending = await request(app).get('/connect-demo/result/' + ID);
        expect(pending.status).to.equal(202);
        expect(pending.body).to.deep.equal({ received: false });

        const body = { v: 1, id: ID, method: 'login', ok: true, result: { address: 'bc1qdemo' } };
        const accepted = await request(app).post('/connect-demo/callback/' + ID).send(body);
        expect(accepted.status).to.equal(202);
        expect(accepted.body).to.deep.equal({ received: true });

        clock = 2000;
        const result = await request(app).get('/connect-demo/result/' + ID);
        expect(result.status).to.equal(200);
        expect(result.body).to.deep.equal({ received: true, callbacks: [body], exp: 601000 });
    });

    it('refuses a reused id and does not replace its callbacks', async function () {
        const app = buildApp();
        await request(app).post('/connect-demo/expect/' + ID).send({}).expect(201);
        await request(app).post('/connect-demo/callback/' + ID).send({ sequence: 1 }).expect(202);

        const reused = await request(app).post('/connect-demo/expect/' + ID).send({});
        expect(reused.status).to.equal(409);
        expect(reused.body.code).to.equal('REQUEST_ID_REUSED');

        const result = await request(app).get('/connect-demo/result/' + ID);
        expect(result.body.callbacks).to.deep.equal([{ sequence: 1 }]);
    });

    it('refuses callbacks and polls for ids that were never expected', async function () {
        const app = buildApp();
        const callback = await request(app).post('/connect-demo/callback/' + ID).send({ ok: true });
        const result = await request(app).get('/connect-demo/result/' + ID);
        expect(callback.status).to.equal(404);
        expect(callback.body.code).to.equal('REQUEST_ID_NOT_FOUND');
        expect(result.status).to.equal(404);
        expect(result.body.code).to.equal('REQUEST_ID_NOT_FOUND');
    });
});

describe('connect demo callback store', function () {
    it('validates the closed 22-character base64url id form', async function () {
        const app = buildApp();
        for(const id of ['short', 'Abcdefghijklmnopqrstu+', 'Abcdefghijklmnopqrstuvw']){
            const response = await request(app).post('/connect-demo/expect/' + id).send({});
            expect(response.status, id).to.equal(400);
            expect(response.body.code, id).to.equal('INVALID_REQUEST_ID');
        }
    });

    it('expires entries ten minutes after expect and permits the id again', function () {
        let clock = 5000;
        const store = createConnectDemoStore({ now: () => clock });
        expect(store.expect(ID, '192.0.2.1')).to.deep.equal({ status: 'created', expiresAt: 605000 });

        clock = 604999;
        expect(store.result(ID)).to.deep.equal({ expiresAt: 605000, callbacks: [] });
        clock = 605000;
        expect(store.result(ID)).to.equal(null);
        expect(store.expect(ID, '192.0.2.1')).to.deep.equal({ status: 'created', expiresAt: 1205000 });
    });

    it('keeps only the three newest callbacks so the first sender cannot lock the result', function () {
        const store = createConnectDemoStore();
        store.expect(ID, '192.0.2.1');
        for(let sequence = 1; sequence <= 5; sequence++)
            store.callback(ID, { sequence });
        expect(store.result(ID).callbacks).to.deep.equal([
            { sequence: 3 }, { sequence: 4 }, { sequence: 5 }
        ]);
    });
});

describe('connect demo callback capacity', function () {
    it('caps live entries globally and separately for each client IP', function () {
        const global = createConnectDemoStore({ maxEntries: 1 });
        expect(global.expect(ID, '192.0.2.1').status).to.equal('created');
        expect(global.expect(ID_2, '192.0.2.2')).to.deep.equal({ status: 'full' });

        const perIp = createConnectDemoStore({ maxEntriesPerIp: 1 });
        expect(perIp.expect(ID, '192.0.2.1').status).to.equal('created');
        expect(perIp.expect(ID_2, '192.0.2.1')).to.deep.equal({ status: 'ip-full' });
        expect(perIp.expect(ID_2, '192.0.2.2').status).to.equal('created');
    });

    it('answers 503 when the live-entry cap is reached', async function () {
        const app = buildApp({ maxEntriesPerIp: 1 });
        await request(app)
            .post('/connect-demo/expect/' + ID)
            .set('X-Forwarded-For', '192.0.2.1')
            .send({})
            .expect(201);
        const full = await request(app)
            .post('/connect-demo/expect/' + ID_2)
            .set('X-Forwarded-For', '192.0.2.1')
            .send({});
        expect(full.status).to.equal(503);
        expect(full.body.code).to.equal('RECEIVER_FULL');
    });
});

describe('connect demo callback limiter and mount', function () {
    it('defines a dedicated per-IP limiter with a pinnable default and override', function () {
        const standard = connectDemoPolicyFor({ env: {} });
        const custom = connectDemoPolicyFor({ env: { EXPLORER_CONNECT_DEMO_RATE_LIMIT_RPM: '7' } });
        expect(standard.limit).to.equal(120);
        expect(standard.envVar).to.equal('EXPLORER_CONNECT_DEMO_RATE_LIMIT_RPM');
        expect(custom.limit).to.equal(7);
        expect(isConnectDemoPath({ path: '/connect-demo/result/' + ID })).to.equal(true);
        expect(isConnectDemoPath({ path: '/BTC/api/' })).to.equal(false);
    });

    it('enforces the dedicated limiter only on connect demo paths', async function () {
        const app = express();
        applyRateLimits(app, { env: {
            EXPLORER_RATE_LIMIT_RPM: '100',
            EXPLORER_STATIC_RATE_LIMIT_RPM: '100',
            EXPLORER_CONNECT_DEMO_RATE_LIMIT_RPM: '2',
            EXPLORER_MAX_CONCURRENT_REQUESTS: '0'
        } }, () => false);
        app.get('*path', (req, res) => res.json({ ok: true }));

        await request(app).get('/other').expect(200);
        await request(app).get('/connect-demo/one').expect(200);
        await request(app).get('/connect-demo/two').expect(200);
        const limited = await request(app).get('/connect-demo/three');
        expect(limited.status).to.equal(429);
        expect(limited.body.code).to.equal('RATE_LIMITED');
    });

    it('pins the limiter and mounts the receiver before the explorer wildcard routes', function () {
        const conf = read('deploy/rate-limits.conf');
        expect(conf).to.match(/^Environment=EXPLORER_CONNECT_DEMO_RATE_LIMIT_RPM=120$/m);

        const api = read('src/api.js');
        const receiverMount = api.indexOf('mountConnectDemoRoutes(app);');
        const explorerMount = api.indexOf('new XChainExplorer(app, appConfigInfo)');
        expect(receiverMount).to.be.greaterThan(-1);
        expect(receiverMount).to.be.lessThan(explorerMount);
    });
});
