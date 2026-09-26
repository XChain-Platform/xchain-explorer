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
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockRes }              = require('../../fixtures/mock-query-args.js');

// proxyquire.noCallThru() is NOT used globally so internal helpers (utility,
// path, etc.) stay real; only the listed modules are replaced.
function makeExplorer(axiosStub) {
    const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
        axios:    axiosStub,
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       { existsSync: () => false },
        './db/index.js': function() { this.init = () => {}; }
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

// Just enough of a request for the relay handler: the target url, host and scheme.
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
        const req = makeRelayReq('https://ipfsc.crystalsuite.com/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(axiosStub.get.calledOnce).to.be.true;
        expect(axiosStub.get.firstCall.args[0]).to.equal('https://ipfsc.crystalsuite.com/token.json');
        expect(res._type).to.equal('json');
        // The body is re-serialized JSON text that still carries the payload fields.
        expect(res._body).to.include('XCHAIN');
    });

    it('fetches a .png URL and returns a base64-encoded string', async function () {
        // Simulate a minimal 1x1 PNG as a buffer (just needs to be non-empty bytes)
        const fakeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const axiosStub = {
            get: sinon.stub().resolves({ data: fakeBuffer.buffer.slice(fakeBuffer.byteOffset, fakeBuffer.byteOffset + fakeBuffer.byteLength) })
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://ipfsc.crystalsuite.com/logo.png');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(axiosStub.get.calledOnce).to.be.true;
        // An image must be fetched as raw bytes, or it would be mangled as text.
        expect(axiosStub.get.firstCall.args[1]).to.have.property('responseType', 'arraybuffer');
        // Those bytes come back to the page as a non-empty base64 string.
        expect(res._body).to.be.a('string').and.have.length.above(0);
    });
});

describe('XChainExplorer#processRelayRequest', function () {
    it('fetches the extensionless IPFS and inscription URLs emitted by the token page', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer = makeExplorer(axiosStub);
        const urls = [
            'https://ipfsc.crystalsuite.com/QmMetadata',
            'https://inscription-decoder.vercel.app/api/image?type=json&tx=' + 'ab'.repeat(32)
        ];

        for(const url of urls)
            await explorer.processRelayRequest(makeRelayReq(url), mockRes());

        expect(axiosStub.get.callCount).to.equal(2);
        expect(axiosStub.get.firstCall.args[0]).to.equal(urls[0]);
        expect(axiosStub.get.secondCall.args[0]).to.equal(urls[1]);
    });
});

describe('XChainExplorer#processRelayRequest', function () {
    it('refuses an arbitrary public host without making a request', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { relayed: true } }) };
        const explorer = makeExplorer(axiosStub);
        const res = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/token.json'), res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
        expect(axiosStub.get.called).to.be.false;
    });
});

describe('XChainExplorer#processRelayRequest', function () {
    it('returns 400 for an ftp: protocol URL', async function () {
        const explorer = makeExplorer({});
        const req = makeRelayReq('ftp://example.com/file.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid protocol', code: 'RELAY_INVALID_PROTOCOL' });
    });

    // Private and local addresses are refused with 403, which keeps the relay from
    // reaching the server's own network.
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
});

describe('XChainExplorer#processRelayRequest', function () {
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

    // Ranges a prefix-only blocklist would miss (only /^fc00:/, no CGNAT,
    // partial link-local); the canonical isPrivateAddress + net.isIP literal check
    // must cover them so an IPv6/CGNAT literal cannot bypass the guard. A private
    // literal never reaches axios (the connect-time lookup shim is skipped for IP
    // literals), so a hit here proves the pre-connect canonical check fired.
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
});

