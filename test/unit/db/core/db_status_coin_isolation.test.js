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
