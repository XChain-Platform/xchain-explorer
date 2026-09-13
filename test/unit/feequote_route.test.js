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
 * The indexer time-boxes its wait for the block-processing
 * transaction mutex and answers `busy: true, retryable: true` rather
 * than queueing behind a whole block. This hop absorbs that answer:
 * the wallet reads /feequote on every fee-bearing compose with no
 * retry of its own, so a busy answer forwarded verbatim refuses the
 * compose exactly the way the 502 it replaced did.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../src/XChainExplorer.js');
const IndexerConnector = require('../../src/XChainIndexerConnector.js');

function fakeThis({ coin = { coin: 'btc', network: 'regtest' } } = {}) {
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => coin,
        util: { isNull: (v) => v === undefined || v === null || v === '' },
        feeQuoteWithBusyRetry: XChainExplorer.prototype.feeQuoteWithBusyRetry,
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
    await XChainExplorer.prototype.processFeeQuoteRequest.call(ctx, req, res);
    return res;
}

const BUSY = { supported: true, action: 'ISSUE', valid: false, busy: true, retryable: true, retryAfterMs: 2000, error: 'fee quote busy (the indexer is processing a block ...); retry shortly' };
const QUOTE = { supported: true, action: 'ISSUE', valid: true, requiredFeeSats: 2000 };

describe('processFeeQuoteRequest busy-retry', function () {
    // Keep the budget tiny so the retry loop is a unit test, not a wait.
    let prevBudget;
    beforeEach(() => { prevBudget = process.env.EXPLORER_FEEQUOTE_BUSY_RETRY_MS; process.env.EXPLORER_FEEQUOTE_BUSY_RETRY_MS = '900'; });
    afterEach(() => {
        if (prevBudget === undefined) delete process.env.EXPLORER_FEEQUOTE_BUSY_RETRY_MS;
        else process.env.EXPLORER_FEEQUOTE_BUSY_RETRY_MS = prevBudget;
        sinon.restore();
    });

    it('retries past a busy answer and returns the quote the wallet was blocked on', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote');
        stub.onCall(0).resolves(BUSY);
        stub.onCall(1).resolves(BUSY);
        stub.onCall(2).resolves(QUOTE);
        const res = await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(res._status).to.equal(200);
        expect(res._json).to.deep.equal(QUOTE);
        expect(stub.callCount).to.equal(3);
    });

    it('never re-asks a real verdict: one hop, answered verbatim', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        // A quote the venue genuinely cannot price (stale oracle) is a verdict, not a stall.
        const invalid = { supported: true, valid: false, error: 'no current oracle price for BTC/USD' };
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves(invalid);
        const res = await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(res._json).to.deep.equal(invalid);
        expect(stub.callCount).to.equal(1);
    });

    it('a valid quote is returned on the first hop', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves(QUOTE);
        const res = await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(res._json).to.deep.equal(QUOTE);
        expect(stub.callCount).to.equal(1);
    });

    it('gives up inside the budget and answers busy rather than holding the request open', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves(BUSY);
        const started = Date.now();
        const res = await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        const elapsed = Date.now() - started;
        expect(res._status).to.equal(200);
        expect(res._json.busy).to.equal(true);
        expect(res._json.retryable).to.equal(true);
        expect(elapsed).to.be.below(5000, 'bounded by EXPLORER_FEEQUOTE_BUSY_RETRY_MS');
        expect(stub.callCount).to.be.above(1, 'it did retry');
    });

    // A busy answer that is NOT flagged retryable is somebody else's contract; do not loop on it.
    it('does not retry a busy answer that is not marked retryable', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves({ busy: true, valid: false });
        await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(stub.callCount).to.equal(1);
    });

    it('a transport failure is still a 502, now flagged retryable', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        sinon.stub(IndexerConnector.prototype, 'feequote').rejects(new Error('timeout of 5000ms exceeded'));
        const res = await call(fakeThis(), { action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(res._status).to.equal(502);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
        expect(res._json.retryable).to.equal(true);
    });

    it('input validation still runs before any hop', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves(QUOTE);
        const res = await call(fakeThis(), { action: 'send;drop' });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_ACTION');
        expect(stub.callCount).to.equal(0);
    });
});
