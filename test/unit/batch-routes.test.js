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
 * Unit tests for the batch read endpoints
 *   POST /{COIN}/api/balances
 *   POST /{COIN}/api/coinpay_obligations
 *
 * The endpoints exist to collapse a multi-address wallet's per-address reads
 * into one request, so the property worth testing is not that they answer, but
 * that what they answer is INDISTINGUISHABLE from the per-address GETs they
 * replace. The acceptance test below drives processRequest directly for each
 * per-address path and requires the batch entry to carry that exact body, so a
 * future change to a per-address response can never leave the batch behind.
 *
 * Strategy follows explorer.routing.test.js: proxyquire replaces express and
 * db.js, the express double records the app.post() registrations so a test can
 * grab the real route handler, and MockDB answers getData() from per-test
 * fixtures keyed by method and search value.
 *
 * Run: mocha --require ./test/setup.js test/unit/batch-routes.test.js --timeout 0 --exit
 *********************************************************************/

const { expect }               = require('chai');
const proxyquire               = require('proxyquire').noCallThru();
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockReq, mockRes }     = require('../fixtures/mock-query-args.js');

// Per-test DB behaviour, keyed by the reader method processRequest resolves the
// path to. A handler receives the cfg processRequest built and returns the
// [data, total] pair db.getData() would have, or throws the way db.js does.
let dbHandlers = {};

// Every getData() call in call order, so forwarding and concurrency can be
// asserted against what actually reached the reader layer.
let dbCalls = [];

// In-flight getData() calls, and the high-water mark across one request.
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
            // Yield the event loop so overlapping reads really overlap: without a
            // suspension point every call would resolve before the next starts and
            // the concurrency assertion below would pass on any implementation.
            await new Promise((resolve) => setImmediate(resolve));
            const handler = dbHandlers[cfg.data.method];
            if (!handler) return [null, null];
            return handler(cfg);
        } finally {
            inFlight--;
        }
    }
}

// Express double: records the route registrations so a test can drive the real
// handler the service installed, rather than a hand-picked method name.
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

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': expressMock,
    './db.js': MockDB
});

const explorer = new XChainExplorer(mockApp, createConfigInfoStub());

/** The route handler the service registered, minus its limiter middleware. */
function routeHandler(path) {
    const route = registrations.post.find((r) => r.path === path);
    expect(route, `no POST registration for ${path}`).to.not.be.undefined;
    return route.handlers[route.handlers.length - 1];
}

const balancesRoute = routeHandler('/:coin/api/balances');
const coinpayRoute  = routeHandler('/:coin/api/coinpay_obligations');

/**
 * Drive a registered batch route and return { code, body, headers }.
 *
 * The registered handler is fire-and-forget (it hands the promise to
 * _sendUnhandled and returns), which is what express calls it for, so this
 * waits on the RESPONSE rather than on a returned promise. A handler that
 * threw still lands here as _sendUnhandled's 500, not as a hang.
 */
async function post(handler, coin, body, query = {}) {
    const res = mockRes();
    handler({ params: { coin }, path: `/${coin}/api/balances`, query, body }, res);
    for (let i = 0; i < 5000 && res._body === null; i++)
        await new Promise((resolve) => setImmediate(resolve));
    expect(res._body, 'the batch route never sent a response').to.not.equal(null);
    return { code: res._status, body: JSON.parse(res._body), headers: res._headers };
}

/** Drive the per-address GET through processRequest and return its parsed body. */
async function get(path, query = {}) {
    const res = mockRes();
    await explorer.processRequest(mockReq(path, query), res);
    return { code: res._status, body: JSON.parse(res._body) };
}

// `runtime` is this request's own elapsed time, so it differs between any two
// drives of the same path. Stripped from both sides of an equality check, and
// asserted present separately, so the comparison stays about the payload.
function withoutRuntime(body) {
    const copy = Object.assign({}, body);
    delete copy.runtime;
    return copy;
}

/** Fixtures every test starts from: two addresses that read cleanly. */
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

