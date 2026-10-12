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
 * Unit tests for URL matching and cfg construction in XChainExplorer.processRequest()
 *
 * Strategy: proxyquire replaces express and db/index.js so the class can be instantiated
 * without a real database or HTTP server.  A MockDB captures the cfg object passed
 * to getData(), letting each test inspect what processRequest() built from the URL.
 */

const { expect, mockReq, mockRes, makeExplorer, request, state } = require('./helpers.js');

let explorer;
before(function () { explorer = state.explorer; });

// The gate only runs for a coin this instance actually has a pool for; the
// staleness verdict itself is unit-tested against the real query in
// db.data-methods.test.js, so stub it here and assert the routing effect.
function withTip(stale, failClosed) {
    const e = makeExplorer();
    e.db.pools = { BTC: {} };
    e.db.isCoinTipStale   = async () => stale;
    e.db.getCoinFreshness = async () => ({
        stale, tip_block: 850, tip_age_seconds: stale ? 99999 : 5, replica_halted: false
    });
    e.db.staleFailClosed  = () => !!failClosed;
    return e;
}

describe('tip-freshness gate', function () {
    // A stale tip is SERVED and marked, never refused: the rows are a true
    // record up to the tip this instance holds, and refusing them made every
    // indexer stall present as the network being down. The mock db holds no
    // rows, so the read lands on the 404 NOT_FOUND path; what matters is that
    // it is not the 503, and that the marker rides on whatever was answered.
    it('serves a data read from a stale tip and marks it, rather than refusing it', async function () {
        const res = mockRes();
        await withTip(true).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
        expect(res._status).to.not.equal(503);
        expect(res._headers['XChain-Freshness']).to.equal('stale');
        expect(res._headers['XChain-Tip-Block']).to.equal('850');
        expect(res._headers['XChain-Tip-Age-S']).to.equal('99999');
        const body = JSON.parse(res._body);
        expect(body.code).to.not.equal('COIN_DATA_STALE');
        expect(body.freshness).to.deep.equal({ stale: true, tip_block: 850, tip_age_seconds: 99999, replica_halted: false });
    });

    it('marks a fresh read live in the headers and leaves the body without a freshness field', async function () {
        const res = mockRes();
        await withTip(false).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
        expect(res._headers['XChain-Freshness']).to.equal('live');
        expect(JSON.parse(res._body)).to.not.have.property('freshness');
    });

    it('keeps the 503 COIN_DATA_STALE refusal behind the EXPLORER_STALE_FAIL_CLOSED opt-in', async function () {
        const res = mockRes();
        await withTip(true, true).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
        expect(res._status).to.equal(503);
        expect(JSON.parse(res._body)).to.include({ code: 'COIN_DATA_STALE' });
        expect(res._headers).to.not.have.property('XChain-Freshness');
    });

    it('keeps /{COIN}/api/status reachable so an operator can see WHY it went stale', async function () {
        const res = mockRes();
        await withTip(true).processRequest(mockReq('/BTC/api/status'), res);
        expect(res._status).to.not.equal(503);
    });

    it('serves normally when the tip is fresh', async function () {
        const res = mockRes();
        await withTip(false).processRequest(mockReq('/BTC/api/sends/addr1/address'), res);
        expect(res._status).to.not.equal(503);
    });
});

describe('tip-freshness gate', function () {
    it('keeps the unconfigured-coin 503 distinguishable from the stale one', async function () {
        const res = mockRes();
        await withTip(true).processRequest(mockReq('/LTC/api/sends/addr1/address'), res);
        expect(res._status).to.equal(503);
        expect(JSON.parse(res._body)).to.include({ code: 'COIN_NOT_AVAILABLE' });   // LTC has no pool here
    });

});

describe('tip-freshness gate: contract simulation', function () {

    // POST /{COIN}/api/contract/{idx}/call is hand-registered ahead of the
    // catch-all, so it never ran processRequest's gate above and answered a
    // current-state question from a frozen replica's contract state.
    function withTip(stale, failClosed) {
        const e = makeExplorer();
        e.db.pools = { RBTC: {} };
        e.db.isCoinTipStale  = async () => stale;
        e.db.staleFailClosed = () => !!failClosed;
        return e;
    }

    function callReq() {
        return { params: { coin: 'RBTC', contractIndex: '40' }, body: { method: 'get' }, ip: '127.0.0.1' };
    }

    it('serves the simulation past a stale tip and marks the answer stale', async function () {
        const res = mockRes();
        await withTip(true).processContractCallRequest(callReq(), res);
        // The VM is not wired in this unit harness, so the call fails past the
        // marker; what matters is that a stale tip is not what stopped it.
        expect(res._body && res._body.code).to.not.equal('COIN_DATA_STALE');
        expect(res._headers['XChain-Freshness']).to.equal('stale');
    });

    it('keeps the 503 refusal behind the EXPLORER_STALE_FAIL_CLOSED opt-in', async function () {
        const res = mockRes();
        await withTip(true, true).processContractCallRequest(callReq(), res);
        expect(res._status).to.equal(503);
        expect(res._body).to.include({ code: 'COIN_DATA_STALE' });
    });

    it('does not gate the simulation when the tip is fresh', async function () {
        const res = mockRes();
        await withTip(false).processContractCallRequest(callReq(), res);
        // The VM is not wired in this unit harness, so the call fails past the
        // gate; what matters is that the freshness gate is not what stopped it.
        expect(res._body && res._body.code).to.not.equal('COIN_DATA_STALE');
    });

    it('rejects a malformed contract index before consulting the tip', async function () {
        const e = withTip(true);
        let consulted = false;
        e.db.isCoinTipStale = async () => { consulted = true; return true; };
        const res = mockRes();
        await e.processContractCallRequest(
            { params: { coin: 'RBTC', contractIndex: 'not-a-number' }, body: {}, ip: '127.0.0.1' }, res);
        expect(res._status).to.equal(400);
        expect(consulted, 'shape errors stay 400, not 503').to.equal(false);
    });

});
