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
 * /status measures each coin concurrently under its own deadline, so one
 * coin whose DB never answers cannot stall another coin's status.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const DecoderConnector = require('../../../../src/connectors/decoder.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

describe('getStatus isolates a stalled coin from a healthy one', function () {
    let db;
    beforeEach(() => {
        db = new Database({ configInfo, util });
        db.statusCoinDeadlineMs = 150;
        db.pools = { BTC: { pool: {}, config: {} }, RBTC: { pool: {}, config: {} } };
        sinon.stub(db, 'getDecoderTip').callsFake(async ({ coin }) => (coin === 'BTC' ? 100 : 50));
        sinon.stub(db, 'getReplicaHaltStatus').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
    });
    afterEach(() => { sinon.restore(); });

    it('answers within the deadline, keeps the healthy coin and nulls the stalled one', async function () {
        const started = {};
        sinon.stub(db, 'getMaxBlockIndex').callsFake(({ coin }) => {
            started[coin] = Date.now();
            if (coin === 'BTC') return new Promise(() => {});   // DB never answers
            return Promise.resolve(50);
        });
        const t0 = Date.now();
        const [data] = await db.getStatus({});
        const took = Date.now() - t0;

        expect(took).to.be.below(1500);
        expect(data.last_block.RBTC).to.equal(50);
        expect(data.last_block_time.RBTC).to.equal(1700000000);
        expect(data.last_block.BTC).to.be.null;
        expect(data.last_block_time.BTC).to.be.null;
        // Concurrent: the second coin's first read began before the first coin's settled.
        expect(started.RBTC - started.BTC).to.be.below(100);
    });

    it('does not sum two stalls', async function () {
        sinon.stub(db, 'getMaxBlockIndex').callsFake(() => new Promise(() => {}));
        const t0 = Date.now();
        const [data] = await db.getStatus({});
        expect(Date.now() - t0).to.be.below(1500);
        expect(data.last_block.BTC).to.be.null;
        expect(data.last_block.RBTC).to.be.null;
    });
});

describe('getStatus fences a coin measurement that outlives its deadline', function () {
    let db;
    beforeEach(() => {
        db = new Database({ configInfo, util });
        db.statusCoinDeadlineMs = 150;
        db.pools = { BTC: { pool: {}, config: {} }, RBTC: { pool: {}, config: {} } };
        sinon.stub(db, 'getDecoderTip').callsFake(async ({ coin }) => (coin === 'BTC' ? 100 : 50));
        sinon.stub(db, 'getReplicaHaltStatus').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
    });
    afterEach(() => { sinon.restore(); });

    it('a measurement finishing after its deadline cannot rewrite the degraded report', async function () {
        const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
        sinon.stub(db, 'getMaxBlockIndex').callsFake(({ coin }) => (coin === 'BTC' ? sleep(300, 50) : Promise.resolve(50)));
        db.decoderApiUrl = { BTC: 'http://127.0.0.1:1', RBTC: 'http://127.0.0.1:1' };
        // Keeps getStatus open (chain visibility runs after the coins) past the late write.
        sinon.stub(DecoderConnector.prototype, 'health')
            .callsFake(() => sleep(600, { status: 'ok', chainTipBlock: 50, lag_blocks: 0 }));
        const [data] = await db.getStatus({});
        expect(data.last_block.BTC).to.be.null;
        expect(data.last_block_time.BTC).to.be.null;
        expect(data.decoder_tip.BTC).to.be.null;
        expect(data.decoder_lag_blocks.BTC).to.be.null;
        expect(data.tip_age_seconds.BTC).to.be.undefined;
        expect(data.indexer_state.BTC).to.be.undefined;
        expect(data.stale.BTC).to.equal(true);
        // Writes landing after the response is returned must not reach it either.
        await sleep(400);
        expect(data.last_block.BTC).to.be.null;
        expect(data.tip_age_seconds.BTC).to.be.undefined;
        expect(data.last_block.RBTC).to.equal(50);
    });
});

describe('getStatus reads a coin that missed its deadline as not fresh', function () {
    let db, savedEnv;
    beforeEach(() => {
        savedEnv = process.env.EXPLORER_STALE_FAIL_CLOSED;
        delete process.env.EXPLORER_STALE_FAIL_CLOSED;
        db = new Database({ configInfo, util });
        db.statusCoinDeadlineMs = 150;
        db.pools = { BTC: { pool: {}, config: {} }, RBTC: { pool: {}, config: {} } };
        sinon.stub(db, 'getDecoderTip').resolves(50);
        sinon.stub(db, 'getReplicaHaltStatus').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').callsFake(async () => Math.floor(Date.now() / 1000) - 10);
        sinon.stub(db, 'getMaxBlockIndex').callsFake(({ coin }) => (coin === 'BTC' ? new Promise(() => {}) : Promise.resolve(50)));
    });
    afterEach(() => {
        sinon.restore();
        if (savedEnv === undefined) delete process.env.EXPLORER_STALE_FAIL_CLOSED;
        else process.env.EXPLORER_STALE_FAIL_CLOSED = savedEnv;
    });

    it('marks the stalled coin stale, keeps it listed by default, leaves the healthy coin fresh', async function () {
        const [data] = await db.getStatus({});
        expect(data.stale.BTC, 'stale.BTC after a missed deadline').to.equal(true);
        expect(data.available).to.have.property('BTC');
        expect(data.stale.RBTC).to.equal(false);
        for (const coin of Object.keys(data.available)) expect(data.stale[coin], coin).to.be.a('boolean');
    });

    it('delists the stalled coin under EXPLORER_STALE_FAIL_CLOSED and leaves the healthy coin', async function () {
        process.env.EXPLORER_STALE_FAIL_CLOSED = '1';
        const [data] = await db.getStatus({});
        expect(data.available).to.not.have.property('BTC');
        expect(data.available).to.have.property('RBTC');
        expect(data.stale.BTC).to.equal(true);
        expect(data.stale.RBTC).to.equal(false);
    });

    it('agrees with getCoinFreshness for a coin whose read hit the DB deadline', async function () {
        db.getMaxBlockTime.restore();
        sinon.stub(db, 'getMaxBlockTime').rejects(new Error('DB_DEADLINE_EXCEEDED'));
        const [data] = await db.getStatus({});
        const fresh = await db.getCoinFreshness('BTC');
        expect(fresh.stale).to.equal(true);
        expect(data.stale.BTC).to.equal(true);
    });
});
