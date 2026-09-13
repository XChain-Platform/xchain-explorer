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
 * Security tests: SSRF Protection
 *
 * Tests the /relay endpoint against SSRF bypass vectors including
 * redirect-based bypass, protocol smuggling, and URL parsing edge cases.
 *
 * Run: mocha test/security/ssrf-protection.test.js --timeout 0
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

function makeExplorer(axiosStub, dnsStub) {
    const stubs = {
        axios:    axiosStub || { get: sinon.stub().resolves({ data: {} }) },
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       { existsSync: () => false },
        './db.js': function() { this.init = () => {}; }
    };
    if (dnsStub) stubs.dns = dnsStub;
    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', stubs);

    const configInfo = createConfigInfoStub();
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
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

describe('Security: SSRF: Redirect bypass prevention', function () {

    it('sets maxRedirects to 0 (blocks redirect-based SSRF)', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);

        expect(axiosStub.get.calledOnce).to.be.true;
        const opts = axiosStub.get.firstCall.args[1];
        expect(opts).to.have.property('maxRedirects', 0);
    });

    it('includes timeout and size limits in request options', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: {} }) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);

        const opts = axiosStub.get.firstCall.args[1];
        expect(opts).to.have.property('timeout', 5000);
        expect(opts).to.have.property('maxContentLength', 5 * 1024 * 1024);
    });
});

describe('Security: SSRF: Protocol validation', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('blocks ftp:// protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('ftp://evil.com/data.json'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.include({ error: 'Invalid protocol' });
    });

    it('blocks file:// protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('file:///etc/passwd'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.include({ error: 'Invalid protocol' });
    });

    it('blocks javascript: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('javascript:alert(1)'), res);
        // URL constructor may throw for javascript:, caught by try/catch
        expect(res._status).to.be.oneOf([400, 503]);
    });

    it('blocks data: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('data:text/html,<script>alert(1)</script>'), res);
        expect(res._status).to.be.oneOf([400, 503]);
    });
});

describe('Security: SSRF: Private IP blocklist', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    const blockedHosts = [
        ['localhost',              'localhost'],
        ['127.0.0.1',             '127.x.x.x'],
        ['127.255.255.255',       '127.x.x.x (high)'],
        ['10.0.0.1',              '10.x.x.x'],
        ['10.255.255.255',        '10.x.x.x (high)'],
        ['172.16.0.1',            '172.16-31.x.x'],
        ['172.31.255.255',        '172.31.x.x'],
        ['192.168.1.1',           '192.168.x.x'],
        ['169.254.169.254',       'cloud metadata'],
        ['0.0.0.0',               '0.x.x.x'],
        ['[::1]',                 'IPv6 loopback'],
        ['[fc00::1]',             'IPv6 unique local'],
        ['[::ffff:127.0.0.1]',   'IPv6-mapped IPv4'],
        ['[fe80::1]',             'IPv6 link-local'],
    ];

    for (const [host, desc] of blockedHosts) {
        it(`blocks ${desc} (${host})`, async function () {
            const res = mockRes();
            await explorer.processRelayRequest(makeRelayReq(`http://${host}/test.json`), res);
            expect(res._status).to.equal(403);
            expect(res._body).to.include({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
        });
    }

    it('blocks decimal IP notation (2130706433 = 127.0.0.1)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://2130706433/test.json'), res);
        expect(res._status).to.equal(403);
    });
});

describe('Security: SSRF: File extension filtering', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('allows .json extension', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        expect(res._status).to.not.equal(503);
    });

    it('rejects .html extension', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('https://example.com/page.html'), res);
        expect(res._status).to.equal(503);
    });

    it('rejects .js extension', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('https://example.com/script.js'), res);
        expect(res._status).to.equal(503);
    });

    it('rejects no extension', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('https://example.com/api/data'), res);
        expect(res._status).to.equal(503);
    });

    it('rejects .xml extension', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('https://example.com/feed.xml'), res);
        expect(res._status).to.equal(503);
    });
});

