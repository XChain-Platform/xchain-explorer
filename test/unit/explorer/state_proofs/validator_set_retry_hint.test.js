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
 **********************************************************************/

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');

function response() {
    return {
        _status: 200, _body: null, _headers: {},
        status(code) { this._status = code; return this; },
        json(body) { this._body = body; return this; },
        set(name, value) { this._headers[name] = String(value); return this; }
    };
}

async function routed(result) {
    const host = {
        db: { pools: { BTC: {} } },
        mirrorGate: () => ({ blocked: null }),
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'BTC', network: 'MAINNET' }),
        util: { isSafeIntegerParam: () => true },
        proofServer: { validatorSetProof: async () => result }
    };
    const res = response();
    await XChainExplorer.prototype.processValidatorSetProofRequest.call(host,
        { params: { coin: 'BTC' }, query: { height: '100' } }, res);
    return res;
}

describe('validator-set proof retry hints', function () {
    beforeEach(function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('configured');
    });
    afterEach(function () { sinon.restore(); });

    it('relays a transient indexer hint without changing status or code', async function () {
        const res = await routed({ error: 'INDEXER_UNAVAILABLE', retryable: true, retryAfter: 7 });
        expect(res._status).to.equal(502);
        expect(res._body).to.deep.equal({
            error: 'Indexer API unavailable for the stake set',
            code: 'INDEXER_UNAVAILABLE',
            retryable: true
        });
        expect(res._headers['Retry-After']).to.equal('7');
    });

    it('keeps auth and unmapped errors free of retry hints', async function () {
        const auth = await routed({ error: 'INDEXER_AUTH_REQUIRED', retryable: true, retryAfter: 7 });
        expect(auth._status).to.equal(503);
        expect(auth._body).to.not.have.property('retryable');
        expect(auth._headers).to.not.have.property('Retry-After');
        const unknown = await routed({ error: 'UNKNOWN_PROOF_ERROR', retryable: true, retryAfter: 7 });
        expect(unknown._status).to.equal(500);
        expect(unknown._body).to.deep.equal({ error: 'Server error', code: 'SERVER_ERROR' });
        expect(unknown._headers).to.not.have.property('Retry-After');
    });
});
