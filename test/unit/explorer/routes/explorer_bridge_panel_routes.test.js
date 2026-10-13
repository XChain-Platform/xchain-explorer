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
const request    = require('supertest');
const sinon      = require('sinon');
const { expect } = require('chai');
const { mountBridgePanelRoutes } = require('../../../../src/http/bridge_panel_routes.js');

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
            tick: 'FUFU', copyTick: 'BTC.FUFU', chain: 'DOGE', limit: 100
        });
    });

});

describe('explorer applied-policy panel route', function(){
    it('serves the latest applied policy from the routed coin mirror', async function(){
        const payload = {
            policy_seq: '7', origin_block: '1200', policy_hash: 'a'.repeat(64),
            allow_list_action_index: '41', block_list_action_index: null, sleeping: 0
        };
        const calls = [];
        const db = {
            checkpointDb: {
                DOGE: { name: 'hub_mirror', chain: 'DOGE', network: 'mainnet' }
            },
            async getAppliedPolicy(query){ calls.push(query); return payload; }
        };

        const res = await request(buildApp(db, null)).get('/DOGE/api/applied-policy/BTC.FUFU');

        expect(res.status).to.equal(200);
        expect(res.type).to.equal('application/json');
        expect(res.body).to.deep.equal(payload);
        expect(calls).to.deep.equal([{
            coin: 'DOGE', schema: 'hub_mirror', network: 'mainnet',
            origin: 'BTC', tick: 'FUFU', copyTick: 'BTC.FUFU'
        }]);
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

    it('answers HEAD for every path as a JSON route, never as the 404 page', async function(){
        const db = {
            checkpointDb: { BTC: { name: 'mirror', chain: 'BTC', network: 'regtest' } },
            getBridgeTransfers: async () => [],
            getAppliedPolicy: async () => null
        };
        const hub = { call: async () => ({ FUFU: {} }) };
        const app = buildApp(db, hub);

        for(const path of ['/BTC/api/bridge-invariant/FUFU', '/BTC/api/bridge-transfers/FUFU',
            '/BTC/api/applied-policy/DOGE.FUFU']){
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
        const policy = await request(app).get('/BTC/api/applied-policy/DOGE.FUFU');

        expect(invariant.status).to.equal(503);
        expect(invariant.type).to.equal('application/json');
        expect(invariant.body.code).to.equal('BRIDGE_INVARIANT_UNAVAILABLE');
        expect(transfers.status).to.equal(503);
        expect(transfers.type).to.equal('application/json');
        expect(transfers.body.code).to.equal('BRIDGE_TRANSFERS_UNAVAILABLE');
        expect(policy.status).to.equal(503);
        expect(policy.type).to.equal('application/json');
        expect(policy.body.code).to.equal('APPLIED_POLICY_UNAVAILABLE');
    });
});
