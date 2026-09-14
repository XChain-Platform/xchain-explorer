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

// Canonical http/ssrf_guard.js module: the range list shared by /relay AND the
// IconDownloader. Covers the ranges added when the two drifted copies were
// unified (CGNAT 100.64/10, unspecified ::, complete ULA/link-local).
describe('Security: SSRF: canonical range classifier (ssrf-guard.js)', function () {
    const { isPrivateAddress } = require('../../../../src/http/ssrf_guard.js');

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
});

describe('Security: SSRF: canonical range classifier (ssrf-guard.js)', function () {
    const { isPrivateAddress, makeSafeLookup } = require('../../../../src/http/ssrf_guard.js');

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
        const IconDownloader = proxyquire('../../../../src/icons/downloader.js', {
            axios: axiosStub,
            './resolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });
        const dl = new IconDownloader({ util: {} });
        await dl.httpFetch('https://example.com/icon.png');
        const opts = axiosStub.get.firstCall.args[1];
        expect(opts.lookup, 'IconDownloader fetch must set a lookup guard').to.be.a('function');
    });

    it('the wired lookup rejects a private resolution (RELAY_DENIED)', function (done) {
        const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
        const dnsStub   = { lookup: (h, o, cb) => { if (typeof o === 'function') { cb = o; } cb(null, '169.254.169.254', 4); } };
        const IconDownloader = proxyquire('../../../../src/icons/downloader.js', {
            axios: axiosStub,
            dns:   dnsStub,
            './resolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });
        const dl = new IconDownloader({ util: {} });
        dl.httpFetch('https://metadata.attacker.example/x.png').then(() => {
            // force the request so the lookup runs
        }).catch(() => {});
        const opts = axiosStub.get.firstCall.args[1];
        opts.lookup('metadata.attacker.example', {}, (err) => {
            expect(err).to.be.an('error');
            expect(err.code).to.equal('RELAY_DENIED');
            done();
        });
    });
});

describe('Security: SSRF: IconDownloader fetch guard', function () {
    // Web ports only, the rule /relay already enforces over the same class of
    // attacker-written URLs: the private-range checks pass a PUBLIC address, so
    // an unrestricted port makes this fetch a service probe whose result is
    // readable in the icons row (status, last_error).
    describe('web-port restriction', function () {
        const load = (axiosStub) => proxyquire('../../../../src/icons/downloader.js', {
            axios: axiosStub,
            './resolver': { resolveDescriptionToSource: () => null, selectIconUrlFromCip25Json: () => null },
        });

        it('refuses a non-web port before any socket opens', async function () {
            const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
            const dl = new (load(axiosStub))({ util: {} });
            for (const url of ['https://victim.example:6379/x.png', 'http://victim.example:22/x.png',
                               'http://victim.example:8080/x.png']) {
                let err = null;
                try { await dl.httpFetch(url); } catch (e) { err = e; }
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
                await dl.httpFetch(url);
            }
            expect(axiosStub.get.callCount).to.equal(4);
        });

        it('re-checks the port on a redirect hop', async function () {
            const axiosStub = { get: sinon.stub().resolves({ status: 200, data: Buffer.from([]), headers: {} }) };
            const dl = new (load(axiosStub))({ util: {} });
            await dl.httpFetch('https://example.com/icon.png');
            const opts = axiosStub.get.firstCall.args[1];
            expect(() => opts.beforeRedirect({ href: 'http://example.com:6379/icon.png' }))
                .to.throw(/port is not permitted/);
            expect(() => opts.beforeRedirect({ href: 'https://elsewhere.example/icon.png' })).to.not.throw();
        });
    });
});