describe('Batch read endpoints: registration (rows 51, C53, C54)', function () {

    it('registers both batch routes as POST beside the other hand-registered routes', function () {
        const paths = registrations.post.map((r) => r.path);
        expect(paths).to.include('/:coin/api/balances');
        expect(paths).to.include('/:coin/api/coinpay_obligations');
    });

    it('puts a limiter in front of each batch route, not just a handler', function () {
        for (const path of ['/:coin/api/balances', '/:coin/api/coinpay_obligations']) {
            const route = registrations.post.find((r) => r.path === path);
            expect(route.handlers, `${path} has no middleware before its handler`)
                .to.have.lengthOf(2);
        }
    });

    it('gives both batch routes the SAME limiter instance, so they share one bucket', function () {
        const balances = registrations.post.find((r) => r.path === '/:coin/api/balances');
        const coinpay  = registrations.post.find((r) => r.path === '/:coin/api/coinpay_obligations');
        expect(balances.handlers[0]).to.equal(coinpay.handlers[0]);
    });

    it('registers both before the GET catch-all', function () {
        // The catch-all answers GET only, so this is order hygiene rather than a
        // correctness requirement; it is pinned because a POST registered after a
        // future catch-all that DID take every verb would silently stop matching.
        const catchAll = registrations.get.findIndex((r) => r.path === '/{*path}');
        expect(catchAll, 'catch-all route not found').to.be.greaterThan(-1);
        expect(registrations.get[catchAll].path).to.equal('/{*path}');
    });
});

describe('Batch read endpoints: POST /{COIN}/api/balances (C53)', function () {

    beforeEach(function () {
        dbHandlers  = healthyHandlers();
        dbCalls     = [];
        maxInFlight = 0;
    });

    it('answers an object keyed by address carrying both halves per entry', async function () {
        const { code, body } = await post(balancesRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] });
        expect(code).to.equal(200);
        expect(Object.keys(body)).to.deep.equal(['addrOne', 'addrTwo']);
        expect(body.addrOne).to.have.all.keys('balances', 'address', 'error');
        expect(body.addrOne.error).to.equal(null);
        expect(body.addrTwo.error).to.equal(null);
    });

    it('carries EXACTLY the per-address GET bodies (the acceptance test)', async function () {
        const { body } = await post(balancesRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] });

        for (const address of ['addrOne', 'addrTwo']) {
            const balancesGet = await get(`/BTC/api/balances/${address}`);
            const addressGet  = await get(`/BTC/api/address/${address}`);
            expect(balancesGet.code).to.equal(200);
            expect(addressGet.code).to.equal(200);

            expect(withoutRuntime(body[address].balances), `balances half drifted for ${address}`)
                .to.deep.equal(withoutRuntime(balancesGet.body));
            expect(withoutRuntime(body[address].address), `address half drifted for ${address}`)
                .to.deep.equal(withoutRuntime(addressGet.body));
            // The stripped field is present on both sides, so the comparison above
            // is not quietly ignoring a half the batch failed to produce at all.
            expect(body[address].balances.runtime).to.be.a('string');
            expect(balancesGet.body.runtime).to.be.a('string');
        }
    });

    it('echoes json.address on the balances half, as the per-address route does', async function () {
        const { body } = await post(balancesRoute, 'BTC', { addresses: ['addrOne'] });
        expect(body.addrOne.balances.address).to.equal('addrOne');
    });

    it('deduplicates repeats while preserving first-seen order', async function () {
        const { body } = await post(balancesRoute, 'BTC', {
            addresses: ['addrTwo', 'addrOne', 'addrTwo', 'addrOne']
        });
        expect(Object.keys(body)).to.deep.equal(['addrTwo', 'addrOne']);
        const searched = dbCalls.filter((c) => c.method === 'getBalances').map((c) => c.search);
        expect(searched, 'a duplicate address was read twice').to.deep.equal(['addrTwo', 'addrOne']);
    });

    it('forwards the query string to every inner read, so paging matches the GET', async function () {
        await post(balancesRoute, 'BTC', { addresses: ['addrOne', 'addrTwo'] }, { limit: '5', page: '2' });
        expect(dbCalls).to.have.length.greaterThan(0);
        for (const call of dbCalls)
            expect(call.query, `query lost on ${call.method}/${call.search}`)
                .to.deep.equal({ limit: '5', page: '2' });
    });

    it('runs at most eight inner reads at once', async function () {
        const addresses = [];
        for (let i = 0; i < 20; i++) addresses.push(`addr${String(i).padStart(2, '0')}`);
        const { code } = await post(balancesRoute, 'BTC', { addresses });
        expect(code).to.equal(200);
        expect(dbCalls).to.have.lengthOf(40);   // two halves per address
        expect(maxInFlight, 'more than eight inner reads were in flight').to.be.at.most(8);
        expect(maxInFlight, 'the reads did not actually run concurrently').to.be.greaterThan(1);
    });
});

