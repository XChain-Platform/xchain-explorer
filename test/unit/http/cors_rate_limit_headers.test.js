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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const request    = require('supertest');

const { applyCors } = require('../../../src/http/api_boot/cors.js');

const EXPOSED_RATE_LIMIT_HEADERS =
    'Retry-After,RateLimit-Policy,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset';

function makeApp(){
    const app = express();
    applyCors(app, { env: {} });
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           1,
        standardHeaders: true,
        legacyHeaders:   false
    }));
    app.get('/ping', (req, res) => res.json({ ok: true }));
    return app;
}

describe('HTTP CORS rate-limit headers', function () {

    it('exposes rate-limit headers on normal and rate-limited responses', async function () {
        const app = makeApp();
        const normal = await request(app)
            .get('/ping')
            .set('Origin', 'https://wallet.example')
            .expect(200);
        const refused = await request(app)
            .get('/ping')
            .set('Origin', 'https://wallet.example')
            .expect(429);

        expect(normal.headers['access-control-allow-origin']).to.equal('https://wallet.example');
        expect(normal.headers['access-control-expose-headers']).to.equal(EXPOSED_RATE_LIMIT_HEADERS);
        expect(normal.headers['ratelimit-limit']).to.equal('1');

        expect(refused.headers['access-control-allow-origin']).to.equal('https://wallet.example');
        expect(refused.headers['access-control-expose-headers']).to.equal(EXPOSED_RATE_LIMIT_HEADERS);
        expect(refused.headers['retry-after']).to.exist;
        expect(refused.headers['ratelimit-limit']).to.equal('1');
    });
});