describe('XChainExplorer#processRelayRequest', function () {
    it('returns 400 when axios throws a network error', async function () {
        const axiosStub = {
            get: sinon.stub().rejects(new Error('ECONNREFUSED'))
        };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://arweave.net/token.json');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        expect(res._status).to.equal(400);
        expect(res._body).to.deep.equal({ error: 'Invalid or unreachable URL', code: 'RELAY_FETCH_FAILED' });
    });

    it('returns 503 for an unsupported file extension (.html)', async function () {
        const axiosStub = { get: sinon.stub() };
        const explorer = makeExplorer(axiosStub);
        const req = makeRelayReq('https://ipfsc.crystalsuite.com/page.html');
        const res = mockRes();

        await explorer.processRelayRequest(req, res);

        // An unsupported file type is refused before anything is fetched.
        expect(axiosStub.get.called).to.be.false;
        expect(res._status).to.equal(503);
        expect(res._body).to.deep.equal({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    });
});

// A relay request that names the chain and token whose description points at the URL.
function makeTokenRelayReq(url, coin, tick) {
    const req = makeRelayReq(url);
    if(coin !== undefined) req.query.coin = coin;
    if(tick !== undefined) req.query.tick = tick;
    return req;
}

// Give the explorer one TDOGE database whose tokens carry these descriptions.
function withTokens(explorer, descriptions) {
    explorer.db.pools = { TDOGE: {} };
    explorer.db.findTokenDescription = sinon.stub().callsFake(async (config, tick) =>
        (config.coin === 'TDOGE' && Object.prototype.hasOwnProperty.call(descriptions, tick)) ? descriptions[tick] : null);
    return explorer;
}

const FAIRYWINK_URL = 'https://cryptowave.neocities.org/smokingfairywink.json';
const DENIED        = { error: 'Destination not permitted', code: 'RELAY_DENIED' };

describe('XChainExplorer#processRelayRequest token-referenced hosts', function () {
    it('relays an ordinary host when the named token description points at that exact URL', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { name: 'FAIRYWINK' } }) };
        const explorer = withTokens(makeExplorer(axiosStub), { FAIRYWINK: FAIRYWINK_URL });
        const res = mockRes();

        await explorer.processRelayRequest(makeTokenRelayReq(FAIRYWINK_URL, 'tdoge', 'FAIRYWINK'), res);

        expect(axiosStub.get.calledOnce).to.be.true;
        expect(axiosStub.get.firstCall.args[0]).to.equal(FAIRYWINK_URL);
        // The token path keeps the same egress limits as the gateways.
        const opts = axiosStub.get.firstCall.args[1];
        expect(opts).to.include({ maxRedirects: 0, timeout: 5000, maxContentLength: 5 * 1024 * 1024 });
        expect(opts.lookup).to.be.a('function');
        expect(res._type).to.equal('json');
        expect(res._body).to.include('FAIRYWINK');
    });

    it('relays the https form a plain http description is upgraded to', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer = withTokens(makeExplorer(axiosStub), { STARE: 'http://ooakosimo.github.io/xmeta/stare.json;art' });

        await explorer.processRelayRequest(makeTokenRelayReq('https://ooakosimo.github.io/xmeta/stare.json', 'TDOGE', 'STARE'), mockRes());

        expect(axiosStub.get.calledOnce).to.be.true;
    });

    it('refuses the same URL under a tick whose description names a different URL', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { relayed: true } }) };
        const explorer = withTokens(makeExplorer(axiosStub), {
            FAIRYWINK: FAIRYWINK_URL,
            OTHER:     'https://cryptowave.neocities.org/other.json'
        });
        const res = mockRes();

        await explorer.processRelayRequest(makeTokenRelayReq(FAIRYWINK_URL, 'TDOGE', 'OTHER'), res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal(DENIED);
        expect(axiosStub.get.called).to.be.false;
    });

    it('refuses a private address even when a token description references it', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { leaked: true } }) };
        const explorer = withTokens(makeExplorer(axiosStub), { EVIL: 'https://10.0.0.1/meta.json' });
        const res = mockRes();

        await explorer.processRelayRequest(makeTokenRelayReq('https://10.0.0.1/meta.json', 'TDOGE', 'EVIL'), res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal(DENIED);
        expect(axiosStub.get.called).to.be.false;
        // The address gate refuses it before any token is read.
        expect(explorer.db.findTokenDescription.called).to.be.false;
    });
});

describe('XChainExplorer#processRelayRequest token reference refusals', function () {
    it('relays a gateway host with no coin or tick and reads no token', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer = withTokens(makeExplorer(axiosStub), {});

        await explorer.processRelayRequest(makeRelayReq('https://arweave.net/abc123'), mockRes());

        expect(axiosStub.get.calledOnce).to.be.true;
        expect(explorer.db.findTokenDescription.called).to.be.false;
    });

    const refusals = [
        ['no tick',                 ['TDOGE', undefined]],
        ['an empty tick',           ['TDOGE', '']],
        ['an unknown tick',         ['TDOGE', 'NOSUCHTOKEN']],
        ['no coin',                 [undefined, 'FAIRYWINK']],
        ['a chain with no database', ['TBTC', 'FAIRYWINK']],
        ['a repeated tick',         ['TDOGE', ['FAIRYWINK', 'FAIRYWINK']]]
    ];
    for (const [label, [coin, tick]] of refusals) {
        it(`refuses a non-gateway host with ${label}`, async function () {
            const axiosStub = { get: sinon.stub().resolves({ data: { relayed: true } }) };
            const explorer = withTokens(makeExplorer(axiosStub), { FAIRYWINK: FAIRYWINK_URL });
            const res = mockRes();

            await explorer.processRelayRequest(makeTokenRelayReq(FAIRYWINK_URL, coin, tick), res);

            expect(res._status).to.equal(403);
            expect(res._body).to.deep.equal(DENIED);
            expect(axiosStub.get.called).to.be.false;
        });
    }

    it('refuses when the token description cannot be read', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { relayed: true } }) };
        const explorer = withTokens(makeExplorer(axiosStub), {});
        explorer.db.findTokenDescription = sinon.stub().rejects(new Error('pool closed'));
        const res = mockRes();

        await explorer.processRelayRequest(makeTokenRelayReq(FAIRYWINK_URL, 'TDOGE', 'FAIRYWINK'), res);

        expect(res._status).to.equal(403);
        expect(axiosStub.get.called).to.be.false;
    });
});
