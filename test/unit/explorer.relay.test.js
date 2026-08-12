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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const path       = require('path');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

// proxyquire.noCallThru() is NOT used globally so internal helpers (utility,
// path, etc.) stay real; only the listed modules are replaced.
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

function makeRelayReq(url) {
    return {
        path:    '/relay',
        query:   url !== undefined ? { url } : {},
        headers: { host: 'localhost:8080' },
        secure:  false
    };
}

describe('XChainExplorer#processRelayRequest', function () {

    it('returns 503 when no url query parameter is provided', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq(undefined);
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(503);
        expect(res._body).to.deep.equal({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    });

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
        expect(res._body).to.include('XCHAIN');
    });

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
        expect(axiosStub.get.firstCall.args[1]).to.have.property('responseType', 'arraybuffer');
        expect(res._body).to.be.a('string').and.have.length.above(0);
    });

    it('returns 400 for an ftp: protocol URL', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('ftp://example.com/file.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid protocol', code: 'RELAY_INVALID_PROTOCOL' });
    });

    it('returns 403 for 127.0.0.1 (loopback)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://127.0.0.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    it('returns 403 for 10.x.x.x (private class A)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://10.0.0.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    it('returns 403 for 192.168.x.x (private class C)', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://192.168.1.1/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    it('returns 403 for localhost', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://localhost/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    it('returns 403 for IPv6 loopback ::1', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://[::1]/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    it('returns 403 for fc00: IPv6 ULA', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('http://[fc00::1]/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
    });

    // Ranges an earlier hand-rolled blocklist missed (only /^fc00:/, no CGNAT,
    // partial link-local); the canonical isPrivateAddress + net.isIP literal check
    // must cover them so an IPv6/CGNAT literal cannot bypass the guard. A private
    // literal never reaches axios, so a hit here proves the pre-connect check fired.
    const ssrfLiteralGaps = [
        ['fd00:ec2::254 (AWS IMDS over IPv6, ULA)', 'http://[fd00:ec2::254]/latest/meta-data/x.json'],
        ['fdff:: (rest of fc00::/7 ULA)',           'http://[fdff::1]/token.json'],
        ['100.64.0.1 (CGNAT 100.64/10)',            'http://100.64.0.1/token.json'],
        ['fe9a:: (link-local fe80::/10 mid-range)', 'http://[fe9a::1]/token.json'],
    ];
    for (const [label, url] of ssrfLiteralGaps) {
        it(`returns 403 for ${label}`, async function () {
            // axios stub that would "succeed" if the guard failed to block: proves the
            // 403 comes from the guard, not a fetch error.
            const axiosStub = { get: sinon.stub().resolves({ data: { leaked: true } }) };
            const explorer = makeExplorer(axiosStub);
            const req = makeRelayReq(url);
            const res = mockRes();

            await explorer.processRelayRequest(req, res);

            expect(res._status).to.equal(403);
            expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
            expect(axiosStub.get.called, 'axios must not be called for a private literal').to.be.false;
        });
    }

    it('returns 400 when axios throws a network error', async function () {
        const axiosStub = {
            get: sinon.stub().rejects(new Error('ECONNREFUSED'))
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid or unreachable URL', code: 'RELAY_FETCH_FAILED' });
    });

    it('returns 503 for an unsupported file extension (.html)', async function () {
        const axiosStub = { get: sinon.stub() };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://example.com/page.html');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(axiosStub.get.called).to.be.false;
        expect(res._status).to.equal(503);
        expect(res._body).to.deep.equal({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    });

});
