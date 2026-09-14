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

const { expect }               = require('chai');
const proxyquire               = require('proxyquire').noCallThru();
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../../../fixtures/mock-query-args.js');

let dbHandlers = {};

let dbCalls = [];

let inFlight    = 0;
let maxInFlight = 0;

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData(cfg) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        dbCalls.push({
            method: cfg.data.method,
            search: cfg.data.search,
            type:   cfg.data.type,
            path:   cfg.data.path,
            query:  Object.assign({}, cfg.data.query)
        });
        try {
            await new Promise((resolve) => setImmediate(resolve));
            const handler = dbHandlers[cfg.data.method];
            if (!handler) return [null, null];
            return handler(cfg);
        } finally {
            inFlight--;
        }
    }
}

const registrations = { get: [], post: [] };
const mockApp = {
    use:    () => {},
    enable: () => {},
    get:    (path, ...handlers) => { registrations.get.push({ path, handlers }); },
    post:   (path, ...handlers) => { registrations.post.push({ path, handlers }); }
};
const expressMock  = () => mockApp;
expressMock.static = () => {};
expressMock.json   = () => {};

const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
    'express': expressMock,
    './db/index.js': MockDB
});

const explorer = new XChainExplorer(mockApp, createConfigInfoStub());

function routeHandler(path) {
    const route = registrations.post.find((r) => r.path === path);
    expect(route, `no POST registration for ${path}`).to.not.be.undefined;
    return route.handlers[route.handlers.length - 1];
}

const balancesRoute = routeHandler('/:coin/api/balances');
const coinpayRoute  = routeHandler('/:coin/api/coinpay_obligations');

async function post(handler, coin, body, query = {}) {
    const res = mockRes();
    handler({ params: { coin }, path: `/${coin}/api/balances`, query, body }, res);
    for (let i = 0; i < 5000 && res._body === null; i++)
        await new Promise((resolve) => setImmediate(resolve));
    expect(res._body, 'the batch route never sent a response').to.not.equal(null);
    return { code: res._status, body: JSON.parse(res._body), headers: res._headers };
}

async function get(path, query = {}) {
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query), res);
    return { code: res._status, body: JSON.parse(res._body) };
}

function withoutRuntime(body) {
    const copy = Object.assign({}, body);
    delete copy.runtime;
    return copy;
}

function healthyHandlers() {
    return {
        getBalances: (cfg) => [{
            balances: [{ tick: 'XCP', amount: cfg.data.search === 'addrOne' ? '100' : '250' }]
        }, null],
        getAddress: (cfg) => [{
            address: cfg.data.search,
            balance: cfg.data.search === 'addrOne' ? '1.5' : '9.25'
        }, null],
        getCoinpayObligations: (cfg) => [[{
            block_index:    100,
            payer_address:  cfg.data.search,
            coin_amount:    '5.0',
            coinpay_status: 'pending',
            action_index:   7
        }], 1]
    };
}

describe('Batch read endpoints: per-entry degradation (C53)', function () {

    beforeEach(function () {
        dbHandlers = healthyHandlers();
        dbCalls    = [];
    });

    it('nulls only the half that failed and attaches its own body as the error', async function () {
        const failing = dbHandlers.getAddress;
        dbHandlers.getAddress = (cfg) => {
            if (cfg.data.search === 'addrTwo') throw new Error('connection lost');
            return failing(cfg);
        };

        const { code, body } = await post(balancesRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] });
        expect(code).to.equal(200);
        expect(body.addrOne.error).to.equal(null);
        expect(body.addrOne.address).to.not.equal(null);

        expect(body.addrTwo.address).to.equal(null);
        expect(body.addrTwo.balances, 'the healthy half was lost with the failing one').to.not.equal(null);
        expect(body.addrTwo.error).to.deep.equal({
            code:   'DB_ERROR',
            error:  'A database error occurred while serving this request.',
            status: 500
        });
    });

    it('reports the balances failure when both halves fail, balances taking precedence', async function () {
        dbHandlers.getBalances = () => {
            const err = new Error('Invalid address');
            err.name  = 'DbInputError';
            err.code  = 'INVALID_PARAMETER';
            throw err;
        };
        dbHandlers.getAddress = () => { throw new Error('connection lost'); };

        const { body } = await post(balancesRoute, 'BTC', { addresses: ['addrOne'] });
        expect(body.addrOne.balances).to.equal(null);
        expect(body.addrOne.address).to.equal(null);
        expect(body.addrOne.error.status).to.equal(400);
        expect(body.addrOne.error.code).to.equal('INVALID_PARAMETER');
    });

    it('keeps a 404 on one address from refusing the whole batch', async function () {
        dbHandlers.getCoinpayObligations = (cfg) => (cfg.data.search === 'addrTwo' ? [null, null] : [[], 0]);
        const { code, body } = await post(coinpayRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] });
        expect(code).to.equal(200);
        expect(body.addrOne.coinpay_obligations).to.not.equal(null);
        expect(body.addrOne.error).to.equal(null);
        expect(body.addrTwo.coinpay_obligations).to.equal(null);
        expect(body.addrTwo.error).to.deep.equal({
            code:   'NOT_FOUND',
            error:  'The requested resource was not found.',
            status: 404
        });
    });
});

