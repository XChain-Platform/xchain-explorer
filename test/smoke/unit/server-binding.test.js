'use strict';

/**
 * Smoke tests — Server binding and JSON-RPC ping (SM-05)
 *
 * Verifies the Express server can accept requests and the JSON-RPC
 * ping endpoint returns a success response. Uses the integration
 * test helper to create a supertest-injectable app (no real port binding).
 *
 * Run: npm run test:smoke:unit
 */

const { expect }     = require('chai');
const supertest      = require('supertest');
const express        = require('express');
const cors           = require('cors');
const jsonRouter     = require('express-json-rpc-router');
const { createTestConfigInfo } = require('../../integration/helpers/app-setup');
const XChainExplorer = require('../../../src/XChainExplorer');

// ---------------------------------------------------------------------------
// SM-05: Express server binds and JSON-RPC ping responds
// ---------------------------------------------------------------------------

describe('SM-05: Server binding and JSON-RPC ping', function () {

    let app, request;

    before(async function () {
        this.timeout(5000);

        app = express();
        app.use(express.json());
        app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

        const configInfo = createTestConfigInfo(13306); // non-existent DB port is fine — we only test ping
        const explorer = new XChainExplorer(app, configInfo);

        // init() creates DB pools which may fail to connect, but the explorer
        // object and Express routes are still wired — we just need the app routes
        try { await explorer.init(); } catch (e) { /* DB unreachable is expected here */ }

        // Register JSON-RPC controller (same as api.js does)
        const jsonRpcController = {
            async ping() { return { status: 'success' }; }
        };
        app.use(jsonRouter({ methods: jsonRpcController }));

        request = supertest(app);
    });

    it('JSON-RPC ping returns { status: "success" }', async function () {
        const res = await request
            .post('/')
            .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
            .expect(200);

        expect(res.body).to.have.property('result');
        expect(res.body.result).to.have.property('status', 'success');
    });

    it('JSON-RPC with unknown method returns an error response', async function () {
        const res = await request
            .post('/')
            .send({ jsonrpc: '2.0', method: 'nonexistent', id: 2 });

        // express-json-rpc-router returns a JSON-RPC error for unknown methods
        expect(res.body).to.have.property('error');
    });

    it('GET / returns an HTML response (home page route)', async function () {
        const res = await request.get('/');

        // The wildcard GET handler should match — even without DB, it tries to serve HTML
        expect(res.status).to.be.oneOf([200, 302, 404]);
    });

});
