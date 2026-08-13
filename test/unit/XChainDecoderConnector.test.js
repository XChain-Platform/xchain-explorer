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
 * Unit tests for src/XChainDecoderConnector.js: the minimal JSON-RPC client
 * /api/status uses to aggregate each decoder's self-reported chain→decoder lag.
 */

'use strict';

const sinon    = require('sinon');
const axios    = require('axios');
const { expect } = require('chai');
const XChainDecoderConnector = require('../../src/XChainDecoderConnector.js');
const { resolveDecoderUrl }  = require('../../src/XChainDecoderConnector.js');

describe('XChainDecoderConnector', function () {

    const ENV_KEYS = ['DECODER_API_URL_BTC_REGTEST', 'DECODER_API_URL', 'DECODER_API_TIMEOUT_MS'];
    let saved;

    beforeEach(function () {
        saved = {};
        for (let k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(function () {
        for (let k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    describe('resolveDecoderUrl()', function () {
        it('prefers the coin+network-specific override', function () {
            process.env.DECODER_API_URL_BTC_REGTEST = 'http://specific:1';
            process.env.DECODER_API_URL             = 'http://generic:2';
            expect(resolveDecoderUrl('btc', 'regtest')).to.equal('http://specific:1');
        });

        it('falls back to the generic DECODER_API_URL', function () {
            process.env.DECODER_API_URL = 'http://generic:2';
            expect(resolveDecoderUrl('BTC', 'regtest')).to.equal('http://generic:2');
        });

        it('returns null when nothing is configured', function () {
            expect(resolveDecoderUrl('BTC', 'mainnet')).to.be.null;
        });

        // XC-1260: the config-derived per-chain endpoint is what makes decoder
        // health readable on a deployment that never exported an env var per chain.
        it('uses the config-derived endpoint when no env var is set', function () {
            expect(resolveDecoderUrl('BTC', 'mainnet', 'http://from-config:3002')).to.equal('http://from-config:3002');
        });

        it('lets the coin+network-specific override beat the config-derived endpoint', function () {
            process.env.DECODER_API_URL_BTC_REGTEST = 'http://specific:1';
            expect(resolveDecoderUrl('BTC', 'regtest', 'http://from-config:3002')).to.equal('http://specific:1');
        });

        it('prefers the config-derived endpoint over the GENERIC env var', function () {
            // The generic var names one decoder for every coin, so it is right for
            // at most one chain on a multi-chain deployment; the config endpoint is
            // resolved per coin/network.
            process.env.DECODER_API_URL = 'http://generic:2';
            expect(resolveDecoderUrl('BTC', 'mainnet', 'http://from-config:3002')).to.equal('http://from-config:3002');
        });

        it('falls back to the generic env var when the config carries no endpoint', function () {
            process.env.DECODER_API_URL = 'http://generic:2';
            expect(resolveDecoderUrl('BTC', 'mainnet', null)).to.equal('http://generic:2');
        });

        it('does not build a half-formed env key from an unparseable coin code', function () {
            // A code the caller could not split into coin+network must not read
            // DECODER_API_URL__; it falls straight through to the later steps.
            process.env.DECODER_API_URL = 'http://generic:2';
            expect(resolveDecoderUrl(null, null, null)).to.equal('http://generic:2');
            expect(resolveDecoderUrl(null, null, 'http://from-config:3002')).to.equal('http://from-config:3002');
        });
    });

    describe('constructor', function () {
        it('defaults the timeout to 2500ms (status hot path)', function () {
            const c = new XChainDecoderConnector('http://x');
            expect(c.timeout).to.equal(2500);
        });

        it('honours DECODER_API_TIMEOUT_MS', function () {
            process.env.DECODER_API_TIMEOUT_MS = '900';
            const c = new XChainDecoderConnector('http://x');
            expect(c.timeout).to.equal(900);
        });
    });

    describe('health()', function () {
        it('POSTs a JSON-RPC health call and returns the result', async function () {
            const post = sinon.stub(axios, 'post').resolves({
                data: { result: { status: 'healthy', chainTipBlock: 900123, blockLag: 2 } }
            });
            const c = new XChainDecoderConnector('http://decoder:3001');
            const h = await c.health();
            expect(h).to.deep.equal({ status: 'healthy', chainTipBlock: 900123, blockLag: 2 });
            expect(post.firstCall.args[0]).to.equal('http://decoder:3001');
            expect(post.firstCall.args[1]).to.include({ method: 'health' });
        });

        it('throws on a JSON-RPC error response', async function () {
            sinon.stub(axios, 'post').resolves({ data: { error: { message: 'down' } } });
            const c = new XChainDecoderConnector('http://decoder:3001');
            let err = null;
            try { await c.health(); } catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.equal('down');
        });

        it('returns null when the response has no result', async function () {
            sinon.stub(axios, 'post').resolves({ data: {} });
            const c = new XChainDecoderConnector('http://decoder:3001');
            expect(await c.health()).to.be.null;
        });
    });
});
