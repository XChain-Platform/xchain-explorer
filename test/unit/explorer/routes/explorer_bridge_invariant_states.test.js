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
 * The bridge-invariant route's answer for each hub state. Only a hub that is
 * configured and failing is a 503; an explorer with no hub, or a hub build
 * without getbridgeinvariant, answers 200 { available: false, reason } so a
 * token page logs no error, and the hub's own empty answer passes through.
 ********************************************************************/

'use strict';

const http       = require('http');
const express    = require('express');
const request    = require('supertest');
const sinon      = require('sinon');
const { expect } = require('chai');
const XChainHubConnector = require('../../../../src/connectors/hub.js');
const { mountBridgePanelRoutes, bridgeHubEndpoints } = require('../../../../src/http/bridge_panel_routes.js');

function buildApp(hub){
    const app = express();
    mountBridgePanelRoutes(app, () => ({ db: {} }), hub);
    app.get('/{*path}', (_req, res) => res.status(404).type('html').send('<main>404 page</main>'));
    return app;
}

// A stub hub whose call() reports per-call diagnostics on `out` the way the
// real connector does, then resolves to `result`.
function hubAnswering(result, out){
    return { call: sinon.spy(async (_data, opts) => {
        if(opts && opts.out) Object.assign(opts.out, { rpcError: null, failures: [], allEndpointsAnswered: false }, out);
        return result;
    }) };
}

// A one-route JSON-RPC server on an ephemeral port, answering every POST with `body`.
function rpcServer(body){
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('explorer bridge-invariant route: hub states', function(){
    it('answers 200 available:false when no hub is configured', async function(){
        const res = await request(buildApp(null)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ available: false, reason: 'HUB_NOT_CONFIGURED' });
    });

    it('answers 200 available:false when every hub endpoint lacks the method', async function(){
        const hub = hubAnswering(null, { allEndpointsAnswered: true, rpcError: { code: -32601, message: 'Method not found' } });
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ available: false, reason: 'HUB_METHOD_MISSING' });
    });

    it('keeps 503 when only some endpoints lack the method and the rest are down', async function(){
        const hub = hubAnswering(null, { allEndpointsAnswered: false, rpcError: { code: -32601 } });
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(503);
        expect(res.body.code).to.equal('BRIDGE_INVARIANT_UNAVAILABLE');
    });

    it('keeps 503 for a configured hub that is unreachable', async function(){
        const hub = hubAnswering(null, { failures: ['http://hub -> ECONNREFUSED'] });
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(503);
        expect(res.type).to.equal('application/json');
    });

    it('keeps 503 for a configured hub that answers a different RPC error', async function(){
        const hub = hubAnswering(null, { allEndpointsAnswered: true, rpcError: { code: -32603, message: 'db down' } });
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(503);
    });

    it('keeps 503 for a degraded health body served in place of a result', async function(){
        const hub = hubAnswering({ status: 'degraded', db: false });
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(503);
    });

    it('passes the hub empty answer for an unbridged tick through as 200 {}', async function(){
        const hub = hubAnswering({});
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/ZZZZZZZZZZZZ');
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({});
    });

    it('asks once and hands the connector a call-scoped diagnostics sink', async function(){
        const hub = hubAnswering({});
        await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        const opts = hub.call.firstCall.args[1];
        expect(opts.attempts).to.equal(1);
        expect(opts.out).to.be.an('object');
    });
});

describe('explorer bridge-invariant route: real connector against a hub', function(){
    let server = null;
    afterEach(function(){ if(server) server.close(); server = null; });

    it('maps a live -32601 answer to HUB_METHOD_MISSING', async function(){
        server = await rpcServer({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: 1 });
        const hub = new XChainHubConnector(['http://127.0.0.1:' + server.address().port]);
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.reason).to.equal('HUB_METHOD_MISSING');
    });

    it('serves a live result unchanged', async function(){
        const result = { XCHAIN: { LTC: { escrow: '0', supply: '0', in_flight: '0', delta: '0', finalized_policy_seq: null } } };
        server = await rpcServer({ jsonrpc: '2.0', result, id: 1 });
        const hub = new XChainHubConnector(['http://127.0.0.1:' + server.address().port]);
        const res = await request(buildApp(hub)).get('/BTC/api/bridge-invariant/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal(result);
    });
});

describe('explorer bridge-invariant route: hub endpoint choice', function(){
    it('prefers the configured hub endpoints', function(){
        expect(bridgeHubEndpoints(['http://a:10000'], { HUB_URL: 'http://b:10000' })).to.deep.equal(['http://a:10000']);
    });

    it('falls back to HUB_URL when config comes from the local file (NO_HUB)', function(){
        expect(bridgeHubEndpoints(null, { HUB_URL: 'http://127.0.0.1:10000' })).to.deep.equal(['http://127.0.0.1:10000']);
    });

    it('answers null with neither, or with a HUB_URL that is not an http URL', function(){
        expect(bridgeHubEndpoints(null, {})).to.equal(null);
        expect(bridgeHubEndpoints(null, { HUB_URL: 'hub:10000' })).to.equal(null);
        expect(bridgeHubEndpoints([], undefined)).to.equal(null);
    });
});
