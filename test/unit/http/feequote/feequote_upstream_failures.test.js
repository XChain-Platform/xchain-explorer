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
 * The feequote proxy tells its caller whether the same request is worth
 * sending again. Only a transient upstream failure (a 429 or 503, a timeout,
 * a connection that got no answer) is marked retryable, and the indexer's
 * Retry-After is relayed when it named one, as the preflight and feeschedule
 * routes do. A refusal, an auth rejection or a JSON-RPC error verdict is
 * never marked retryable: re-sending it gets the same answer.
 */

'use strict';

const sinon = require('sinon');
const axios = require('axios');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');

function fakeThis() {
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'btc', network: 'regtest' }),
        util: { isNull: (v) => v === undefined || v === null || v === '' },
        feeQuoteWithBusyRetry: XChainExplorer.prototype.feeQuoteWithBusyRetry,
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

// An axios failure the way axios raises it: with the upstream response, or with
// only a transport code when no response arrived.
const httpFailure = (status, headers = {}) => Object.assign(new Error('Request failed with status code ' + status), {
    response: { status, headers },
});
const netFailure = (code, message) => Object.assign(new Error(message || code), { code });

async function feequote() {
    const res = headerRes();
    await XChainExplorer.prototype.processFeeQuoteRequest.call(fakeThis(),
        { params: { coin: 'RBTC' }, method: 'GET', query: { action: 'ISSUE', params: '0|NEWTICK', source: 'me' } }, res);
    return res;
}

async function oracleFeequote() {
    const res = headerRes();
    await XChainExplorer.prototype.processOracleFeeQuoteRequest.call(fakeThis(),
        { params: { coin: 'RBTC' }, query: { oracleAddress: 'addr', giveTick: 'XCH', fiatCode: 'USD' } }, res);
    return res;
}

describe('feequote upstream failures: transient ones are retryable', function () {
    beforeEach(() => {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        IndexerConnector.resetEgressBudgets();
    });
    afterEach(() => sinon.restore());

    it('relays an indexer 429 as retryable with its Retry-After', async function () {
        sinon.stub(axios, 'post').rejects(httpFailure(429, { 'retry-after': '7' }));
        const res = await feequote();
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        expect(res._headers['retry-after']).to.equal('7');
    });

    it('relays an indexer 503 as retryable with its Retry-After', async function () {
        sinon.stub(axios, 'post').rejects(httpFailure(503, { 'retry-after': '3' }));
        const res = await feequote();
        expect(res._json.retryable).to.equal(true);
        expect(res._headers['retry-after']).to.equal('3');
        const oracle = await oracleFeequote();
        expect(oracle._status).to.equal(502);
        expect(oracle._json).to.deep.equal({ error: 'oracle fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        expect(oracle._headers['retry-after']).to.equal('3');
    });

    it('marks a timeout and a refused connection retryable, with no Retry-After', async function () {
        const post = sinon.stub(axios, 'post');
        post.onFirstCall().rejects(netFailure('ECONNABORTED', 'timeout of 5000ms exceeded'));
        post.onSecondCall().rejects(netFailure('ECONNREFUSED'));
        for (let i = 0; i < 2; i++) {
            const res = await feequote();
            expect(res._json.retryable, 'call ' + i).to.equal(true);
            expect(res._headers).to.not.have.property('retry-after');
        }
    });

    // A stopped or restarting indexer container drops out of Docker DNS, so the
    // name stops resolving instead of the connection being refused.
    it('marks a host name that stopped resolving (stopped container) retryable', async function () {
        const msg = 'getaddrinfo ENOTFOUND xchain-node-litecoin-regtest-xchain-indexer';
        sinon.stub(axios, 'post').rejects(netFailure('ENOTFOUND', msg));
        const res = await feequote();
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        expect(res._headers).to.not.have.property('retry-after');
        const oracle = await oracleFeequote();
        expect(oracle._json).to.deep.equal({ error: 'oracle fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        let thrown = null;
        try { await new IndexerConnector('http://x:1').call('getfeequote', []); } catch (e) { thrown = e; }
        expect(thrown && thrown.retryable).to.equal(true);
    });
});

describe('feequote upstream failures: refusals and verdicts are not retryable', function () {
    beforeEach(() => {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        IndexerConnector.resetEgressBudgets();
    });
    afterEach(() => sinon.restore());

    const verdicts = {
        'a 400 refusal': () => httpFailure(400, { 'retry-after': '5' }),
        'an auth rejection (401)': () => httpFailure(401),
        'a 404': () => httpFailure(404),
    };
    for (const [name, failure] of Object.entries(verdicts)) {
        it(name + ' is a bare 502 with no retryable flag or Retry-After', async function () {
            sinon.stub(axios, 'post').rejects(failure());
            const res = await feequote();
            expect(res._status).to.equal(502);
            expect(res._json).to.deep.equal({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR' });
            expect(res._headers).to.not.have.property('retry-after');
            if(name === 'an auth rejection (401)'){
                const oracle = await oracleFeequote();
                expect(oracle._json).to.deep.equal({ error: 'oracle fee quote upstream error', code: 'UPSTREAM_ERROR' });
                expect(oracle._headers).to.not.have.property('retry-after');
            }
        });
    }

    it('a JSON-RPC error result is a bare 502 with no retryable flag', async function () {
        sinon.stub(axios, 'post').resolves({ data: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } } });
        const res = await feequote();
        expect(res._status).to.equal(502);
        expect(res._json).to.deep.equal({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR' });
    });
});