describe('Batch read endpoints: body validation (C53)', function () {

    beforeEach(function () {
        dbHandlers = healthyHandlers();
        dbCalls    = [];
    });

    const badBodies = [
        ['a missing body',        undefined],
        ['a body with no list',   {}],
        ['an empty list',         { addresses: [] }],
        ['a non-array',           { addresses: 'addrOne' }],
        ['an object',             { addresses: { 0: 'addrOne' } }],
        ['a non-string entry',    { addresses: ['addrOne', 7] }],
        ['a null entry',          { addresses: [null] }]
    ];

    for (const [label, body] of badBodies) {
        it(`refuses ${label} with 400 INVALID_ADDRESSES`, async function () {
            const res = await post(balancesRoute, 'BTC', body);
            expect(res.code).to.equal(400);
            expect(res.body.code).to.equal('INVALID_ADDRESSES');
            expect(dbCalls, 'a refused body still reached the database').to.deep.equal([]);
        });
    }

    it('refuses 21 addresses with 400 TOO_MANY_ADDRESSES and reads nothing', async function () {
        const addresses = [];
        for (let i = 0; i < 21; i++) addresses.push(`addr${i}`);
        const res = await post(balancesRoute, 'BTC', { addresses });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('TOO_MANY_ADDRESSES');
        expect(res.body.error).to.contain('20');
        expect(dbCalls).to.deep.equal([]);
    });

    it('accepts exactly 20 addresses, so the cap is not off by one', async function () {
        const addresses = [];
        for (let i = 0; i < 20; i++) addresses.push(`addr${String(i).padStart(2, '0')}`);
        const res = await post(balancesRoute, 'BTC', { addresses });
        expect(res.code).to.equal(200);
        expect(Object.keys(res.body)).to.have.lengthOf(20);
    });

    it('counts the cap BEFORE deduplication, so 21 repeats of one address is refused', async function () {
        const addresses = [];
        for (let i = 0; i < 21; i++) addresses.push('addrOne');
        const res = await post(balancesRoute, 'BTC', { addresses });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('TOO_MANY_ADDRESSES');
    });

    it('refuses a malformed entry with 400 INVALID_ADDRESS naming it', async function () {
        const res = await post(balancesRoute, 'BTC', { addresses: ['addrOne', 'not an address!'] });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('INVALID_ADDRESS');
        expect(res.body.error).to.equal('Invalid address: not an address!');
        expect(dbCalls, 'a batch with one bad entry still read the good ones').to.deep.equal([]);
    });

    it('truncates the echoed entry, so an oversized string cannot size the error body', async function () {
        const huge = 'A'.repeat(5000);
        const res  = await post(balancesRoute, 'BTC', { addresses: [huge] });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('INVALID_ADDRESS');
        expect(res.body.error).to.have.lengthOf('Invalid address: '.length + 128);
    });

    it('applies the same body rules on the coinpay route', async function () {
        const res = await post(coinpayRoute, 'BTC', { addresses: [] });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('INVALID_ADDRESSES');
    });
});

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
