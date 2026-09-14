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

let db;

describe('Database#getStatus', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns an object that includes supported and available keys', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.include.keys(['supported', 'available']);
    });

    it('returns the COIN_SUPPORTED map from config', async () => {
        const config  = cfg();
        const [data]  = await db.getStatus(config);
        const fullCfg = await configInfo.getConfig();
        expect(data.supported).to.deep.equal(fullCfg['COIN_SUPPORTED']);
    });

    it('returns the COIN_AVAILABLE map from config', async () => {
        const config  = cfg();
        const [data]  = await db.getStatus(config);
        const fullCfg = await configInfo.getConfig();
        expect(data.available).to.deep.equal(fullCfg['COIN_AVAILABLE']);
    });

    it('returns last_block as an object', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.have.property('last_block').that.is.an('object');
    });

    it('returns last_block_time as an object', async () => {
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(data).to.have.property('last_block_time').that.is.an('object');
    });

    it('populates last_block and last_block_time with numeric values for each available coin that has an active pool', async () => {
        db.pools = {};
        db.pools['RBTC'] = {
            pool: {
                getConnection: sinon.stub().resolves({
                    query:   sinon.stub().resolves([{ max_index: 850, block_time: 1700000000 }]),
                    release: sinon.stub().resolves()
                })
            },
            config: {}
        };
        const config = cfg({ coin: 'RBTC' });
        const [data] = await db.getStatus(config);
        expect(data.last_block).to.have.property('RBTC');
        expect(data.last_block['RBTC']).to.be.a('number');
        expect(data.last_block_time).to.have.property('RBTC');
        expect(data.last_block_time['RBTC']).to.be.a('number');
    });
});

describe('Database#getStatus', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('sets last_block[coin]/last_block_time[coin] to 0 when the blocks table is empty (simulates indexer behind tip)', async () => {
        db.pools = {};
        db.pools['RBTC'] = {
            pool: {
                getConnection: sinon.stub().resolves({
                    query:   sinon.stub().resolves([{ max_index: null, block_time: null }]),
                    release: sinon.stub().resolves()
                })
            },
            config: {}
        };
        const config = cfg({ coin: 'RBTC' });
        const [data] = await db.getStatus(config);
        expect(data.last_block).to.have.property('RBTC', 0);
        expect(data.last_block_time).to.have.property('RBTC', 0);
    });

    it('excludes coins from last_block/last_block_time when they have no active pool', async () => {
        db.pools = {};
        const config = cfg();
        const [data] = await db.getStatus(config);
        expect(Object.keys(data.last_block)).to.have.lengthOf(0);
        expect(Object.keys(data.last_block_time)).to.have.lengthOf(0);
    });
});
