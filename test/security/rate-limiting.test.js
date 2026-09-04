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

const apiSource = fs.readFileSync(
    path.join(__dirname, '../../src/api.js'),
    'utf8'
);

const explorerSource = fs.readFileSync(
    path.join(__dirname, '../../src/XChainExplorer.js'),
    'utf8'
);

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
        // express-rate-limit v7 renamed `max` to `limit`; api.js uses
        // `limit: parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || <default>`
        // assert the fallback default is sane. The ceiling is 1080 because that is
        // the measured requirement of a five-address wallet's worst minute with
        // retries and 3x headroom, not a round number picked for comfort; a default
        // above it would be room nothing on the wallet's path asked for.
        const match = apiSource.match(/limit:\s*.*?\|\|\s*(\d+)/) || apiSource.match(/max:\s*(\d+)/);
        expect(match).to.not.be.null;
        const maxRequests = parseInt(match[1], 10);
        expect(maxRequests).to.be.at.most(1080);
        expect(maxRequests).to.be.at.least(1);
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
});

describe('Security: Rate Limiting: CORS configuration', function () {

    it('CORS middleware is configured', function () {
        expect(apiSource).to.include('app.use(cors(');
    });

    it('allows only GET and POST methods', function () {
        expect(apiSource).to.include("methods: ['GET', 'POST']");
    });
});
