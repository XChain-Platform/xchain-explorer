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
 * Unit tests for XChainExplorer.processPreflightRequest: the
 * input-validation + proxy shape of the public /{COIN}/api/preflight
 * route, exercised without a DB by calling the method on a minimal
 * `this` and asserting the mock res. Mirrors the sibling
 * processFeeQuoteRequest hardening.
 */

'use strict';

const { srcText } = require('../helpers/source_text');

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../src/XChainExplorer.js');
const IndexerConnector = require('../../src/connectors/indexer.js');
const { batchParams } = require('./preflight_route.test/support/helpers.js');

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

// The POST transport of the same endpoint: identical inputs, carried in a JSON body.
async function post(ctx, body, params = { coin: 'RBTC' }) {
    const req = { params, method: 'POST', body, query: {} };
    const res = mockRes();
    await XChainExplorer.prototype.processPreflightRequest.call(ctx, req, res);
    return res;
}

describe('processPreflightRequest', function () {
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
        const res = await call(fakeThis(), { action: 'SEND', params: 'x'.repeat(XChainExplorer.MAX_PREFLIGHT_PARAMS_LENGTH + 1) });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('accepts params exactly at the cap (the boundary is inclusive)', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true });
        const res = await call(fakeThis(), { action: 'SEND', params: 'x'.repeat(XChainExplorer.MAX_PREFLIGHT_PARAMS_LENGTH) });
        expect(res._status).to.equal(200);
        expect(stub.calledOnce).to.equal(true);
    });

});

describe('processPreflightRequest', function () {
    afterEach(() => sinon.restore());

    it('400 when source exceeds its own cap (raising params did not unbound source)', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: 'SEND', params: '0|JDOG|1|addr', source: 'x'.repeat(4097) });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('proxies a valid request to the connector and returns its result', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        // The upstream verdict passes through verbatim, fee included: the proxy
        // must not filter fields the confirm screen reads.
        sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true, status: 'valid', xchainFee: '0.50000000' });
        const res = await call(fakeThis(), { action: 'SEND', params: '0|JDOG|1|addr', source: 'me' });
        expect(res._status).to.equal(200);
        expect(res._json).to.deep.equal({ supported: true, valid: true, status: 'valid', xchainFee: '0.50000000' });
    });

    // The verdict depends on how the fee settles, so the mode has to survive the proxy.
    it('passes feeMode through, lower-cased', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: false });
        await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me', feeMode: 'NATIVE' });
        expect(stub.firstCall.args[0].feeMode).to.equal('native');
    });

    it('omits feeMode when the caller did not send one (the indexer picks the chain default)', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true });
        await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK' });
        expect(stub.firstCall.args[0].feeMode).to.equal(undefined);
    });

    it('400 on an unknown feeMode rather than silently answering the wrong question', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: 'ISSUE', feeMode: 'creditcard' });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('400 on a repeated feeMode', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await call(fakeThis(), { action: 'ISSUE', feeMode: ['xchain', 'native'] });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    it('502 when the upstream connector throws', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        sinon.stub(IndexerConnector.prototype, 'preflight').rejects(new Error('down'));
        const res = await call(fakeThis(), { action: 'SEND' });
        expect(res._status).to.equal(502);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
    });
});

// The regression this cap change exists for: the endpoint used to refuse, on LENGTH,
// exactly the batches the BATCH issuance rework shipped to make possible. A 250-command
// batch is the consensus maximum, and it is the one a client is most likely to want a
// verdict on, because it is the one whose sub-commands are most likely to diverge.
describe('processPreflightRequest: a 250-command BATCH', function () {
    afterEach(() => sinon.restore());

    // Guards the premise. If a realistic 250-command batch ever fits in 8192 characters
    // the rest of this block is testing nothing, and this says so instead of passing.
    it('is longer than the old 8192-character ceiling (the premise of the fix)', function () {
        expect(batchParams(250).length).to.be.greaterThan(8192);
    });

    it('reaches the connector over POST instead of being rejected on length', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({
            supported: true, valid: true, status: 'valid',
            subCommands: [{ position: 0, action: 'ISSUE', status: 'valid', refused: null }],
        });
        const params = batchParams(250);
        const res = await post(fakeThis(), { action: 'BATCH', params, source: 'me' });
        expect(res._status).to.equal(200);
        // The whole string reaches the arbiter: a proxy that truncated would be worse
        // than one that refused, because the verdict would be about a different batch.
        expect(stub.firstCall.args[0].params).to.equal(params);
        expect(stub.firstCall.args[0].action).to.equal('BATCH');
    });

    it('returns the per-sub-command verdicts verbatim, which is what a composer reads', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        // Sub-commands are NOT atomic, so a batch-level valid:true alongside a rejected
        // sub-command is a normal answer, not a contradiction. The proxy must not
        // reconcile them or drop the list.
        const subCommands = [
            { position: 0, action: 'ISSUE', status: 'valid', refused: null },
            { position: 1, action: 'ISSUE', status: 'invalid: TICK (exists)', refused: null },
            { position: 2, action: 'ISSUE', status: null, refused: null },
        ];
        sinon.stub(IndexerConnector.prototype, 'preflight').resolves({
            supported: true, valid: true, status: 'valid', subCommands,
            oracleFeesOwed: { mvOracleAddressExample: '0.00100000' },
        });
        const res = await post(fakeThis(), { action: 'BATCH', params: batchParams(250) });
        expect(res._status).to.equal(200);
        expect(res._json.subCommands).to.deep.equal(subCommands);
        expect(res._json.oracleFeesOwed).to.deep.equal({ mvOracleAddressExample: '0.00100000' });
    });

    // The cap is what changed, so pin it on the transport that used to enforce it too:
    // the GET handler no longer refuses this input either. In practice a GET this size
    // dies at the HTTP layer with a 431 long before the handler runs, which is precisely
    // why the POST exists; that is a transport limit, not a policy one.
    it('is no longer refused by the GET handler either (the cap, not the transport, was the bug)', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true });
        const res = await call(fakeThis(), { action: 'BATCH', params: batchParams(250) });
        expect(res._status).to.equal(200);
        expect(stub.calledOnce).to.equal(true);
    });
});

