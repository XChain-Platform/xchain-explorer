'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const path       = require('path');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal XChainExplorer instance with the given axios stub.
 * proxyquire.noCallThru() is NOT used globally so that internal helpers
 * (utility, path, etc.) are real; only the listed modules are replaced.
 */
function makeExplorer(axiosStub) {
    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
        axios:    axiosStub,
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       { existsSync: () => false },
        './db.js': function() { this.init = () => {}; }
    });

    const configInfo = createConfigInfoStub();
    const app = {
        get:    () => {},
        post:   () => {},
        use:    () => {},
        listen: () => {}
    };
    return new XChainExplorer(app, configInfo);
}

// Build a minimal mock req for the relay handler
function makeRelayReq(url) {
    return {
        path:    '/relay',
        query:   url !== undefined ? { url } : {},
        headers: { host: 'localhost:8080' },
        secure:  false
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XChainExplorer#processRelayRequest', function () {

    // -----------------------------------------------------------------------
    // No url param → 503
    // -----------------------------------------------------------------------

    it('returns 503 when no url query parameter is provided', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq(undefined);
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(503);
        expect(res._body).to.deep.equal({ error: 'service not available' });
    });

    // -----------------------------------------------------------------------
    // Valid JSON url → fetches and returns JSON
    // -----------------------------------------------------------------------

    it('fetches a .json URL and returns re-serialized JSON', async function () {
        const payload = { tick: 'XCHAIN', supply: '1000000' };
        const axiosStub = {
            get: sinon.stub().resolves({ data: payload })
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(axiosStub.get.calledOnce).to.be.true;
        expect(axiosStub.get.firstCall.args[0]).to.equal('https://example.com/token.json');
        expect(res._type).to.equal('json');
        // body should be a JSON string containing the payload fields
        expect(res._body).to.include('XCHAIN');
    });

    // -----------------------------------------------------------------------
    // Valid PNG url → fetches and returns base64
    // -----------------------------------------------------------------------

    it('fetches a .png URL and returns a base64-encoded string', async function () {
        // Simulate a minimal 1x1 PNG as a buffer (just needs to be non-empty bytes)
        const fakeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const axiosStub = {
            get: sinon.stub().resolves({ data: fakeBuffer.buffer.slice(fakeBuffer.byteOffset, fakeBuffer.byteOffset + fakeBuffer.byteLength) })
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/logo.png');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(axiosStub.get.calledOnce).to.be.true;
        // responseType arraybuffer should have been requested
        expect(axiosStub.get.firstCall.args[1]).to.have.property('responseType', 'arraybuffer');
        // Response body should be a non-empty base64 string
        expect(res._body).to.be.a('string').and.have.length.above(0);
    });

    // -----------------------------------------------------------------------
    // Invalid protocol (ftp:) → 400
    // -----------------------------------------------------------------------

    it('returns 400 for an ftp: protocol URL', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('ftp://example.com/file.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid protocol' });
    });

    // -----------------------------------------------------------------------
    // Private IPs → 403
    // -----------------------------------------------------------------------

    it('returns 403 for 127.0.0.1 (loopback)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://127.0.0.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    it('returns 403 for 10.x.x.x (private class A)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://10.0.0.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    it('returns 403 for 192.168.x.x (private class C)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://192.168.1.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    it('returns 403 for localhost', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://localhost/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    it('returns 403 for IPv6 loopback ::1', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://[::1]/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    it('returns 403 for fc00: IPv6 ULA', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://[fc00::1]/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted' });
    });

    // -----------------------------------------------------------------------
    // Network error → 400
    // -----------------------------------------------------------------------

    it('returns 400 when axios throws a network error', async function () {
        const axiosStub = {
            get: sinon.stub().rejects(new Error('ECONNREFUSED'))
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid or unreachable URL' });
    });

    // -----------------------------------------------------------------------
    // Unsupported extension (.html) → 503
    // -----------------------------------------------------------------------

    it('returns 503 for an unsupported file extension (.html)', async function () {
        const axiosStub = { get: sinon.stub() };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/page.html');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        // axios.get should never be called for unsupported extensions
        expect(axiosStub.get.called).to.be.false;
        expect(res._status).to.equal(503);
        expect(res._body).to.deep.equal({ error: 'service not available' });
    });

});
