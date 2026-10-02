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

const axios = require('axios');
const { sinon, expect, makeDb, cfg } = require('../../core/db_data_methods.test/support/helpers.js');
const { clearTipEnvironment, restoreTipEnvironment, configurePool } =
    require('../../core/db_data_methods.test/support/tip_freshness_helpers.js');

const ENV_KEYS = ['INDEXER_API_URL', 'INDEXER_API_URL_BTC_REGTEST'];
let db, savedTipEnv, savedIndexerEnv;

function setup(){
    db = makeDb();
    savedTipEnv = clearTipEnvironment();
    savedIndexerEnv = {};
    for(const key of ENV_KEYS){
        savedIndexerEnv[key] = process.env[key];
        delete process.env[key];
    }
}

function teardown(){
    restoreTipEnvironment(savedTipEnv);
    for(const key of ENV_KEYS){
        if(savedIndexerEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedIndexerEnv[key];
    }
    sinon.restore();
}

function laggingWithAdmissibleNextBlock(lag){
    configurePool(db, 'RBTC', Math.floor(Date.now() / 1000) - 60);
    sinon.stub(db, 'getMaxBlockIndex').resolves(850);
    sinon.stub(db, 'getDecoderTip').resolves(850 + lag);
    sinon.stub(db, 'getDecoderBlockTime').resolves(Math.floor(Date.now() / 1000) - 30);
    process.env.INDEXER_API_URL_BTC_REGTEST = 'http://127.0.0.1:3001';
}

describe('Database#getStatus oracle-sync barrier hold', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('reads the barrier hold and reports behind with its clear instant', async () => {
        laggingWithAdmissibleNextBlock(12);
        // The pairing the indexer's stallClassOf sends while the clear instant is ahead.
        const stallClearsAt = Date.now() + 120000;
        const post = sinon.stub(axios, 'post').resolves({
            data: { result: {
                stallReason: 'oracle_sync_barrier',
                stallClass: 'future_block_wait',
                stallClearsAt
            } }
        });

        const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));

        expect(data.indexer_state['RBTC']).to.equal('behind');
        expect(data.indexer_state['RBTC']).not.to.equal('barrier_hold');
        expect(data.indexer_wait_clears_at['RBTC']).to.equal(new Date(stallClearsAt).toISOString());
        expect(post.calledOnce).to.equal(true);
        expect(post.firstCall.args[1].method).to.equal('health');
    });

    it('also reports a genuine non-barrier lag as behind without a clear instant', async () => {
        laggingWithAdmissibleNextBlock(12);
        sinon.stub(axios, 'post').resolves({
            data: { result: { stallReason: null, stallClass: 'none', stallClearsAt: null } }
        });

        const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));

        expect(data.indexer_state['RBTC']).to.equal('behind');
        expect(data.indexer_wait_clears_at['RBTC']).to.equal(null);
    });

    // Once the instant passes the indexer reclassifies the stall, and a past
    // stallClearsAt is no clear time to publish.
    for(const stallClass of ['barrier_defer', 'wedged']){
        it(`publishes no clear instant for a ${stallClass} stall whose clear time has passed`, async () => {
            laggingWithAdmissibleNextBlock(12);
            sinon.stub(axios, 'post').resolves({
                data: { result: { stallReason: 'oracle_sync_barrier', stallClass, stallClearsAt: Date.now() - 60000 } }
            });

            const [data] = await db.getStatus(cfg({ coin: 'RBTC' }));

            expect(data.indexer_state['RBTC']).to.equal('behind');
            expect(data.indexer_wait_clears_at['RBTC']).to.equal(null);
        });
    }
});
