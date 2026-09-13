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
 * Security tests: Rate Limiting and Request Hardening
 *
 * Verifies body size limits, trust proxy configuration, and rate limiter settings.
 * Most assertions inspect the api.js source, because the app is built inside
 * startApi() and cannot be constructed here; the trust-proxy block is the
 * exception and drives real requests through the applyTrustProxy() seam, since
 * which X-Forwarded-For entry becomes req.ip is behaviour, not a spelling.
 *
 * Run: mocha test/security/rate-limiting.test.js --timeout 0
 */

'use strict';

const { expect }  = require('chai');
const fs          = require('fs');
const path        = require('path');
const express     = require('express');
const request     = require('supertest');
const { HTTP_TRUST_PROXY_HOPS, applyTrustProxy } = require('../../src/trustProxy.js');
const WebSocketServer = require('../../src/ws/WebSocketServer.js');
const staticMounts    = require('../../src/staticMounts.js');

const apiSource = fs.readFileSync(
    path.join(__dirname, '../../src/api.js'),
    'utf8'
);

const explorerSource = fs.readFileSync(
    path.join(__dirname, '../../src/XChainExplorer.js'),
    'utf8'
);

describe('Security: Rate Limiting: static-asset exemption', function () {

    // The exemption is the skip predicate for BOTH the per-IP rate limiter and the
    // global concurrency gate, so anything it exempts is unlimited. It matches the
    // first path segment, never a file extension, which describes the URL and not
    // what serves it: on a suffix test an attacker appends .png to an API path and
    // gets unbounded DB-backed search.

    it('exempts the two image mounts a page pulls in a burst', function () {
        const exempt = [
            '/images/favicon.ico',
            '/images/logos/BTC.svg',
            '/icon/BTC/XCP.png',
            '/icon'
        ];
        for(const p of exempt)
            expect(staticMounts.isStaticAssetPath(p), p).to.equal(true);
    });

    it('grants no exemption the shipped predicate did not already grant', function () {
        // The exemption set only ever narrows here. These mounts are real static
        // routes but were never exempt (no image extension), so they must stay
        // limited: widening would take shedding away from paths that have it.
        const stillLimited = [
            '/css/xchain.css',
            '/js/xchain.js',
            '/themes/dark/tokens.css',
            '/components/token-card/mount.js',
            '/fontawesome/css/all.min.css',
            '/fontawesome/webfonts/fa-solid-900.woff2'
        ];
        for(const p of stillLimited)
            expect(staticMounts.isStaticAssetPath(p), p).to.equal(false);
        // And `images` is in the express.static list, so the mount and the
        // exemption cannot drift apart.
        expect(staticMounts.STATIC_DIRECTORIES).to.include('images');
        for(const m of staticMounts.EXEMPT_MOUNTS)
            expect(m === 'icon' || staticMounts.STATIC_DIRECTORIES.includes(m), m).to.equal(true);
    });

    it('does not exempt an API path carrying an image suffix', function () {
        const limited = [
            '/BTC/api/search/needle.png',
            '/BTC/api/search/needle.png/token',
            '/BTC/api/blocks/1.svg',
            '/BTC/explorer/search/x.webp',
            '/BTC/api/address/x.ico'
        ];
        for(const p of limited)
            expect(staticMounts.isStaticAssetPath(p), p).to.equal(false);
    });

    it('matches the mount name exactly, never as a prefix', function () {
        // The old predicate used startsWith('/images'), so /imagesXYZ/... was exempt.
        expect(staticMounts.isStaticAssetPath('/imagesXYZ/BTC/api/search/q.png')).to.equal(false);
        expect(staticMounts.isStaticAssetPath('/iconography/BTC/api/search/q')).to.equal(false);
    });

    it('refuses a traversal that would borrow a mount exemption', function () {
        expect(staticMounts.isStaticAssetPath('/images/../BTC/api/search/needle')).to.equal(false);
    });

    it('is the predicate both guards actually use, from the one mount list', function () {
        // Source assertions: the app is built inside startApi() and cannot be
        // constructed here, so this pins the wiring the unit tests above cannot see.
        expect(apiSource).to.include("require('./staticMounts.js')");
        expect(apiSource).to.include('const isStaticAsset = staticMounts.isStaticAsset');
        expect(apiSource).to.match(/skip:\s*isStaticAsset,[\s\S]*skip:\s*isStaticAsset,/);
        expect(apiSource).to.not.match(/png\|jpg\|jpeg/);
        // One list: the express.static mounts read the same array the predicate does,
        // so a directory added to the explorer can never be silently rate-limited.
        expect(explorerSource).to.include("'static' : staticMounts.STATIC_DIRECTORIES");
    });
});

