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
 * The params ceiling is in UTF-8 bytes, the unit the protocol bounds. A
 * multibyte params that is short in UTF-16 units but over the byte ceiling
 * is refused here with a 400, never forwarded to the indexer.
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

function mkRes() {
    return {
        _status: 200, _json: null,
        status(c) { this._status = c; return this; },
        json(o) { this._json = o; return this; },
        set() { return this; },
    };
}

async function run(method, req) {
    const res = mkRes();
    await XChainExplorer.prototype[method].call(fakeThis(), Object.assign({ params: { coin: 'RBTC' } }, req), res);
    return res;
}

describe('preflight and feequote params ceiling counts UTF-8 bytes', function () {
    let post;
    beforeEach(() => {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        post = sinon.stub(axios, 'post').resolves({ data: { ok: true }, status: 200, headers: {} });
    });
    afterEach(() => sinon.restore());

    const emoji = '\u{1F600}'.repeat(195000); // 390000 UTF-16 units, 780000 bytes

    it('POST preflight refuses oversize multibyte params itself', async function () {
        const res = await run('processPreflightRequest', { method: 'POST', body: { action: 'MESSAGE', params: emoji } });
        expect(res._status).to.equal(400);
        expect(res._json.code).to.equal('INVALID_PARAMETER');
        expect(res._json.error).to.equal('parameter too long');
        expect(post.callCount).to.equal(0);
    });

    it('POST feequote refuses oversize multibyte params itself', async function () {
        const res = await run('processFeeQuoteRequest', { method: 'POST', body: { action: 'MESSAGE', params: emoji } });
        expect(res._status).to.equal(400);
        expect(res._json.error).to.equal('parameter too long');
        expect(post.callCount).to.equal(0);
    });

    it('GET feequote refuses params over 8192 bytes though under 8192 chars', async function () {
        const params = '\u{1F600}'.repeat(3000); // 6000 units, 12000 bytes
        const res = await run('processFeeQuoteRequest', { method: 'GET', query: { action: 'MESSAGE', params } });
        expect(res._status).to.equal(400);
        expect(res._json.error).to.equal('parameter too long');
        expect(post.callCount).to.equal(0);
    });

    it('control: ASCII params at the exact byte ceiling still reach the connector', async function () {
        const { MAX_PREFLIGHT_PARAMS_LENGTH } = require('../../../../src/explorer/fees_preflight.js');
        const params = 'a'.repeat(MAX_PREFLIGHT_PARAMS_LENGTH);
        const res = await run('processPreflightRequest', { method: 'POST', body: { action: 'MESSAGE', params } });
        expect(res._status).to.not.equal(400);
        expect(post.callCount).to.be.greaterThan(0);
        const over = await run('processPreflightRequest', { method: 'POST', body: { action: 'MESSAGE', params: params + 'a' } });
        expect(over._status).to.equal(400);
    });
});