describe('Batch read endpoints: coin gate propagation (C53)', function () {

    beforeEach(function () {
        dbHandlers = healthyHandlers();
        dbCalls    = [];
    });

    // LTC is in COIN_SUPPORTED but not COIN_AVAILABLE in the fixture config, which
    // is the shape processRequest answers with a COIN_NOT_AVAILABLE 503.
    it('answers the batch with the 503 and its body when the coin gate refuses', async function () {
        const { code, body } = await post(balancesRoute, 'LTC', { addresses: ['addrOne', 'addrTwo'] });
        expect(code).to.equal(503);
        expect(body.code).to.equal('COIN_NOT_AVAILABLE');
        expect(body).to.not.have.property('addrOne');
    });

    it('sends the same 503 body the per-address GET sends', async function () {
        const { body }  = await post(balancesRoute, 'LTC', { addresses: ['addrOne'] });
        const perAddress = await get('/LTC/api/balances/addrOne');
        expect(perAddress.code).to.equal(503);
        expect(withoutRuntime(body)).to.deep.equal(withoutRuntime(perAddress.body));
    });

    it('stops after the first read rather than repeating the refusal per address', async function () {
        await post(balancesRoute, 'LTC', { addresses: ['addrOne', 'addrTwo'] });
        // The gate is decided before getData is reached, so nothing should have run
        // at all; what matters is that the batch did not fan out behind a refusal.
        expect(dbCalls).to.deep.equal([]);
    });

    it('propagates the gate on the coinpay route too', async function () {
        const { code, body } = await post(coinpayRoute, 'LTC', { addresses: ['addrOne'] });
        expect(code).to.equal(503);
        expect(body.code).to.equal('COIN_NOT_AVAILABLE');
    });
});

describe('Batch read endpoints: POST /{COIN}/api/coinpay_obligations (C54)', function () {

    beforeEach(function () {
        dbHandlers  = healthyHandlers();
        dbCalls     = [];
        maxInFlight = 0;
    });

    it('answers one coinpay_obligations half per address, keyed by address', async function () {
        const { code, body } = await post(coinpayRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] });
        expect(code).to.equal(200);
        expect(Object.keys(body)).to.deep.equal(['addrOne', 'addrTwo']);
        expect(body.addrOne).to.have.all.keys('coinpay_obligations', 'error');
        expect(body.addrOne.error).to.equal(null);
    });

    it('carries EXACTLY the per-address GET body (the acceptance test)', async function () {
        const { body } = await post(coinpayRoute, 'BTC', { addresses: ['addrOne'] });
        const perAddress = await get('/BTC/api/coinpay_obligations/addrOne/address');
        expect(perAddress.code).to.equal(200);
        expect(withoutRuntime(body.addrOne.coinpay_obligations))
            .to.deep.equal(withoutRuntime(perAddress.body));
        expect(perAddress.body.total).to.equal(1);
    });

    it('reads the /address/ type route, not the bare list route', async function () {
        await post(coinpayRoute, 'BTC', { addresses: ['addrOne'] });
        const call = dbCalls.find((c) => c.method === 'getCoinpayObligations');
        expect(call.type).to.equal('address');
        expect(call.search).to.equal('addrOne');
    });

    it('sets the JSON content type the per-address routes use', async function () {
        const { headers } = await post(coinpayRoute, 'BTC', { addresses: ['addrOne'] });
        expect(headers['Content-Type']).to.equal('application/json; charset=utf-8');
    });
});