describe('Security: Rate Limiting: compute-bound route limiters', function () {

    it('the VM-call route carries its dedicated limiter', function () {
        expect(explorerSource).to.match(/contract\/:contractIndex\/call',\s*vmQueryLimiter/);
    });

    it('the merkle action-proof route carries its dedicated limiter', function () {
        // Proof recompute hashes every leaf in the target block per request;
        // without a route limiter it runs at the platform-wide 1080rpm default.
        expect(explorerSource).to.match(/proof\/action\/:actionIndex',\s*actionProofLimiter/);
        expect(explorerSource).to.include('EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM');
    });

    it('the balance-proof route carries the proof-tier limiter', function () {
        // Same single SMT descent as the contract-state and locked-balance proofs,
        // so it belongs at the proof cap; it sat at the platform default as a leftover.
        expect(explorerSource).to.match(/proof\/balance\/:address\/:tick',\s*actionProofLimiter/);
    });

    it('the checkpoint list and range routes carry the checkpoint-list limiter', function () {
        expect(explorerSource).to.match(/api\/checkpoints',\s*checkpointListLimiter/);
        expect(explorerSource).to.match(/api\/checkpoints\/range',\s*checkpointListLimiter/);
        expect(explorerSource).to.include('EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM');
    });

    it('the checkpoint verify route carries its own tighter limiter', function () {
        // Verify runs Ed25519 once per signature over the qualifying validator set
        // and is reachable from a button on the checkpoint detail page, so it must
        // not share the looser list cap.
        expect(explorerSource).to.match(/checkpoint\/:blockIndex\/verify',\s*checkpointVerifyLimiter/);
        expect(explorerSource).to.include('EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM');
    });

    it('the three fee routes carry the fee-quote limiter', function () {
        // Each is a JSON-RPC round trip into the colocated indexer, and the fees page
        // puts a clickable quote sandbox on top of them.
        expect(explorerSource).to.match(/api\/feequote',\s*feeQuoteLimiter/);
        expect(explorerSource).to.match(/api\/oraclefeequote',\s*feeQuoteLimiter/);
        expect(explorerSource).to.match(/api\/feeschedule',\s*feeQuoteLimiter/);
        expect(explorerSource).to.include('EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM');
    });
});

describe('Security: Rate Limiting: Body size limit', function () {

    it('express.json() has explicit body size limit', function () {
        expect(apiSource).to.include("express.json({ limit:");
    });

    it('body size limit is 10kb or less', function () {
        const match = apiSource.match(/express\.json\(\{\s*limit:\s*'(\d+)kb'/);
        expect(match).to.not.be.null;
        const limitKb = parseInt(match[1], 10);
        expect(limitKb).to.be.at.most(100);
    });
});

describe('Security: Rate Limiting: Trust proxy', function () {

    // Behavioural, not a source grep: applyTrustProxy() is the seam api.js calls,
    // so the hop policy is exercised here against a real request rather than
    // matched as text. What is being pinned is which X-Forwarded-For entry
    // becomes req.ip, because req.ip is the per-IP rate limiters' bucket key.
    function makeApp() {
        const app = express();
        applyTrustProxy(app);
        app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
        return app;
    }

    it('takes the entry the proxy appended, not the client-supplied one', async function () {
        // Apache appends the connection's peer to the RIGHT of whatever the caller
        // sent, so the rightmost entry is the only one the explorer did not receive
        // from the caller. A caller who sends their own XFF prepends to the left and
        // must not move their own bucket.
        const res = await request(makeApp())
            .get('/whoami')
            .set('X-Forwarded-For', '203.0.113.9, 198.51.100.7');
        expect(res.body.ip).to.equal('198.51.100.7');
    });

    it('falls back to the socket address with no X-Forwarded-For', async function () {
        const res = await request(makeApp()).get('/whoami');
        expect(res.body.ip).to.match(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
    });

    it('trusts exactly one hop, as the number 1 and not boolean true', function () {
        // `true` trusts the whole chain, so any caller could spoof their way into a
        // fresh rate-limit bucket per request (express-rate-limit's
        // ERR_ERL_PERMISSIVE_TRUST_PROXY). The value must stay numeric.
        expect(HTTP_TRUST_PROXY_HOPS).to.equal(1);
        const setting = makeApp().get('trust proxy');
        expect(setting).to.equal(1);
        expect(setting).to.not.equal(true);
    });

    it('the WebSocket upgrade path resolves the same entry as HTTP', function () {
        // Express's trust-proxy setting does not apply to the raw HTTP server the
        // upgrade is handled on, so WebSocketServer resolves the address by hand.
        // If the two ever disagreed, the per-IP connection cap and the per-IP request
        // limiter would be counting different clients.
        const ws  = new WebSocketServer({ trustProxyHops: 1 });
        const req = {
            headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
            socket:  { remoteAddress: '127.0.0.1' }
        };
        expect(ws._clientIp(req)).to.equal('198.51.100.7');
    });

    it('the WebSocket path falls back to the socket address with no header', function () {
        const ws = new WebSocketServer({ trustProxyHops: 1 });
        expect(ws._clientIp({ headers: {}, socket: { remoteAddress: '203.0.113.42' } }))
            .to.equal('203.0.113.42');
    });

    it('the WebSocket path ignores X-Forwarded-For entirely at zero hops', function () {
        // Zero trusted hops is the no-proxy deployment: the header is caller-supplied
        // in full and carries no trusted entry at all.
        const ws = new WebSocketServer({ trustProxyHops: 0 });
        const req = {
            headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
            socket:  { remoteAddress: '10.1.2.3' }
        };
        expect(ws._clientIp(req)).to.equal('10.1.2.3');
    });
});

describe('Security: Rate Limiting: Rate limiter config', function () {

    it('rate limiter is configured', function () {
        expect(apiSource).to.include('rateLimit(');
    });

    it('uses standard headers', function () {
        expect(apiSource).to.include('standardHeaders: true');
    });

    it('disables legacy headers', function () {
        expect(apiSource).to.match(/legacyHeaders:\s+false/);
    });

    it('has a window of 60 seconds', function () {
        expect(apiSource).to.include('60 * 1000');
    });

    it('has max requests configured', function () {
        // The app-wide ceiling is resolved from its knob, so the assertion reads
        // the resolution itself (`parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10)
        // || <default>`) wherever api.js puts it, rather than a `limit:` line that
        // happens to carry `||` on the same line: the old shape passed only while
        // the ceiling stayed inline in the limiter's options, and any other way of
        // resolving it would have matched nothing. The default is 1080 because that
        // is the measured requirement of a five-address wallet's worst minute with
        // retries and 3x headroom, not a round number picked for comfort; a default
        // above it would be room nothing on the wallet's path asked for, and one
        // below it would refuse an honest wallet. rate-limit-pins.test.js holds the
        // same number against the deploy drop-in.
        const resolved = apiSource.match(/parseInt\(process\.env\.EXPLORER_RATE_LIMIT_RPM,\s*10\)\s*\|\|\s*(\d+)/g) || [];
        expect(resolved, 'exactly one resolution of the app-wide ceiling').to.have.lengthOf(1);
        const maxRequests = parseInt(resolved[0].match(/\|\|\s*(\d+)/)[1], 10);
        expect(maxRequests).to.equal(1080);
    });
});

describe('Security: Rate Limiting: Helmet configuration', function () {

    it('helmet is enabled', function () {
        expect(apiSource).to.include('app.use(helmet(');
    });

    it('CSP is configured', function () {
        expect(apiSource).to.include('contentSecurityPolicy');
    });

    it('object-src is set to none', function () {
        expect(apiSource).to.include("objectSrc:   [\"'none'\"]");
    });

    it('media-src is declared (the sandboxed custom-content srcdoc frame inherits this CSP)', function () {
        // Without an explicit media-src, default-src 'self' refuses every external
        // <video>/<audio> source, both on the token page itself and inside the srcdoc
        // custom-content frame, which has no origin of its own and inherits the page
        // policy. Same shape as img-src: https origins only, no data:/blob:.
        expect(apiSource).to.match(/mediaSrc:\s*\["'self'",\s*"https:"\]/);
        expect(apiSource).to.not.match(/mediaSrc:[^\n]*(data:|blob:|\*)/);
    });

    it('frame-src admits any https origin (token custom content embeds third-party iframes)', function () {
        // A token's TIS `html` may wrap an <iframe> to its own site; the sandboxed
        // srcdoc frame inherits this policy, so a host allowlist blanks every such
        // token. https only, like img-src and media-src: no data:/blob:,
        // no http:, no bare wildcard.
        expect(apiSource).to.match(/frameSrc:\s*\["'self'",\s*"https:"\]/);
        expect(apiSource).to.not.match(/frameSrc:[^\n]*(data:|blob:|http:|\*)/);
    });
});

describe('Security: Rate Limiting: CORS configuration', function () {

    it('CORS middleware is configured', function () {
        expect(apiSource).to.include('app.use(cors(');
    });

    it('allows only GET and POST methods', function () {
        expect(apiSource).to.include("methods: ['GET', 'POST']");
    });
});