describe('processPreflightRequest: the POST transport', function () {
    afterEach(() => sinon.restore());

    it('reads the body and ignores the query string on a POST', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true });
        const req = { params: { coin: 'RBTC' }, method: 'POST',
            body: { action: 'SEND', params: '0|JDOG|1|addr' },
            query: { action: 'ISSUE', params: '0|OTHER' } };
        const res = mockRes();
        await XChainExplorer.prototype.processPreflightRequest.call(fakeThis(), req, res);
        expect(res._status).to.equal(200);
        expect(stub.firstCall.args[0].action).to.equal('SEND');
        expect(stub.firstCall.args[0].params).to.equal('0|JDOG|1|addr');
    });

    it('400 rather than crashing when a POST carries no parsed body at all', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const req = { params: { coin: 'RBTC' }, method: 'POST', body: undefined, query: {} };
        const res = mockRes();
        await XChainExplorer.prototype.processPreflightRequest.call(fakeThis(), req, res);
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('MISSING_PARAMETER');
    });

    it('applies the same feeMode validation as the GET', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await post(fakeThis(), { action: 'ISSUE', feeMode: 'creditcard' });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

});

describe('processPreflightRequest: the POST transport', function () {
    afterEach(() => sinon.restore());

    it('400 on an array-valued body field, exactly as on a repeated query parameter', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await post(fakeThis(), { action: 'SEND', params: ['a', 'b'] });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });

    // A JSON body can carry types a query string cannot. String()-ing them would forward
    // "[object Object]" or "42" to the arbiter and return a verdict on something the
    // caller never sent, so they are refused by name instead.
    it('400 on a non-string body field rather than stringifying it', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true });
        for (const body of [
            { action: 'SEND', params: { nested: 1 } },
            { action: 'SEND', params: 42 },
            { action: 'SEND', source: { a: 1 } },
            { action: 'SEND', feeMode: 7 },
        ]) {
            const res = await post(fakeThis(), body);
            expect(res._status, JSON.stringify(body)).to.equal(400);
            expect(res._json.code).to.equal('INVALID_PARAMETER');
        }
        expect(stub.called, 'nothing reached the indexer').to.equal(false);
    });

    it('400 on a non-string action rather than stringifying it', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const res = await post(fakeThis(), { action: { toString: () => 'SEND' } });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
    });
});

// api.js applies a deliberately tight 10kb json() to the whole app. That parser would
// 413 a legal 250-command BATCH before the route's own parser ever ran, so exactly one
// request is routed around it. The predicate is exported from the module that owns the
// route so the two cannot drift; these pin what it does and does not exempt.
describe('isPreflightPostRequest', function () {
    const yes = (method, path) => XChainExplorer.isPreflightPostRequest({ method, path });

    it('exempts POST /{coin}/api/preflight', function () {
        expect(yes('POST', '/RBTC/api/preflight')).to.equal(true);
        expect(yes('post', '/BTC/api/preflight')).to.equal(true);
        expect(yes('POST', '/RBTC/api/preflight/')).to.equal(true);
    });

    it('exempts nothing else: not the GET, not another route, not a prefix match', function () {
        expect(yes('GET', '/RBTC/api/preflight')).to.equal(false);
        expect(yes('POST', '/RBTC/api/feequote')).to.equal(false);
        expect(yes('POST', '/RBTC/api/contract/1/call')).to.equal(false);
        expect(yes('POST', '/RBTC/api/preflightish')).to.equal(false);
        expect(yes('POST', '/a/RBTC/api/preflight')).to.equal(false);
        expect(yes('POST', '/RBTC/api/preflight/extra')).to.equal(false);
    });

    it('is total over malformed input (it runs on every request)', function () {
        expect(XChainExplorer.isPreflightPostRequest(null)).to.equal(false);
        expect(XChainExplorer.isPreflightPostRequest({})).to.equal(false);
        expect(XChainExplorer.isPreflightPostRequest({ method: 'POST' })).to.equal(false);
    });
});

// Source-level pins, in the idiom of test/unit/openapi-coverage.test.js: the wiring
// above is only reachable if the route is actually registered and api.js actually
// skips the global parser for it.
describe('preflight POST wiring', function () {
    const fs = require('fs');
    const path = require('path');
    const SRC = srcText('src/XChainExplorer.js');
    const API = srcText('src/api.js');

    it('registers the POST route with its own body parser', function () {
        expect(SRC).to.match(/app\.post\('\/:coin\/api\/preflight'/);
        expect(SRC).to.match(/express\.json\(\{\s*limit:\s*PREFLIGHT_BODY_LIMIT\s*\}\)/);
    });

    it('routes the global 10kb parser around that one request', function () {
        expect(API).to.match(/isPreflightPostRequest\(req\)/);
        expect(API).to.match(/express\.json\(\{\s*limit:\s*'10kb'\s*\}\)/);
    });
});

require('./preflight_route.test/support/openapi_contract.js');