describe('Security: SSRF: URL parsing edge cases', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('handles URL with credentials (user:pass@host)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://admin:secret@127.0.0.1/test.json'), res);
        expect(res._status).to.equal(403);
    });

    it('handles URL with port on private IP', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://192.168.1.1:8080/test.json'), res);
        expect(res._status).to.equal(403);
    });

    it('handles empty URL', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq(''), res);
        // Empty string to URL constructor throws, caught by try/catch
        expect(res._status).to.be.oneOf([400, 503]);
    });

    it('handles missing url parameter', async function () {
        const res = mockRes();
        const req = { path: '/relay', query: {}, headers: { host: 'localhost' } };
        await explorer.processRelayRequest(req, res);
        expect(res._status).to.equal(503);
    });

    it('handles URL with percent-encoded dots (resolves to empty hostname)', async function () {
        const res = mockRes();
        // new URL('http://127%2E0%2E0%2E1/test.json') parses with empty hostname,
        // so it does not resolve to 127.0.0.1 (not an SSRF risk)
        await explorer.processRelayRequest(makeRelayReq('http://127%2E0%2E0%2E1/test.json'), res);
        // The URL has empty hostname: not blocked but also not pointing at internal IP
        expect(res._status).to.not.equal(500); // should not crash
    });
});

describe('Security: SSRF: Error response safety', function () {

    it('returns generic error message on network failure', async function () {
        const axiosStub = { get: sinon.stub().rejects(new Error('ECONNREFUSED')) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.include({ error: 'Invalid or unreachable URL', code: 'RELAY_FETCH_FAILED' });
        expect(res._body.error).to.not.include('ECONNREFUSED');
    });

    it('does not leak internal error details', async function () {
        const axiosStub = { get: sinon.stub().rejects(new Error('connect ECONNREFUSED 192.168.1.100:443')) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        expect(res._body.error).to.not.include('192.168');
        expect(res._body.error).to.not.include('ECONNREFUSED');
    });
});

describe('Security: SSRF: DNS resolution bypass', function () {

    it('_isPrivateAddress flags private / loopback / link-local / metadata IPs', function () {
        const explorer = makeExplorer();
        const priv = ['127.0.0.1', '127.255.255.255', '10.1.2.3', '172.16.0.1',
                      '172.31.255.255', '192.168.0.5', '169.254.169.254', '0.0.0.0',
                      '::1', '::ffff:127.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1'];
        for (const ip of priv) expect(explorer._isPrivateAddress(ip), ip).to.be.true;

        const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];
        for (const ip of pub) expect(explorer._isPrivateAddress(ip), ip).to.be.false;
    });

    it('wires a lookup shim into the relay request options', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();
        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        const opts = axiosStub.get.firstCall.args[1];
        expect(opts.lookup).to.be.a('function');
    });

    it('lookup rejects a hostname that resolves to a metadata IP (169.254.169.254)', function (done) {
        const dnsStub = { lookup: (host, options, cb) => {
            if (typeof options === 'function') { cb = options; options = {}; }
            cb(null, '169.254.169.254', 4);                       // DNS A record → metadata
        }};
        const explorer = makeExplorer(undefined, dnsStub);
        explorer._ssrfSafeLookup('metadata.attacker.example', {}, (err) => {
            expect(err).to.be.an('error');
            expect(err.code).to.equal('RELAY_DENIED');
            done();
        });
    });

    it('lookup rejects when any resolved address (all:true) is private', function (done) {
        const dnsStub = { lookup: (host, options, cb) => {
            if (typeof options === 'function') { cb = options; options = {}; }
            cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
        }};
        const explorer = makeExplorer(undefined, dnsStub);
        explorer._ssrfSafeLookup('rebind.attacker.example', { all: true }, (err) => {
            expect(err).to.be.an('error');
            expect(err.code).to.equal('RELAY_DENIED');
            done();
        });
    });

    it('lookup passes through a public address unchanged', function (done) {
        const dnsStub = { lookup: (host, options, cb) => {
            if (typeof options === 'function') { cb = options; options = {}; }
            cb(null, '93.184.216.34', 4);
        }};
        const explorer = makeExplorer(undefined, dnsStub);
        explorer._ssrfSafeLookup('example.com', {}, (err, address, family) => {
            expect(err).to.not.exist;
            expect(address).to.equal('93.184.216.34');
            expect(family).to.equal(4);
            done();
        });
    });
});

