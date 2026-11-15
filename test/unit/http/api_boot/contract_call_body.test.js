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
 *
 * The contract-call route's own body ceiling: the global 10kb parser skips it,
 * and the ceiling is sized from the validator's own limits, so a body the
 * validator would accept is never refused by the parser first.
 *
 ********************************************************************/

'use strict';

const { expect }  = require('chai');
const express     = require('express');
const rateLimit   = require('express-rate-limit');
const supertest   = require('supertest');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const { methods, CONTRACT_CALL_BODY_LIMIT } = require('../../../../src/explorer/mount.js');
const { applyJsonBody, applyBodyErrorHandler } = require('../../../../src/http/api_boot/json_body.js');
const { MAX_PARAMS, MAX_PARAM_BYTES } = require('../../../../src/contract/vm_query.js');

const CALL_PATH = '/RBTC/api/contract/7/call';

// Each control byte is one byte to the validator and a 6-byte \u00XX escape on the wire.
const WORST_LEGAL = JSON.stringify({
    method: 'm', params: Array.from({ length: MAX_PARAMS }, () => '\u0001'.repeat(MAX_PARAM_BYTES))
});

// The ceiling is spelled in kb; body-parser reads 1kb as 1024 bytes.
const LIMIT_BYTES = parseInt(CONTRACT_CALL_BODY_LIMIT, 10) * 1024;

function jsonOfLength(n){
    return '{"pad":"' + 'x'.repeat(n - 10) + '"}';
}

// The real mount method on a real express app behind the real global parser step.
function bootApp(explorerStatics){
    const app = express();
    applyJsonBody(app, explorerStatics);
    const seen = [];
    const host = {
        express,
        rateLimit,
        limitedHandler: () => (req, res) => res.status(429).json({ code: 'RATE_LIMITED' }),
        configEnv: () => ({})
    };
    const ctx = { app, processContractCallRequest: (req, res) => { seen.push(req.body); res.json({ params: req.body.params.length }); } };
    methods.mountContractCallRoute.call(ctx, host);
    app.post('/:coin/api/balances', (req, res) => res.json({ ok: true }));
    applyBodyErrorHandler(app);
    return { app, seen };
}

describe('contract-call body ceiling', function () {
    it('sizes the ceiling above the worst body the validator accepts', function () {
        expect(Buffer.byteLength(WORST_LEGAL)).to.be.greaterThan(MAX_PARAMS * MAX_PARAM_BYTES * 5);
        expect(Buffer.byteLength(WORST_LEGAL)).to.be.lessThan(LIMIT_BYTES);
    });

    it('accepts the worst legal body through the route parser', async function () {
        const { app, seen } = bootApp(XChainExplorer);
        const res = await supertest(app).post(CALL_PATH).set('Content-Type', 'application/json').send(WORST_LEGAL);
        expect(res.status).to.equal(200);
        expect(res.body.params).to.equal(MAX_PARAMS);
        expect(seen[0].params[0]).to.have.length(MAX_PARAM_BYTES);
    });

    it('refuses a body over its own ceiling with 413 BODY_TOO_LARGE', async function () {
        const { app } = bootApp(XChainExplorer);
        const res = await supertest(app).post(CALL_PATH).set('Content-Type', 'application/json')
            .send(jsonOfLength(LIMIT_BYTES + 1));
        expect(res.status).to.equal(413);
        expect(res.body.code).to.equal('BODY_TOO_LARGE');
    });

    it('leaves every other POST route on the 10kb global ceiling', async function () {
        const { app } = bootApp(XChainExplorer);
        const res = await supertest(app).post('/RBTC/api/balances').set('Content-Type', 'application/json')
            .send(jsonOfLength(20 * 1024));
        expect(res.status).to.equal(413);
        expect(res.body.code).to.equal('BODY_TOO_LARGE');
    });

    it('control: the global parser alone refuses the same worst legal body', async function () {
        const noSkip = { isPreflightPostRequest: () => false, isFeeQuotePostRequest: () => false, isContractCallPostRequest: () => false };
        const { app } = bootApp(noSkip);
        const res = await supertest(app).post(CALL_PATH).set('Content-Type', 'application/json').send(WORST_LEGAL);
        expect(res.status).to.equal(413);
    });
});

describe('contract-call route wiring', function () {
    it('registers the limiter, then the 256kb parser, then the handler', function () {
        const calls = [];
        const limiter = () => {};
        const parser = () => {};
        const host = {
            express: { json: (o) => { parser.opts = o; return parser; } },
            rateLimit: () => limiter,
            limitedHandler: () => () => {},
            configEnv: () => ({})
        };
        methods.mountContractCallRoute.call({ app: { post: (...a) => calls.push(a) }, processContractCallRequest() {} }, host);
        expect(calls).to.have.length(1);
        const [route, ...chain] = calls[0];
        expect(route).to.equal('/:coin/api/contract/:contractIndex/call');
        expect(chain).to.have.length(3);
        expect(chain[0]).to.equal(limiter);
        expect(chain[1]).to.equal(parser);
        expect(parser.opts).to.deep.equal({ limit: CONTRACT_CALL_BODY_LIMIT });
        expect(CONTRACT_CALL_BODY_LIMIT).to.equal('256kb');
    });
});

describe('isContractCallPostRequest', function () {
    const yes = (method, path) => XChainExplorer.isContractCallPostRequest({ method, path });

    it('matches only POST /{coin}/api/contract/{idx}/call', function () {
        expect(yes('POST', '/RBTC/api/contract/7/call')).to.equal(true);
        expect(yes('post', '/RBTC/api/contract/7/call/')).to.equal(true);
        expect(yes('GET', CALL_PATH)).to.equal(false);
        expect(yes('POST', '/RBTC/api/contract/7')).to.equal(false);
        expect(yes('POST', '/RBTC/api/contract/7/call/x')).to.equal(false);
        expect(yes('POST', '/RBTC/api/preflight')).to.equal(false);
        expect(yes('POST', '/a/RBTC/api/contract/7/call')).to.equal(false);
    });

    it('is total over malformed input (it runs on every request)', function () {
        expect(XChainExplorer.isContractCallPostRequest(null)).to.equal(false);
        expect(XChainExplorer.isContractCallPostRequest({})).to.equal(false);
    });
});
