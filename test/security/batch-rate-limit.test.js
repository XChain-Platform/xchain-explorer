'use strict';

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
 * Security tests: the batch endpoints' rate limiter
 *
 * The two batch POSTs are the only unauthenticated explorer surface where one
 * request buys up to twenty database reads plus twenty tracker fan-outs, so
 * the app-wide per-IP ceiling is the wrong instrument: it counts requests, and
 * the whole point of the endpoint is that one request now carries twenty. The
 * dedicated bucket is what keeps the multiplier bounded, and both routes share
 * it because a wallet's balance beat and its coinpay badge are two callers of
 * one wallet.
 *
 * Three things are worth pinning and all three are silent when broken:
 * the ceiling the source resolves (an env knob read in a shape the pins test
 * cannot see would ship unpinnable), the drop-in pin agreeing with it, and the
 * refusal itself still answering 429 with the JSON body and the draft headers
 * a client needs to back off. The last is driven against the real library.
 *
 * Run: mocha test/security/batch-rate-limit.test.js --timeout 5000 --exit
 *********************************************************************/

const { expect }   = require('chai');
const fs           = require('fs');
const path         = require('path');
const express      = require('express');
const rateLimit    = require('express-rate-limit');
const request      = require('supertest');
const proxyquire   = require('proxyquire').noCallThru();
const { limitedHandler }       = require('../../src/rateLimitLog.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const CONF_PATH      = path.join(__dirname, '../../deploy/rate-limits.conf');
const explorerSource = fs.readFileSync(path.join(__dirname, '../../src/XChainExplorer.js'), 'utf8');
const confText       = fs.readFileSync(CONF_PATH, 'utf8');

const WINDOW_MS     = 60 * 1000;
const BATCH_DEFAULT = 72;

/**
 * Construct the explorer with express-rate-limit and the counter-line module
 * replaced by recorders, and hand back what the BATCH limiter was actually
 * built with. Nothing is asserted from source text here: the numbers come from
 * the options object the service passed the library.
 */
function buildBatchLimiter(env) {
    const created = [];
    const rateLimitStub = (options) => {
        const middleware = (req, res, next) => next();
        middleware._options = options;
        created.push({ options, middleware });
        return middleware;
    };
    const rateLimitLogStub = {
        limitedHandler: (policy) => {
            const handler = () => {};
            handler._policy = policy;
            return handler;
        }
    };
    const registrations = [];
    const mockApp = {
        use:    () => {},
        enable: () => {},
        get:    () => {},
        post:   (routePath, ...handlers) => { registrations.push({ path: routePath, handlers }); }
    };
    const expressMock  = () => mockApp;
    expressMock.static = () => {};
    expressMock.json   = () => {};

    class MockDB {
        constructor() {}
        async init() {}
        getMaxMethodResults() { return 100; }
        async getData() { return [null, null]; }
    }

    const previous = process.env.EXPLORER_BATCH_RATE_LIMIT_RPM;
    if (env === undefined) delete process.env.EXPLORER_BATCH_RATE_LIMIT_RPM;
    else process.env.EXPLORER_BATCH_RATE_LIMIT_RPM = env;

    let built;
    try {
        const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
            'express':            expressMock,
            './db.js':            MockDB,
            'express-rate-limit': rateLimitStub,
            './rateLimitLog.js':  rateLimitLogStub
        });
        new XChainExplorer(mockApp, createConfigInfoStub());
        built = created.find((c) => c.options.handler && c.options.handler._policy
                                 && c.options.handler._policy.name === 'batch');
    } finally {
        if (previous === undefined) delete process.env.EXPLORER_BATCH_RATE_LIMIT_RPM;
        else process.env.EXPLORER_BATCH_RATE_LIMIT_RPM = previous;
    }

    return { built, registrations };
}

describe('Security: batch endpoints: the limiter the service builds (row 51, C54)', function () {

    it('builds a limiter named batch, so its refusal line points at one knob', function () {
        const { built } = buildBatchLimiter(undefined);
        expect(built, 'no limiter with the batch counter-line name was built').to.not.be.undefined;
        expect(built.options.handler._policy.envVar).to.equal('EXPLORER_BATCH_RATE_LIMIT_RPM');
        expect(built.options.handler._policy.service).to.equal('Explorer');
    });

    it('enforces 72 per minute with nothing configured', function () {
        const { built } = buildBatchLimiter(undefined);
        expect(built.options.limit).to.equal(BATCH_DEFAULT);
        expect(built.options.windowMs).to.equal(WINDOW_MS);
    });

    it('enforces the number an operator sets in the env knob', function () {
        const { built } = buildBatchLimiter('5');
        expect(built.options.limit).to.equal(5);
    });

    it('logs the same ceiling it enforces, so a raised knob is not reported as the default', function () {
        const { built } = buildBatchLimiter('5');
        expect(built.options.handler._policy.limit).to.equal(5);
    });

    it('sends the draft headers and no legacy ones', function () {
        const { built } = buildBatchLimiter(undefined);
        expect(built.options.standardHeaders).to.equal(true);
        expect(built.options.legacyHeaders).to.equal(false);
    });

    it('puts that one limiter on BOTH batch routes, so they share a bucket', function () {
        const { built, registrations } = buildBatchLimiter(undefined);
        const batchRoutes = registrations.filter(
            (r) => r.path === '/:coin/api/balances' || r.path === '/:coin/api/coinpay_obligations');
        expect(batchRoutes, 'both batch routes must be registered').to.have.lengthOf(2);
        for (const route of batchRoutes)
            expect(route.handlers[0], `${route.path} does not carry the batch limiter`)
                .to.equal(built.middleware);
    });

    it('answers through the counter-line handler, never a bare message option', function () {
        // `message` and a custom `handler` are alternatives in express-rate-limit 8:
        // a limiter that kept `message` would refuse without ever logging a line.
        const { built } = buildBatchLimiter(undefined);
        expect(built.options).to.not.have.property('message');
        expect(built.options.handler._policy.message)
            .to.deep.equal({ error: 'Too many batch requests', code: 'RATE_LIMITED' });
    });
});

