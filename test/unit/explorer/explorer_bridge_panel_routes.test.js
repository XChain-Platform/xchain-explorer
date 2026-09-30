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
 **********************************************************************/

'use strict';

const express    = require('express');
const proxyquire = require('proxyquire');
const request    = require('supertest');
const sinon      = require('sinon');
const { expect } = require('chai');

function loadRouteMount(){
    const appStub = {
        use(){}, get(){}, post(){}, set(){}, disable(){}
    };
    const serverStub = { on(){ return this; }, listen(_port, cb){ if(cb) cb(); return this; } };
    class ExplorerStub {
        constructor(){ this.db = { pools: {} }; }
        async init(){}
        static getSlowRequests(){ return 0; }
        static getLatencyStats(){ return {}; }
    }
    class HubStub {
        static parseEndpoints(){ return null; }
    }
    const noop = () => {};
    const api = proxyquire.noCallThru().load('../../../src/api.js', {
        dotenv: { config: noop },
        http: { createServer: () => serverStub },
        express: Object.assign(() => appStub, { json: () => noop }),
        './XChainExplorer.js': ExplorerStub,
        './config.js': {
            env: {}, getConfig: async () => ({}), startSync: noop,
            stopSync: noop, onConfigChanged: noop
        },
        './contract/vm_query.js': { isEnabled: () => false, consensusFault: () => null },
        './http/static_mounts.js': { isStaticAsset: () => false },
        './http/shutdown.js': {
            createExplorerDrain: () => noop,
            createShutdown: () => noop
        },
        './observability': {
            patchConsole: noop,
            getLogger: () => ({ info: noop, warn: noop, error: noop })
        },
        './coins': { NETWORKS: [], ALLOWED_COINS: ['BTC', 'LTC', 'DOGE'], verifyConsensusPin: noop },
        './connectors/hub': HubStub,
        './federation': { buildFederationRpc: () => ({}) },
        './http/api_boot/security_headers.js': { applySecurityHeaders: noop, applyProxyTrust: noop },
        './http/api_boot/cors.js': { applyCors: noop },
        './http/api_boot/rate_limits.js': {
            applyRateLimits: () => ({ getStats: () => ({}) })
        },
        './http/api_boot/observability.js': { applyObservability: noop },
        './http/api_boot/tls.js': { startTlsListener: noop },
        './http/api_boot/json_rpc.js': { mountJsonRpc: noop },
        './http/api_boot/websocket.js': { startWebsockets: noop }
    });
    return api.mountBridgePanelRoutes;
}

const mountBridgePanelRoutes = loadRouteMount();

function buildApp(db, hub){
    const app = express();
    mountBridgePanelRoutes(app, () => ({ db }), hub);
    app.get('/{*path}', (_req, res) => res.status(404).type('html').send('<main>404 page</main>'));
    return app;
}

describe('explorer bridge panel routes', function(){
    it('serves bridge-invariant JSON from the hub instead of the HTML fallback', async function(){
        const hubPayload = { FUFU: { DOGE: { escrow: '4', supply: '4', delta: '0' } } };
        const pagePayload = { 'BTC.FUFU': hubPayload.FUFU };
        const calls = [];
        const hub = {
            async call(body, options){ calls.push({ body, options }); return hubPayload; }
        };
        const app = buildApp({}, hub);

        const res = await request(app).get('/DOGE/api/bridge-invariant/BTC.FUFU');
        expect(res.status).to.equal(200);
        expect(res.type).to.equal('application/json');
        expect(res.body).to.deep.equal(pagePayload);
        expect(calls).to.deep.equal([{
            body: { jsonrpc: '2.0', method: 'getbridgeinvariant', params: { tick: 'FUFU' }, id: 1 },
            options: { attempts: 1 }
        }]);
    });

    it('serves bridge-transfers JSON from the routed coin mirror', async function(){
        const payload = [{ transfer_id: 'a'.repeat(64), src_chain: 'BTC', dest_chain: 'DOGE', amount: '2.5' }];
        const calls = [];
        const db = {
            checkpointDb: {
                DOGE: { name: 'hub_mirror', chain: 'DOGE', network: 'mainnet' }
            },
            async getBridgeTransfers(query){ calls.push(query); return payload; }
        };
        const app = buildApp(db, null);

        const res = await request(app).get('/DOGE/api/bridge-transfers/BTC.FUFU');
        expect(res.status).to.equal(200);
        expect(res.type).to.equal('application/json');
        expect(res.body).to.deep.equal(payload);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]).to.deep.equal({
            coin: 'DOGE', schema: 'hub_mirror', network: 'mainnet',
            tick: 'FUFU', chain: 'DOGE', limit: 100
        });
    });

});

describe('explorer bridge panel routes, HEAD and failures', function(){
    it('rejects suffix aliases without calling the hub', async function(){
        const hub = { call: sinon.stub().resolves({ FUFU: {} }) };
        const app = buildApp({}, hub);

        const res = await request(app).get('/EVILBTC/api/bridge-invariant/FUFU');

        expect(res.status).to.equal(404);
        expect(res.body.code).to.equal('UNKNOWN_COIN');
        expect(hub.call.called).to.equal(false);
    });

    it('accepts an exact network-prefixed namespace', async function(){
        const hub = { call: sinon.stub().resolves({ FUFU: {} }) };
        const res = await request(buildApp({}, hub)).get('/TBTC/api/bridge-invariant/FUFU');
        expect(res.status).to.equal(200);
        expect(hub.call.calledOnce).to.equal(true);
    });

    it('answers HEAD for both paths as JSON routes, never as the 404 page', async function(){
        const db = {
            checkpointDb: { BTC: { name: 'mirror', chain: 'BTC', network: 'regtest' } },
            getBridgeTransfers: async () => []
        };
        const hub = { call: async () => ({ FUFU: {} }) };
        const app = buildApp(db, hub);

        for(const path of ['/BTC/api/bridge-invariant/FUFU', '/BTC/api/bridge-transfers/FUFU']){
            const res = await request(app).head(path);
            expect(res.status, path).to.equal(200);
            expect(res.type, path).to.equal('application/json');
            expect(res.text, path).to.equal(undefined);
        }
    });

    it('fails unavailable sources as JSON without falling through to HTML', async function(){
        const app = buildApp({}, null);
        const invariant = await request(app).get('/BTC/api/bridge-invariant/FUFU');
        const transfers = await request(app).get('/BTC/api/bridge-transfers/FUFU');

        expect(invariant.status).to.equal(503);
        expect(invariant.type).to.equal('application/json');
        expect(invariant.body.code).to.equal('BRIDGE_INVARIANT_UNAVAILABLE');
        expect(transfers.status).to.equal(503);
        expect(transfers.type).to.equal('application/json');
        expect(transfers.body.code).to.equal('BRIDGE_TRANSFERS_UNAVAILABLE');
    });
});
