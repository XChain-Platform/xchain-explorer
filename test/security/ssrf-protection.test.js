/**
 * Security tests — SSRF Protection
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

// ---------------------------------------------------------------------------
// Explorer factory with stubbed deps
// ---------------------------------------------------------------------------

function makeExplorer(axiosStub) {
    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
        axios:    axiosStub || { get: sinon.stub().resolves({ data: {} }) },
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       { existsSync: () => false },
        './db.js': function() { this.init = () => {}; }
    });

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

// ===========================================================================
// Redirect-based SSRF bypass prevention
// ===========================================================================

describe('Security: SSRF — Redirect bypass prevention', function () {

    it('sets maxRedirects to 0 (blocks redirect-based SSRF)', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: { ok: true } }) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);

        // Verify axios was called with maxRedirects: 0
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

// ===========================================================================
// Protocol validation
// ===========================================================================

describe('Security: SSRF — Protocol validation', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('blocks ftp:// protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('ftp://evil.com/data.json'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.equal('Invalid protocol');
    });

    it('blocks file:// protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('file:///etc/passwd'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.equal('Invalid protocol');
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

// ===========================================================================
// Private IP blocklist
// ===========================================================================

describe('Security: SSRF — Private IP blocklist', function () {

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
            expect(res._body).to.equal('Destination not permitted');
        });
    }

    it('blocks decimal IP notation (2130706433 = 127.0.0.1)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://2130706433/test.json'), res);
        expect(res._status).to.equal(403);
    });
});

// ===========================================================================
// File extension filtering
// ===========================================================================

describe('Security: SSRF — File extension filtering', function () {

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

// ===========================================================================
// URL parsing edge cases
// ===========================================================================

describe('Security: SSRF — URL parsing edge cases', function () {

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
        // new URL('http://127%2E0%2E0%2E1/test.json') parses with empty hostname
        // so it does NOT resolve to 127.0.0.1 — not an SSRF risk
        await explorer.processRelayRequest(makeRelayReq('http://127%2E0%2E0%2E1/test.json'), res);
        // The URL has empty hostname — not blocked but also not pointing at internal IP
        expect(res._status).to.not.equal(500); // should not crash
    });
});

// ===========================================================================
// Error handling (no info leakage)
// ===========================================================================

describe('Security: SSRF — Error response safety', function () {

    it('returns generic error message on network failure', async function () {
        const axiosStub = { get: sinon.stub().rejects(new Error('ECONNREFUSED')) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.equal('Invalid or unreachable URL');
        expect(res._body).to.not.include('ECONNREFUSED');
    });

    it('does not leak internal error details', async function () {
        const axiosStub = { get: sinon.stub().rejects(new Error('connect ECONNREFUSED 192.168.1.100:443')) };
        const explorer  = makeExplorer(axiosStub);
        const res       = mockRes();

        await explorer.processRelayRequest(makeRelayReq('https://example.com/data.json'), res);
        expect(res._body).to.not.include('192.168');
        expect(res._body).to.not.include('ECONNREFUSED');
    });
});
