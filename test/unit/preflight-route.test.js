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
        // The upstream verdict passes through verbatim, fee included : the
        // proxy must not filter fields the confirm screen reads.
        sinon.stub(IndexerConnector.prototype, 'preflight').resolves({ supported: true, valid: true, status: 'valid', xchainFee: '0.50000000' });
        const res = await call(fakeThis(), { action: 'SEND', params: '0|JDOG|1|addr', source: 'me' });
        expect(res._status).to.equal(200);
        expect(res._json).to.deep.equal({ supported: true, valid: true, status: 'valid', xchainFee: '0.50000000' });
    });

    // : the verdict depends on how the fee settles, so the mode has to survive the proxy.
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

// The published contract, not the implementation. The generator gave every
// pre-wildcard route the paginated-list treatment, so preflight shipped
// documented as taking page/limit/sortorder and returning {total, data} when it
// in fact takes `action` and returns one verdict object. These assertions pin
// the corrected entry against a silent regression on the next regeneration.
describe('preflight OpenAPI contract ', function () {
    const spec = require('../../docs/openapi.json');
    const op = spec.paths['/{COIN}/api/preflight'].get;
    const names = op.parameters.map((p) => p.name).filter(Boolean);

    it('documents the query parameters the route actually reads', function () {
        expect(names).to.have.members(['action', 'params', 'source', 'feeMode']);
        const feeMode = op.parameters.find((p) => p.name === 'feeMode');
        expect(feeMode.required).to.equal(false);
        expect(feeMode.schema.enum).to.have.members(['xchain', 'native']);
        const action = op.parameters.find((p) => p.name === 'action');
        expect(action.required).to.equal(true);
        expect(action.in).to.equal('query');
        // The pattern must be the one the route enforces, or a client that obeys
        // the spec still gets a 400 INVALID_ACTION.
        expect(new RegExp(action.schema.pattern).test('SEND')).to.equal(true);
        expect(new RegExp(action.schema.pattern).test('send;drop')).to.equal(false);
    });

    it('does not advertise pagination it ignores', function () {
        const refs = op.parameters.map((p) => p.$ref).filter(Boolean);
        expect(refs).to.not.include('#/components/parameters/page');
        expect(refs).to.not.include('#/components/parameters/limit');
        expect(refs).to.not.include('#/components/parameters/sortorder');
    });

    it('returns a verdict object, not a list envelope', function () {
        const schema = op.responses['200'].content['application/json'].schema;
        expect(schema.$ref).to.equal('#/components/schemas/PreflightResponse');
        const verdict = spec.components.schemas.PreflightResponse;
        expect(verdict.type).to.equal('object');
        // `valid` is nullable on purpose: no verdict is a distinct answer from invalid.
        expect(verdict.properties.valid.type).to.deep.equal(['boolean', 'null']);
        for (const field of ['supported', 'guardInert', 'denied', 'feeExempt', 'busy', 'cached', 'status'])
            expect(verdict.properties, field).to.have.property(field);
        // : the fee the dry-run already computed is part of the published
        // contract, so a client can disclose it without a second /feequote call.
        expect(verdict.properties).to.have.property('xchainFee');
        expect(verdict.properties.xchainFee.type).to.deep.equal(['string', 'null']);
        // : the fee is only judged truthfully if the caller knows which mode it was
        // judged under, and the payer balance is what makes an XCHAIN-mode refusal actionable.
        for (const field of ['feeMode', 'feeTick', 'feeTokenBalance', 'feeAffordable'])
            expect(verdict.properties, field).to.have.property(field);
        expect(verdict.properties.feeTokenBalance.type).to.deep.equal(['string', 'null']);
        expect(verdict.properties.feeAffordable.type).to.deep.equal(['boolean', 'null']);
    });

    it('declares the status codes the route emits, and only those', function () {
        expect(Object.keys(op.responses).sort()).to.deep.equal(['200', '400', '404', '501', '502']);
    });
});
