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
const IndexerConnector = require('../../../../../src/connectors/indexer.js');
const { sinon, expect, makeDb } = require('../../core/db_data_methods.test/support/helpers.js');
const { clearTipEnvironment, restoreTipEnvironment } =
    require('../../core/db_data_methods.test/support/tip_freshness_helpers.js');

const TARGET = 500;
let db, rules, savedTipEnv;

function resetFreshness(){
    if(db._tipStaleCache) delete db._tipStaleCache.RBTC;
}

describe('Database tip health replay finality', function(){
    beforeEach(function(){
        db = makeDb();
        savedTipEnv = clearTipEnvironment();
        rules = {
            digest: 'a'.repeat(64),
            replay: { state: 'replaying', target: TARGET, replay_to: 550 }
        };
        sinon.stub(db, 'getMaxBlockTime').resolves(Math.floor(Date.now() / 1000) - 30);
        sinon.stub(db, 'getMaxBlockIndex').resolves(TARGET);
        sinon.stub(db, 'getReplicaHaltStatus').resolves(false);
        sinon.stub(db, 'parseCoinCode').resolves({ coin: 'BTC', network: 'regtest' });
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('configured-indexer');
        sinon.stub(axios, 'post').callsFake(async () => ({ data: { result: { rules } } }));
    });

    afterEach(function(){
        restoreTipEnvironment(savedTipEnv);
        sinon.restore();
    });

    it('marks the replay target and higher indexed heights as not final', async function(){
        for(const state of ['pending', 'replaying']){
            rules.replay.state = state;
            for(const height of [TARGET, TARGET + 1]){
                db.getMaxBlockIndex.resolves(height);
                resetFreshness();
                const health = await db.getCoinFreshness('RBTC');
                expect(health.tip_block).to.equal(height);
                expect(health.final, `${state} ${height}`).to.equal(false);
            }
        }
    });

    it('keeps an indexed height below the open replay target final', async function(){
        db.getMaxBlockIndex.resolves(TARGET - 1);
        const health = await db.getCoinFreshness('RBTC');
        expect(health.final).to.equal(true);
    });

    it('clears the not-final verdict once the indexer reports replayed', async function(){
        expect((await db.getCoinFreshness('RBTC')).final).to.equal(false);

        rules = { ...rules, replay: { ...rules.replay, state: 'replayed' } };
        resetFreshness();

        expect((await db.getCoinFreshness('RBTC')).final).to.equal(true);
        expect(axios.post.lastCall.args[1].method).to.equal('health');
    });
});
