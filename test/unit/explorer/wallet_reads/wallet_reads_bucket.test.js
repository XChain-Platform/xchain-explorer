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
 * The wallet range reads (POST history, GET price_history, POST
 * native_history) are registered behind one limiter of their own, not the
 * balance beat's batch bucket, so paging a long history cannot exhaust the
 * budget a wallet's balance polling runs on. Driven against the real
 * express-rate-limit: spending the wallet bucket leaves POST /balances admitted.
 *
 *********************************************************************/

'use strict';

const { expect }   = require('chai');
const proxyquire   = require('proxyquire');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const ENV_KNOB = 'EXPLORER_WALLET_READS_RATE_LIMIT_RPM';

// Build an explorer with the real limiter library and return every registered
// route, keyed "VERB path", with its handler list.
function registeredRoutes(){
    const routes = new Map();
    const mockApp = {
        use: () => {}, enable: () => {},
        get:  (route, ...handlers) => { routes.set('GET ' + route, handlers); },
        post: (route, ...handlers) => { routes.set('POST ' + route, handlers); }
    };
    const expressMock  = () => mockApp;
    expressMock.static = () => {};
    expressMock.json   = () => {};
    class MockDB { async init() {} getMaxMethodResults() { return 100; } async getData() { return [null, null]; } }
    const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', { 'express': expressMock, './db/index.js': MockDB });
    new XChainExplorer(mockApp, createConfigInfoStub());
    return routes;
}

// Run one limiter middleware for a request from `ip`; true when it admitted it.
function admits(limiter, ip){
    return new Promise((resolve) => {
        const headers = {};
        const res = {
            statusCode: 200,
            setHeader: (k, v) => { headers[k] = v; }, getHeader: (k) => headers[k], append: () => {},
            status(code){ this.statusCode = code; return this; },
            json(){ resolve(false); return this; }, send(){ resolve(false); return this; },
            set(){ return this; }, header(){ return this; }, end(){ resolve(false); }
        };
        limiter({ ip, app: { get: () => false }, headers: {}, get: () => undefined }, res, () => resolve(true));
    });
}

describe('wallet range reads: their own rate bucket', function () {
    let previous, routes;

    before(() => {
        previous = process.env[ENV_KNOB];
        process.env[ENV_KNOB] = '2';
        routes = registeredRoutes();
    });
    after(() => {
        if(previous === undefined) delete process.env[ENV_KNOB];
        else process.env[ENV_KNOB] = previous;
    });

    it('registers all three behind one limiter that is not the batch limiter', () => {
        const history = routes.get('POST /:coin/api/history')[0];
        expect(routes.get('GET /:coin/api/price_history')[0]).to.equal(history);
        expect(routes.get('POST /:coin/api/native_history')[0]).to.equal(history);
        expect(routes.get('POST /:coin/api/balances')[0]).to.not.equal(history);
    });

    it('spending the wallet bucket leaves the balance batch admitted', async () => {
        const wallet  = routes.get('POST /:coin/api/history')[0];
        const batch   = routes.get('POST /:coin/api/balances')[0];
        const ip = '198.51.100.23';
        expect(await admits(wallet, ip)).to.equal(true);
        expect(await admits(wallet, ip)).to.equal(true);
        expect(await admits(wallet, ip), 'third wallet read inside the knob of 2').to.equal(false);
        expect(await admits(batch, ip)).to.equal(true);
    });
});
