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
 * An indexer per-IP 429 is a transient "slow down", not an outage. The
 * explorer's connector tags it and the preflight and feeschedule proxies
 * answer it with the structured retryable signal (as the feequote route
 * does) plus Retry-After, so a caller can tell it from a dead upstream.
 */

'use strict';

const sinon = require('sinon');
const axios = require('axios');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');

// The route methods touch only configInfo, parseCoinCode and util.isNull before the connector.
function fakeThis() {
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'btc', network: 'regtest' }),
        util: { isNull: (v) => v === undefined || v === null || v === '' },
    };
}

function headerRes() {
    return {
        _status: 200, _json: null, _headers: {},
        status(c) { this._status = c; return this; },
        json(o) { this._json = o; return this; },
        set(k, v) { this._headers[String(k).toLowerCase()] = String(v); return this; },
    };
}

const throttled = (retryAfter) => Object.assign(new Error('Request failed with status code 429'), {
    response: { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
});

async function preflight(res) {
    await XChainExplorer.prototype.processPreflightRequest.call(fakeThis(), { params: { coin: 'RBTC' }, query: { action: 'SEND' } }, res);
    return res;
}

describe('indexer connector: 429 tagging', function () {
    afterEach(() => sinon.restore());

    it('tags a 429 with its Retry-After and leaves other errors alone', async function () {
        const stub = sinon.stub(axios, 'post');
        const c = new IndexerConnector('http://x:1');
        stub.rejects(throttled('60'));
        let err = null;
        try { await c.call('preflight', {}); } catch (e) { err = e; }
        expect(err.code).to.equal('INDEXER_RATE_LIMITED');
        expect(err.retryAfter).to.equal(60);
        const plain = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
        stub.rejects(plain);
        err = null;
        try { await c.call('preflight', {}); } catch (e) { err = e; }
        expect(err).to.equal(plain);
    });
});

describe('indexer 429 through the preflight and feeschedule proxies', function () {
    beforeEach(() => sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1'));
    afterEach(() => sinon.restore());

    it('preflight answers a 429 as retryable with Retry-After, not a bare 502', async function () {
        sinon.stub(axios, 'post').rejects(throttled('60'));
        const res = await preflight(headerRes());
        expect(res._status).to.equal(502);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
        expect(res._json.retryable).to.equal(true);
        expect(res._headers['retry-after']).to.equal('60');
    });

    it('feeschedule answers a 429 as retryable with Retry-After', async function () {
        sinon.stub(axios, 'post').rejects(throttled('60'));
        const res = headerRes();
        await XChainExplorer.prototype.processFeeScheduleRequest.call(fakeThis(), { params: { coin: 'RBTC' }, query: {} }, res);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
        expect(res._json.retryable).to.equal(true);
        expect(res._headers['retry-after']).to.equal('60');
    });

    it('a 429 without a usable Retry-After is still retryable and sets no header', async function () {
        sinon.stub(axios, 'post').rejects(throttled('soon'));
        const res = await preflight(headerRes());
        expect(res._json.retryable).to.equal(true);
        expect(res._headers).to.not.have.property('retry-after');
    });

    it('control: a refusal verdict keeps the plain 502 UPSTREAM_ERROR shape', async function () {
        sinon.stub(axios, 'post').rejects(Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400, headers: { 'retry-after': '5' } },
        }));
        const res = await preflight(headerRes());
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'pre-flight upstream error', code: 'UPSTREAM_ERROR' });
        expect(res._headers).to.not.have.property('retry-after');
    });

    it('a refused connection is transient: retryable, with no Retry-After', async function () {
        sinon.stub(axios, 'post').rejects(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
        const res = await preflight(headerRes());
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'pre-flight upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        expect(res._headers).to.not.have.property('retry-after');
    });

    it('control: the feequote route keeps its retryable 502', async function () {
        sinon.stub(axios, 'post').rejects(throttled('60'));
        const res = headerRes();
        const ctx = Object.assign(fakeThis(), { feeQuoteWithBusyRetry: XChainExplorer.prototype.feeQuoteWithBusyRetry });
        await XChainExplorer.prototype.processFeeQuoteRequest.call(ctx, { params: { coin: 'RBTC' }, method: 'GET', query: { action: 'SEND' } }, res);
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
    });
});
