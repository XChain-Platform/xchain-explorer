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
 * Security tests: a forged X-Forwarded-For cannot choose a rate-limit bucket
 *
 * Models the public path Cloudflare -> Apache -> Node. Cloudflare appends the
 * address it accepted the connection from and sets CF-Connecting-IP to it.
 * Apache mod_proxy then appends exactly one entry, its useragent_ip: the
 * Cloudflare edge address, or the visitor address when mod_remoteip has
 * resolved CF-Connecting-IP first. Node's socket peer is Apache on loopback.
 * With one trusted hop, req.ip is the rightmost entry, so everything a client
 * sends sits to the left of it and is never read. The per-IP limiters key on
 * req.ip, and the WebSocket cap resolves the same entry by hand.
 *
 * Run: mocha test/security/proxy_spoof.test.js --timeout 20000
 */

'use strict';

const { expect }        = require('chai');
const express           = require('express');
const request           = require('supertest');
const { rateLimit }     = require('express-rate-limit');
const { applyTrustProxy } = require('../../src/http/trust_proxy.js');
const WebSocketServer   = require('../../src/ws/websocket_server.js');

const VISITOR = '203.0.113.50';   // address Cloudflare accepted the connection from
const EDGE    = '198.51.100.20';  // Cloudflare edge address Apache saw as its peer
const LOOPBACK_PEER = /^(::ffff:)?127\.0\.0\.1$|^::1$/;

function makeApp() {
    const app = express();
    applyTrustProxy(app);
    app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
    return app;
}

// Same seam plus a one-request bucket, so the second request in a bucket is a 429.
function makeLimitedApp() {
    const app = express();
    applyTrustProxy(app);
    app.use(rateLimit({ windowMs: 60 * 1000, limit: 1, standardHeaders: true, legacyHeaders: false }));
    app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
    return app;
}

function whoami(app, headers) {
    let req = request(app).get('/whoami');
    for(const [name, value] of Object.entries(headers))
        req = req.set(name, value);
    return req;
}

// What Node receives for a client that sent `forged` as its own X-Forwarded-For.
function forwardedChain(forged, apacheEntry) {
    return [forged, VISITOR, apacheEntry].filter(Boolean).join(', ');
}

function wsClientIp(headers) {
    const ws = new WebSocketServer({ trustProxyHops: 1 });
    return ws.clientIp({ headers, socket: { remoteAddress: '127.0.0.1' } });
}

describe('Security: Proxy spoofing: req.ip through Cloudflare and Apache', function () {

    it('keys on the visitor when mod_remoteip resolved CF-Connecting-IP', async function () {
        const res = await whoami(makeApp(), {
            'X-Forwarded-For':  forwardedChain('192.0.2.77', VISITOR),
            'CF-Connecting-IP': VISITOR,
            'X-Real-IP':        '192.0.2.77'
        });
        expect(res.body.ip).to.equal(VISITOR);
    });

    it('keys on the edge when Apache appended the edge address', async function () {
        // The entry Cloudflare appended is one hop further left than trusted, so
        // neither it nor the forged value can become the key.
        const res = await whoami(makeApp(), { 'X-Forwarded-For': forwardedChain('192.0.2.77', EDGE) });
        expect(res.body.ip).to.equal(EDGE);
    });

    it('ignores forged loopback, own-address and multi-entry values', async function () {
        const forgeries = [
            '127.0.0.1',
            '::1',
            VISITOR,
            '192.0.2.1, 192.0.2.2, 192.0.2.3',
            ' 192.0.2.9 ,, ',
            'not-an-address'
        ];
        for(const forged of forgeries) {
            const res = await whoami(makeApp(), { 'X-Forwarded-For': forwardedChain(forged, EDGE) });
            expect(res.body.ip, forged).to.equal(EDGE);
        }
    });

    it('keys an IPv6 visitor on the appended entry', async function () {
        const v6 = '2001:db8::5';
        const res = await whoami(makeApp(), { 'X-Forwarded-For': `192.0.2.77, ${v6}, ${v6}` });
        expect(res.body.ip).to.equal(v6);
    });

    it('never reads CF-Connecting-IP itself', async function () {
        // Only Apache's appended XFF entry carries the visitor into Node, so a
        // forged CF-Connecting-IP with no proxy chain is inert.
        const res = await whoami(makeApp(), { 'CF-Connecting-IP': '192.0.2.77', 'X-Real-IP': '192.0.2.78' });
        expect(res.body.ip).to.match(LOOPBACK_PEER);
    });
});

describe('Security: Proxy spoofing: rate-limit buckets', function () {

    it('two forged values behind one appended entry share one bucket', async function () {
        const app = makeLimitedApp();
        const first  = await whoami(app, { 'X-Forwarded-For': forwardedChain('192.0.2.1', EDGE) });
        const second = await whoami(app, { 'X-Forwarded-For': forwardedChain('192.0.2.2', EDGE) });
        expect(first.status).to.equal(200);
        expect(second.status).to.equal(429);
    });

    it('a forged value matching another visitor does not borrow their bucket', async function () {
        const app = makeLimitedApp();
        const other = '203.0.113.60';
        const drained = await whoami(app, { 'X-Forwarded-For': forwardedChain(other, VISITOR) });
        const again   = await whoami(app, { 'X-Forwarded-For': forwardedChain(other, VISITOR) });
        // The real visitor sends no header: Cloudflare and Apache each append them.
        const real    = await whoami(app, { 'X-Forwarded-For': `${other}, ${other}` });
        expect(drained.status).to.equal(200);
        expect(again.status).to.equal(429);
        expect(real.status).to.equal(200);
    });
});

describe('Security: Proxy spoofing: WebSocket upgrade key', function () {

    it('resolves the same appended entry as HTTP for every forgery', function () {
        expect(wsClientIp({ 'x-forwarded-for': forwardedChain('192.0.2.77', VISITOR), 'cf-connecting-ip': VISITOR }))
            .to.equal(VISITOR);
        for(const forged of ['127.0.0.1', VISITOR, '192.0.2.1, 192.0.2.2'])
            expect(wsClientIp({ 'x-forwarded-for': forwardedChain(forged, EDGE) }), forged).to.equal(EDGE);
    });

    it('ignores a forged CF-Connecting-IP with no proxy chain', function () {
        expect(wsClientIp({ 'cf-connecting-ip': '192.0.2.77' })).to.equal('127.0.0.1');
    });
});
