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
 * Unit tests for src/XChainIndexerConnector.js: the minimal JSON-RPC client
 * the explorer uses to proxy read-only fee endpoints to the colocated indexer.
 */

'use strict';

const sinon    = require('sinon');
const axios    = require('axios');
const { expect } = require('chai');
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js');
const { resolveIndexerUrl }  = require('../../src/XChainIndexerConnector.js');

describe('XChainIndexerConnector', function () {

    const ENV_KEYS = ['INDEXER_API_URL_BTC_REGTEST', 'INDEXER_API_URL', 'INDEXER_API_TIMEOUT_MS'];
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

    // -----------------------------------------------------------------
    // resolveIndexerUrl()
    // -----------------------------------------------------------------

    describe('resolveIndexerUrl()', function () {
        it('prefers the coin+network-specific override', function () {
            process.env.INDEXER_API_URL_BTC_REGTEST = 'http://specific:1';
            process.env.INDEXER_API_URL             = 'http://generic:2';
            expect(resolveIndexerUrl('btc', 'regtest')).to.equal('http://specific:1');
        });

        it('falls back to the generic URL', function () {
            process.env.INDEXER_API_URL = 'http://generic:2';
            expect(resolveIndexerUrl('LTC', 'mainnet')).to.equal('http://generic:2');
        });

        it('returns null when nothing is configured', function () {
            expect(resolveIndexerUrl('BTC', 'regtest')).to.equal(null);
        });

        it('tolerates missing coin/network args', function () {
            expect(resolveIndexerUrl()).to.equal(null);
        });
    });

    // -----------------------------------------------------------------
    // constructor
    // -----------------------------------------------------------------

    describe('constructor', function () {
        it('stores the url and a default 5s timeout', function () {
            let c = new XChainIndexerConnector('http://x:1');
            expect(c.url).to.equal('http://x:1');
            expect(c.timeout).to.equal(5000);
        });

        it('honours INDEXER_API_TIMEOUT_MS', function () {
            process.env.INDEXER_API_TIMEOUT_MS = '1234';
            let c = new XChainIndexerConnector('http://x:1');
            expect(c.timeout).to.equal(1234);
        });
    });

    // -----------------------------------------------------------------
    // _call() / feequote() / feeschedule()
    // -----------------------------------------------------------------

    describe('JSON-RPC calls', function () {
        it('_call posts a JSON-RPC envelope and returns the result', async function () {
            let post = sinon.stub(axios, 'post').resolves({ data: { result: { ok: 1 } } });
            let c = new XChainIndexerConnector('http://x:1');
            let r = await c._call('m', { a: 1 });
            expect(r).to.deep.equal({ ok: 1 });
            let [url, body, opts] = post.getCall(0).args;
            expect(url).to.equal('http://x:1');
            expect(body).to.include({ jsonrpc: '2.0', method: 'm', id: 1 });
            expect(body.params).to.deep.equal({ a: 1 });
            expect(opts.timeout).to.equal(5000);
        });

        it('_call throws on a JSON-RPC error payload', async function () {
            sinon.stub(axios, 'post').resolves({ data: { error: { message: 'boom' } } });
            let c = new XChainIndexerConnector('http://x:1');
            try { await c._call('m', {}); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.equal('boom'); }
        });

        it('_call throws a generic message when the error payload has none', async function () {
            sinon.stub(axios, 'post').resolves({ data: { error: {} } });
            let c = new XChainIndexerConnector('http://x:1');
            try { await c._call('m', {}); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.equal('indexer error'); }
        });

        it('_call returns null when the response has no result', async function () {
            sinon.stub(axios, 'post').resolves({ data: {} });
            let c = new XChainIndexerConnector('http://x:1');
            expect(await c._call('m', {})).to.equal(null);
        });

        it('feequote delegates to _call with the feequote method + args', async function () {
            let c = new XChainIndexerConnector('http://x:1');
            let call = sinon.stub(c, '_call').resolves({ quote: 1 });
            let r = await c.feequote({ action: 'MINT', params: { x: 1 }, source: 'addr', feeOutputSats: 100 });
            expect(r).to.deep.equal({ quote: 1 });
            expect(call.calledWith('feequote', { action: 'MINT', params: { x: 1 }, source: 'addr', feeOutputSats: 100 })).to.be.true;
        });

        it('feeschedule delegates to _call', async function () {
            let c = new XChainIndexerConnector('http://x:1');
            let call = sinon.stub(c, '_call').resolves({ schedule: [] });
            let r = await c.feeschedule();
            expect(r).to.deep.equal({ schedule: [] });
            expect(call.calledWith('feeschedule', {})).to.be.true;
        });

        it('preflight delegates to _call with the preflight method + args ', async function () {
            let c = new XChainIndexerConnector('http://x:1');
            let call = sinon.stub(c, '_call').resolves({ supported: true, valid: true });
            let r = await c.preflight({ action: 'SEND', params: '0|JDOG|1|addr', source: 'me' });
            expect(r).to.deep.equal({ supported: true, valid: true });
            expect(call.calledWith('preflight', { action: 'SEND', params: '0|JDOG|1|addr', source: 'me' })).to.be.true;
        });
    });
});