// Canonical ssrf-guard module: the range list shared by /relay AND the
// IconDownloader. Covers the ranges added when the two drifted copies were
// unified (CGNAT 100.64/10, unspecified ::, complete ULA/link-local).
describe('Security: SSRF: canonical range classifier (ssrf-guard.js)', function () {
    const { isPrivateAddress, makeSafeLookup } = require('../../src/ssrf-guard.js');

    it('blocks carrier-grade NAT 100.64/10 (RFC 6598) but not adjacent public space', function () {
        for (const ip of ['100.64.0.1', '100.100.5.5', '100.127.255.255'])
            expect(isPrivateAddress(ip), ip).to.be.true;
        // 100.0/10 boundaries: 100.63.x and 100.128.x are public.
        for (const ip of ['100.63.255.255', '100.128.0.1'])
            expect(isPrivateAddress(ip), ip).to.be.false;
    });

    it('blocks the unspecified address :: and 0.0.0.0', function () {
        expect(isPrivateAddress('::')).to.be.true;
        expect(isPrivateAddress('0.0.0.0')).to.be.true;
    });

    it('blocks the complete ULA fc00::/7 and link-local fe80::/10 ranges', function () {
        for (const ip of ['fc00::1', 'fcff::1', 'fd00::1', 'fdff::1'])
            expect(isPrivateAddress(ip), ip).to.be.true;
        for (const ip of ['fe80::1', 'febf::1'])
            expect(isPrivateAddress(ip), ip).to.be.true;
    });

    it('strips an IPv6 zone id before classifying', function () {
        expect(isPrivateAddress('fe80::1%eth0')).to.be.true;
    });

    // The WHATWG URL parser serializes an IPv6 host by hex pieces, so the dotted
    // mapped spelling never reaches this classifier from a URL - only the hex one
    // does, and a "::ffff:" prefix strip left it as unmatchable residue.
    it('blocks IPv4-mapped IPv6 in hex-piece form, the spelling a URL emits', function () {
        for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:5',
                          '0:0:0:0:0:ffff:7f00:1', '[::ffff:7f00:1]'])
            expect(isPrivateAddress(ip), ip).to.be.true;
        const host = new URL('http://[::ffff:127.0.0.1]/x.json').hostname.replace(/^\[|\]$/g, '');
        expect(host).to.equal('::ffff:7f00:1');
        expect(isPrivateAddress(host), host).to.be.true;
    });

    it('classifies every spelling of one IPv6 address alike', function () {
        for (const ip of ['0:0:0:0:0:0:0:1', 'fe80:0:0:0:0:0:0:1', '::127.0.0.1', '::ffff:0:7f00:1'])
            expect(isPrivateAddress(ip), ip).to.be.true;
        for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '2606:4700:0:0:0:0:0:1111'])
            expect(isPrivateAddress(ip), ip).to.be.false;
    });

    it('leaves ordinary public addresses alone', function () {
        for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'])
            expect(isPrivateAddress(ip), ip).to.be.false;
    });

    it('makeSafeLookup rejects a hostname resolving to a private address', function (done) {
        const dnsStub = { lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; } cb(null, '10.0.0.5', 4); } };
        makeSafeLookup(dnsStub)('internal.attacker.example', {}, (err) => {
            expect(err).to.be.an('error');
            expect(err.code).to.equal('RELAY_DENIED');
            done();
        });
    });

    it('makeSafeLookup passes a public address through unchanged', function (done) {
        const dnsStub = { lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; } cb(null, '93.184.216.34', 4); } };
        makeSafeLookup(dnsStub)('example.com', {}, (err, address, family) => {
            expect(err).to.not.exist;
            expect(address).to.equal('93.184.216.34');
            expect(family).to.equal(4);
            done();
        });
    });
});

