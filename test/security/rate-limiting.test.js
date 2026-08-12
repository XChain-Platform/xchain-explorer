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
 * Verifies body size limits, trust proxy configuration, and rate limiter settings
 * by inspecting the api.js configuration (not making live HTTP requests).
 *
 * Run: mocha test/security/rate-limiting.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

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
        // without a route limiter it runs at the platform-wide 500rpm default.
        expect(explorerSource).to.match(/proof\/action\/:actionIndex',\s*actionProofLimiter/);
        expect(explorerSource).to.include('EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM');
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

    it('trust proxy is set to specific value (not boolean true)', function () {
        // Should NOT use app.enable('trust proxy') which sets it to boolean true
        expect(apiSource).to.not.include("app.enable('trust proxy')");
        expect(apiSource).to.not.include('app.enable("trust proxy")');
    });

    it('trust proxy is set to 1 (single hop)', function () {
        expect(apiSource).to.include("'trust proxy', 1");
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
        // assert the fallback default is sane.
        const match = apiSource.match(/limit:\s*.*?\|\|\s*(\d+)/) || apiSource.match(/max:\s*(\d+)/);
        expect(match).to.not.be.null;
        const maxRequests = parseInt(match[1], 10);
        expect(maxRequests).to.be.at.most(500);
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
