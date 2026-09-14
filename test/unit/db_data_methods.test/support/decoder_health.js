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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, mockResults, makeDb, cfg } = require('./helpers.js');

const axios = require('axios');
const ENV_KEYS = ['DECODER_API_URL', 'DECODER_API_URL_BTC_MAINNET', 'DECODER_API_URL_BTC_REGTEST'];
let db, saved;

// The per-chain endpoints setupConnectionPools derives from the loaded config
// (see db.connection.test.js for how they are read out of the config shapes).
const CONFIG_URLS = { BTC: 'http://decoder-btc-mainnet:3002', RBTC: 'http://decoder-btc-regtest:3002' };
const healthReply = { data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7 } } };
// URL each coin's health call was actually POSTed to.
function urlsByCoin(stub) {
    const seen = {};
    for (const call of stub.getCalls()) seen[call.args[0]] = true;
    return Object.keys(seen);
}

describe('Database#getStatus decoder health aggregation', () => {
    beforeEach(() => {
        db = makeDb();
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    it('reports decoder_health=unconfigured with null chain fields when no URL is set', async () => {
        const [data] = await db.getStatus(cfg());
        expect(data).to.include.keys(['chain_tip', 'chain_lag_blocks', 'decoder_health']);
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('unconfigured');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });

    it('surfaces chain_tip / chain_lag_blocks / status from the decoder health call', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7 } }
        });
        const [data] = await db.getStatus(cfg());
        const codes = Object.keys(data.decoder_health);
        expect(codes.length).to.be.greaterThan(0);
        for (const code of codes) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    // A decoder that has never reached its coin node reports the -1 tip sentinel
    // and a negative blockLag; neither is a real height or gap, so both publish
    // as null rather than chain_tip=-1 / chain_lag_blocks=0 ("at the tip").
    it('nulls chain_tip / chain_lag_blocks for the decoder -1 never-polled sentinel', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: -1, blockLag: -900501, lag_blocks: null } }
        });
        const [data] = await db.getStatus(cfg());
        const codes = Object.keys(data.decoder_health);
        expect(codes.length).to.be.greaterThan(0);
        for (const code of codes) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });
});

describe('Database#getStatus decoder health aggregation', () => {
    beforeEach(() => {
        db = makeDb();
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    it('prefers the decoder lag_blocks field over blockLag when present', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: 900500, blockLag: 7, lag_blocks: 7 } }
        });
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    it('treats a negative blockLag from a decoder without lag_blocks as unknown, never 0', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').resolves({
            data: { result: { status: 'healthy', chainTipBlock: -1, blockLag: -42 } }
        });
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });

    it('reports decoder_health=unreachable (null fields) when the health call fails', async () => {
        process.env.DECODER_API_URL = 'http://decoder:3001';
        sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'));
        const [data] = await db.getStatus(cfg());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('unreachable');
            expect(data.chain_tip[code]).to.be.null;
            expect(data.chain_lag_blocks[code]).to.be.null;
        }
    });
});

describe('Database#getStatus decoder health aggregation', () => {
    beforeEach(() => {
        db = makeDb();
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    // Config-derived endpoints must resolve without a per-chain env var, or the
    // chain->decoder gap goes invisible even on a healthy chain.
    it('polls the per-chain endpoint from the loaded config with no env var set', async () => {
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        const [data] = await db.getStatus(cfg());
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, CONFIG_URLS.RBTC].sort());
        for (const code of Object.keys(data.decoder_health)) {
            expect(data.decoder_health[code]).to.equal('healthy');
            expect(data.chain_tip[code]).to.equal(900500);
            expect(data.chain_lag_blocks[code]).to.equal(7);
        }
    });

    it('lets the coin/network-specific env var override the config-derived endpoint', async () => {
        process.env.DECODER_API_URL_BTC_MAINNET = 'http://override:9002';
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        // BTC takes the override; RBTC still takes its own config-derived endpoint.
        expect(urlsByCoin(post).sort()).to.deep.equal(['http://override:9002', CONFIG_URLS.RBTC].sort());
    });

    it('prefers the per-chain config endpoint over the generic DECODER_API_URL', async () => {
        // The generic var names ONE decoder and is applied to every coin, so on a
        // multi-chain deployment it is right for at most one of them; a per-chain
        // endpoint is right for all of them.
        process.env.DECODER_API_URL = 'http://generic:3001';
        db.decoderApiUrl = Object.assign({}, CONFIG_URLS);
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        expect(urlsByCoin(post)).to.not.include('http://generic:3001');
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, CONFIG_URLS.RBTC].sort());
    });
});

describe('Database#getStatus decoder health aggregation', () => {
    beforeEach(() => {
        db = makeDb();
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    it('still falls back to the generic DECODER_API_URL for a coin the config has no endpoint for', async () => {
        process.env.DECODER_API_URL = 'http://generic:3001';
        db.decoderApiUrl = { BTC: CONFIG_URLS.BTC };
        const post = sinon.stub(axios, 'post').resolves(healthReply);
        await db.getStatus(cfg());
        expect(urlsByCoin(post).sort()).to.deep.equal([CONFIG_URLS.BTC, 'http://generic:3001'].sort());
    });
});