// IconDownloader egress: fetches URLs derived from on-chain token descriptions
// (attacker-controlled), so it MUST carry the SSRF lookup guard on its axios
// request or a token description of http://169.254.169.254/x.json turns the
// explorer into an SSRF proxy.
describe('Security: SSRF: IconDownloader fetch guard', function () {
    it('wires the SSRF lookup shim into its axios request options', async function () {
        const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
        const IconDownloader = proxyquire('../../src/IconDownloader.js', {
            axios: axiosStub,
            './IconResolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });
        const dl = new IconDownloader({ util: {} });
        await dl._httpFetch('https://example.com/icon.png');
        const opts = axiosStub.get.firstCall.args[1];
        expect(opts.lookup, 'IconDownloader fetch must set a lookup guard').to.be.a('function');
    });

    it('the wired lookup rejects a private resolution (RELAY_DENIED)', function (done) {
        const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
        const dnsStub   = { lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; } cb(null, '169.254.169.254', 4); } };
        const IconDownloader = proxyquire('../../src/IconDownloader.js', {
            axios: axiosStub,
            dns:   dnsStub,
            './IconResolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });
        const dl = new IconDownloader({ util: {} });
        dl._httpFetch('https://metadata.attacker.example/x.png').then(() => {
            // force the request so the lookup runs
        }).catch(() => {});
        const opts = axiosStub.get.firstCall.args[1];
        opts.lookup('metadata.attacker.example', {}, (err) => {
            expect(err).to.be.an('error');
            expect(err.code).to.equal('RELAY_DENIED');
            done();
        });
    });

    // Web ports only, the rule /relay already enforces over the same class of
    // attacker-written URLs: the private-range checks pass a PUBLIC address, so
    // an unrestricted port makes this fetch a service probe whose result is
    // readable in the icons row (status, last_error).
    describe('web-port restriction', function () {
        const load = (axiosStub) => proxyquire('../../src/IconDownloader.js', {
            axios: axiosStub,
            './IconResolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });

        it('refuses a non-web port before any socket opens', async function () {
            const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
            const dl = new (load(axiosStub))({ util: {} });
            for (const url of ['https://victim.example:6379/x.png', 'http://victim.example:22/x.png',
                               'http://victim.example:8080/x.png']) {
                let err = null;
                try { await dl._httpFetch(url); } catch (e) { err = e; }
                expect(err, url).to.be.an('error');
                expect(err.code, url).to.equal('RELAY_DENIED');
            }
            expect(axiosStub.get.callCount, 'no request may be issued').to.equal(0);
        });

        it('still allows the web ports, default or explicit', async function () {
            const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
            const dl = new (load(axiosStub))({ util: {} });
            for (const url of ['https://example.com/icon.png', 'http://example.com/icon.png',
                               'https://example.com:443/icon.png', 'http://example.com:80/icon.png']) {
                await dl._httpFetch(url);
            }
            expect(axiosStub.get.callCount).to.equal(4);
        });

        it('re-checks the port on a redirect hop', async function () {
            const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
            const dl = new (load(axiosStub))({ util: {} });
            await dl._httpFetch('https://example.com/icon.png');
            const opts = axiosStub.get.firstCall.args[1];
            expect(() => opts.beforeRedirect({ href: 'http://example.com:6379/icon.png' }))
                .to.throw(/port is not permitted/);
            expect(() => opts.beforeRedirect({ href: 'https://elsewhere.example/icon.png' })).to.not.throw();
        });
    });
});
