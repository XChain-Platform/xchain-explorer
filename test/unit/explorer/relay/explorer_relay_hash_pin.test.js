'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { createHash } = require('crypto');
const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { mockRes } = require('../../../fixtures/mock-query-args.js');
const { tokenInfo_metadataUrl } = require('../../../../src/content/js/xchain/token_info.js');

function makeExplorer(axiosStub, description) {
    const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
        axios: axiosStub,
        express: { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs: { existsSync: () => false },
        './db/index.js': function() { this.init = () => {}; },
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    const explorer = new XChainExplorer(app, createConfigInfoStub());
    explorer.db.pools = { TDOGE: {} };
    explorer.db.findTokenDescription = sinon.stub().resolves(description);
    return explorer;
}

function request(url) {
    return {
        path: '/relay', query: { url, coin: 'TDOGE', tick: 'PINNED' },
        headers: { host: 'localhost:8080' }, secure: false,
    };
}

const DESCRIPTION = ['metadata.invalid', 'pinned.json'].join('/');
const METADATA_URL = tokenInfo_metadataUrl(DESCRIPTION);

describe('XChainExplorer relay hash pins', function () {
    it('relays a hash-pinned document only when its exact bytes match', async function () {
        const body = Buffer.from('{"name":"PINNED"}');
        const hash = createHash('sha256').update(body).digest('hex');
        const axiosStub = { get: sinon.stub().resolves({ data: body }) };
        const explorer = makeExplorer(axiosStub, `${DESCRIPTION};${hash}`);
        const res = mockRes();
        await explorer.processRelayRequest(request(METADATA_URL), res);
        expect(axiosStub.get.firstCall.args[1]).to.have.property('responseType', 'arraybuffer');
        expect(res._body).to.include('PINNED');
    });

    it('refuses a hash-pinned document when its exact bytes mismatch', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: Buffer.from('{"name":"SWAPPED"}') }) };
        const explorer = makeExplorer(axiosStub, `${DESCRIPTION};${'00'.repeat(32)}`);
        const res = mockRes();
        await explorer.processRelayRequest(request(METADATA_URL), res);
        expect(res._status).to.equal(502);
        expect(res._body).to.deep.equal({
            error: 'Token metadata integrity mismatch', code: 'RELAY_HASH_MISMATCH',
        });
    });
});