describe('Security: batch endpoints: the refusal, driven through express-rate-limit 8 (row 51)', function () {

    // The refusal is built here from the same policy shape the service uses and
    // driven through the real library, so the assertions are about what a client
    // receives rather than about the options object.
    function appAtLimit(limit, lines) {
        const policy = {
            limit,
            envVar:   'EXPLORER_BATCH_RATE_LIMIT_RPM',
            windowMs: WINDOW_MS,
            message:  { error: 'Too many batch requests', code: 'RATE_LIMITED' }
        };
        const app = express();
        app.use(express.json({ limit: '10kb' }));
        app.use(rateLimit({
            windowMs:        policy.windowMs,
            limit:           policy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler(Object.assign({
                service: 'Explorer',
                name:    'batch',
                log:     (line) => lines.push(line)
            }, policy))
        }));
        app.post('/BTC/api/balances', (req, res) => res.json({ ok: true }));
        app.post('/BTC/api/coinpay_obligations', (req, res) => res.json({ ok: true }));
        return app;
    }

    it('refuses the third POST at a limit of two, with the batch JSON body', async function () {
        const lines = [];
        const app   = appAtLimit(2, lines);
        const body  = { addresses: ['addrOne'] };

        await request(app).post('/BTC/api/balances').send(body).expect(200);
        await request(app).post('/BTC/api/balances').send(body).expect(200);
        const refused = await request(app).post('/BTC/api/balances').send(body).expect(429);

        expect(refused.body).to.deep.equal({ error: 'Too many batch requests', code: 'RATE_LIMITED' });
        expect(refused.headers['ratelimit-policy'], 'the draft policy header is the watchdog\'s tell for an ORIGIN refusal').to.exist;
        expect(refused.headers['retry-after']).to.exist;
        expect(refused.headers['ratelimit-limit']).to.equal('2');
        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.contain('[batch]');
        expect(lines[0]).to.contain('(limit 2/60 s)');
    });

    it('spends one bucket across both batch routes, not one each', async function () {
        const app  = appAtLimit(2, []);
        const body = { addresses: ['addrOne'] };

        await request(app).post('/BTC/api/balances').send(body).expect(200);
        await request(app).post('/BTC/api/coinpay_obligations').send(body).expect(200);
        // Third request on either route is over the shared ceiling of two.
        await request(app).post('/BTC/api/coinpay_obligations').send(body).expect(429);
    });
});

describe('Security: batch endpoints: the knob is pinnable and pinned (row 51, D69)', function () {

    it('reads the knob in the shape the pins test scans for', function () {
        // The drop-in guarantee rests on rate-limit-pins.test.js finding every
        // knob the source reads; a ceiling resolved any other way is unpinnable
        // and nothing else would notice.
        const reads = [...explorerSource.matchAll(
            /parseInt\(process\.env\.(EXPLORER_BATCH_RATE_LIMIT_RPM),\s*10\)\s*\|\|\s*(\d+)/g)];
        expect(reads, 'EXPLORER_BATCH_RATE_LIMIT_RPM is not read in the pinnable shape').to.have.lengthOf(1);
        expect(parseInt(reads[0][2], 10)).to.equal(BATCH_DEFAULT);
    });

    it('pins the knob in deploy/rate-limits.conf at the source default', function () {
        const pin = confText.match(/^Environment=EXPLORER_BATCH_RATE_LIMIT_RPM=(\d+)\s*$/m);
        expect(pin, 'EXPLORER_BATCH_RATE_LIMIT_RPM is not pinned in deploy/rate-limits.conf').to.not.be.null;
        expect(parseInt(pin[1], 10)).to.equal(BATCH_DEFAULT);
    });

    it('explains in the drop-in what the pin bounds', function () {
        // An operator reading the file to size the knob needs the derivation, not
        // just the number; every other pin here carries one.
        expect(confText).to.contain('EXPLORER_BATCH_RATE_LIMIT_RPM bounds the two batch POSTs');
    });
});
