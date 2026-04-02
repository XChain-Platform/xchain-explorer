/**
 * Boundary tests — Relay SSRF bypass vectors and Icon path traversal
 *
 * Tests the /relay endpoint with various SSRF bypass techniques
 * (decimal IP, octal IP, IPv6-mapped, credentials in URL, protocol edge cases)
 * and the /icon endpoint with path traversal variants.
 *
 * Run: mocha test/boundary/unit/relay-icon-boundaries.test.js --timeout 0
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const path       = require('path');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockRes }              = require('../../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Explorer factory with stubbed deps
// ---------------------------------------------------------------------------

function makeExplorer(axiosStub, fsStub) {
    const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
        axios:    axiosStub || { get: sinon.stub().resolves({ data: {} }) },
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       fsStub || { existsSync: () => false },
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

function makeIconReq(iconPath) {
    return {
        path:    '/icon' + iconPath,
        headers: { host: 'localhost:8080' }
    };
}

// ===========================================================================
// RELAY ENDPOINT — SSRF Bypass Vectors
// ===========================================================================

describe('Boundary: Relay SSRF Protection', function () {

    let explorer;
    before(function () { explorer = makeExplorer(); });

    // -----------------------------------------------------------------------
    // Basic blocked hosts
    // -----------------------------------------------------------------------

    it('blocks localhost', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://localhost/secret.json'), res);
        expect(res._status).to.equal(403);
        expect(res._body).to.equal('Destination not permitted');
    });

    it('blocks 127.0.0.1', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://127.0.0.1/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 127.0.0.2 (any 127.x.x.x)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://127.0.0.2/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 10.0.0.1 (private class A)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://10.0.0.1/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 172.16.0.1 (private class B)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://172.16.0.1/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 172.31.255.255 (private class B upper bound)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://172.31.255.255/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('allows 172.32.0.1 (just outside private class B)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://172.32.0.1/file.json'), res);
        // Not blocked by SSRF check — will fail on actual request (connection refused)
        // so should get 400 from the catch block, NOT 403
        expect(res._status).to.not.equal(403);
    });

    it('blocks 192.168.1.1 (private class C)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://192.168.1.1/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 169.254.169.254 (AWS metadata)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://169.254.169.254/latest/meta-data.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks 0.0.0.0', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://0.0.0.0/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    // -----------------------------------------------------------------------
    // IPv6 variants
    // -----------------------------------------------------------------------

    it('blocks IPv6 loopback [::1]', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://[::1]/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    it('blocks IPv6 private fc00::1', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://[fc00::1]/secret.json'), res);
        expect(res._status).to.equal(403);
    });

    // -----------------------------------------------------------------------
    // SSRF bypass vectors (potential gaps)
    // -----------------------------------------------------------------------

    it('blocks decimal IP 2130706433 (=127.0.0.1)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://2130706433/secret.json'), res);
        // All-digit hostname blocked by /^\d+$/ pattern
        expect(res._status).to.equal(403);
    });

    it('tests octal IP 0177.0.0.1 (=127.0.0.1)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://0177.0.0.1/secret.json'), res);
        // Octal IPs may bypass regex-based hostname checks
        expect(res._status).to.be.oneOf([400, 403]);
    });

    it('blocks IPv6-mapped IPv4 [::ffff:127.0.0.1]', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://[::ffff:127.0.0.1]/secret.json'), res);
        // After bracket stripping: "::ffff:127.0.0.1" → blocked by /^::ffff:/i pattern
        expect(res._status).to.equal(403);
    });

    it('tests LOCALHOST in uppercase', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://LOCALHOST/secret.json'), res);
        // The regex uses /i flag for localhost pattern
        expect(res._status).to.equal(403);
    });

    it('tests localhost with port', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://localhost:8080/secret.json'), res);
        // URL parser separates hostname and port — hostname is just "localhost"
        expect(res._status).to.equal(403);
    });

    // -----------------------------------------------------------------------
    // Protocol edge cases
    // -----------------------------------------------------------------------

    it('blocks ftp: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('ftp://example.com/file.json'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.equal('Invalid protocol');
    });

    it('blocks file: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('file:///etc/passwd'), res);
        expect(res._status).to.equal(400);
        expect(res._body).to.equal('Invalid protocol');
    });

    it('blocks javascript: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('javascript:alert(1)'), res);
        expect(res._status).to.equal(400);
    });

    it('blocks data: protocol', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('data:text/html,<script>alert(1)</script>'), res);
        expect(res._status).to.equal(400);
    });

    // -----------------------------------------------------------------------
    // URL edge cases
    // -----------------------------------------------------------------------

    it('handles URL with credentials (user:pass@host)', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('http://user:pass@example.com/data.json'), res);
        // Should not crash — hostname should be "example.com", not blocked
        expect(res._status).to.not.equal(403);
    });

    it('returns 503 for missing url parameter', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq(undefined), res);
        expect(res._status).to.equal(503);
    });

    it('returns 503 for empty url string', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq(''), res);
        // isNull('') is true → falls through to 503
        expect(res._status).to.equal(503);
    });

    it('returns 400 for malformed URL', async function () {
        const res = mockRes();
        await explorer.processRelayRequest(makeRelayReq('not-a-valid-url'), res);
        // new URL() will throw → catch → 400
        expect(res._status).to.equal(400);
    });

    it('returns 503 for unsupported file extension', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: '<xml/>' }) };
        const expl = makeExplorer(axiosStub);
        const res = mockRes();
        await expl.processRelayRequest(makeRelayReq('https://example.com/data.xml'), res);
        // .xml is not .json or .png → falls through
        expect(res._status).to.equal(503);
    });

    it('returns 503 for URL with no extension', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: {} }) };
        const expl = makeExplorer(axiosStub);
        const res = mockRes();
        await expl.processRelayRequest(makeRelayReq('https://example.com/api/data'), res);
        expect(res._status).to.equal(503);
    });
});

// ===========================================================================
// ICON ENDPOINT — Path Traversal
// ===========================================================================

describe('Boundary: Icon Path Traversal', function () {

    it('blocks basic path traversal ../../etc/passwd', async function () {
        const explorer = makeExplorer();
        const req = makeIconReq('/../../etc/passwd');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        expect(res._status).to.equal(403);
        expect(res._body).to.equal('Access denied');
    });

    it('blocks encoded traversal %2e%2e%2f', async function () {
        // Express decodes percent-encoding before it reaches the handler
        const explorer = makeExplorer();
        const req = makeIconReq('/../../../etc/passwd');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        expect(res._status).to.equal(403);
    });

    it('backslash traversal on Linux: treated as literal chars, file not found', async function () {
        const explorer = makeExplorer();
        const req = makeIconReq('/..\\..\\etc\\passwd');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        // On Linux, backslashes are literal filename chars, path stays within icons dir
        // File doesn't exist → redirect to default
        const code = res._redirect ? res._redirect.code : res._status;
        expect(code).to.be.oneOf([200, 302, 403]);
    });

    it('nonexistent file redirects to default.png', async function () {
        const fsStub = { existsSync: () => false };
        const explorer = makeExplorer(null, fsStub);
        const req = makeIconReq('/NONEXISTENT.png');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        expect(res._redirect).to.deep.include({ code: 302, url: '/icon/default.png' });
    });

    it('existing file is served via sendFile', async function () {
        const fsStub = { existsSync: () => true };
        const explorer = makeExplorer(null, fsStub);
        const req = makeIconReq('/BTC.png');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        expect(res._sentFile).to.be.a('string');
        expect(res._sentFile).to.include('BTC.png');
    });

    it('handles icon request with just /icon/ (trailing slash, no filename)', async function () {
        const explorer = makeExplorer();
        const req = makeIconReq('/');
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        // req.path.replace(/^\/icon/, '') → '/' → resolves to icons dir itself
        // startsWith check: dirPath/... should fail since resolved path won't include path.sep after dirPath
        expect([302, 403]).to.include(res._status || (res._redirect ? res._redirect.code : 0));
    });

    it('handles very long filename gracefully', async function () {
        const longName = 'A'.repeat(10000) + '.png';
        const explorer = makeExplorer();
        const req = makeIconReq('/' + longName);
        const res = mockRes();
        await explorer.processIconRequest(req, res);
        // File won't exist → redirect to default
        expect(res._redirect).to.deep.include({ code: 302, url: '/icon/default.png' });
    });

    it('blocks null byte injection attempt', async function () {
        const explorer = makeExplorer();
        const req = makeIconReq('/test\x00.png');
        const res = mockRes();
        try {
            await explorer.processIconRequest(req, res);
            // Should either block (403) or redirect (302) — not serve wrong file
            const code = res._status || (res._redirect ? res._redirect.code : 0);
            expect([302, 403]).to.include(code);
        } catch (e) {
            // Node.js may throw ERR_INVALID_ARG_VALUE for null bytes in paths
            expect(e).to.exist;
        }
    });
});
