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
 **********************************************************************
 * Unit tests for XChainExplorer.processPreflightRequest : the
 * input-validation + proxy shape of the public /{COIN}/api/preflight
 * route, exercised without a DB by calling the method on a minimal
 * `this` and asserting the mock res. Mirrors the sibling
 * processFeeQuoteRequest hardening.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../src/XChainExplorer.js');
const IndexerConnector = require('../../src/XChainIndexerConnector.js');

// A minimal `this` for the route method: configInfo, parseCoinCode,
// and util.isNull are all it touches before the connector.
function fakeThis({ coin = { coin: 'btc', network: 'regtest' } } = {}) {
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => coin,
        util: { isNull: (v) => v === undefined || v === null || v === '' },
    };
}

function mockRes() {
    return {
        _status: 200, _json: null,
        status(c) { this._status = c; return this; },
        json(o) { this._json = o; return this; },
    };
}

async function call(ctx, query, params = { coin: 'RBTC' }) {
    const req = { params, query };
    const res = mockRes();
    await XChainExplorer.prototype.processPreflightRequest.call(ctx, req, res);
    return res;
}

describe('processPreflightRequest ( route)', function () {
    afterEach(() => sinon.restore());

    it('404 on unknown coin', async function () {
        const res = await call(fakeThis({ coin: null }), { action: 'SEND' });
        expect(res._status).to.equal(404);
        expect(res._json.code).to.equal('UNKNOWN_COIN');
    });

    it('501 when the indexer URL is not configured', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns(null);
        const res = await call(fakeThis(), { action: 'SEND' });
        expect(res._status).to.equal(501);
        expect(res._json.code).to.equal('INDEXER_NOT_CONFIGURED');
    });

    it('400 when action is missing', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), {});
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('MISSING_PARAMETER');
    });

    it('400 on repeated query parameters', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: ['SEND', 'MINT'] });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('400 on a bad action charset', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: 'send;drop' });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_ACTION');
    });

    it('400 when params exceed the length cap', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: 'SEND', params: 'x'.repeat(8193) });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('proxies a valid request to the connector and returns its result', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true, status: 'valid' });
        const res = await call(fakeThis(), { action: 'SEND', params: '0|JDOG|1|addr', source: 'me' });
        expect(res._status).to.equal(200);
        expect(res._json).to.deep.equal({ supported: true, valid: true, status: 'valid' });
    });

    it('502 when the upstream connector throws', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        sinon.stub(IndexerConnector.prototype, 'preflight').rejects(new Error('down'));
        const res = await call(fakeThis(), { action: 'SEND' });
        expect(res._status).to.equal(502);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
    });
});
