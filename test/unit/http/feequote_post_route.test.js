'use strict';

// POST /:coin/api/feequote: mounted with its own limiter ahead of a route-level body
// parser at the preflight ceiling, and exempted from the tight global json() parser.

const { expect } = require('chai');
const sinon = require('sinon');
const XChainExplorer = require('../../../src/XChainExplorer.js');
const mount = require('../../../src/explorer/mount.js');
const { applySecurityHeaders } = require('../../../src/http/api_boot/security_headers.js');

describe('POST /:coin/api/feequote mount', function () {
    function mountWith(limiter) {
        const calls = [];
        const express = { json: sinon.stub().returns('PARSER') };
        const ctx = { app: { post: (...a) => calls.push(a) }, processFeeQuoteRequest: sinon.stub() };
        const host = { express, rateLimit: () => limiter, limitedHandler: () => () => {}, configEnv: () => ({}) };
        mount.methods.mountFeeQuotePostRoute.call(ctx, host);
        return { calls, express, ctx };
    }

    it('registers the route with limiter, then the preflight-ceiling parser, then the handler', function () {
        const { calls, express, ctx } = mountWith('LIMITER');
        expect(calls).to.have.length(1);
        const [path, limiter, parser, handler] = calls[0];
        expect(path).to.equal('/:coin/api/feequote');
        expect(limiter).to.equal('LIMITER');
        expect(parser).to.equal('PARSER');
        expect(express.json.firstCall.args[0]).to.deep.equal({ limit: mount.PREFLIGHT_BODY_LIMIT });
        handler({}, {});
        expect(ctx.processFeeQuoteRequest.calledOnce).to.equal(true);
    });

    it('skips the global 10kb parser for this path only', function () {
        const used = [];
        const app = { use: (fn) => used.push(fn) };
        applySecurityHeaders(app, { env: () => ({}) }, XChainExplorer);
        const gate = used[used.length - 1];
        let passed = false;
        gate({ method: 'POST', path: '/RBTC/api/feequote' }, {}, () => { passed = true; });
        expect(passed).to.equal(true);
    });
});
