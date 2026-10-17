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
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');
const Utility = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig } = require('../../fixtures/mock-query-args.js');
const governanceSql = require('../../../src/db/action_detail/governance_sql.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function databaseWith(query){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = query;
    db.buildActionPreload = async () => null;
    return db;
}

function isTypeQuery(statement){
    return /SELECT\s+a2\.action\s+FROM\s+actions/i.test(statement);
}

async function returnsPreEditShapes(){
    const config = makeConfig({ coin: 'BTC' });
    const issued = [];
    const details = new Map([
        [501, { action: 'BET', action_format: 0, action_index: 501, label: 'market', outcomes: 'YES,NO',
            allow_list: 17, block_list: 18, edit_feed_ref: null, edit_allow_list: null,
            edit_block_list: null, edit_status: null }],
        [502, { action: 'BET', action_format: 2, action_index: 502, feed_action_index: 501,
            outcome: 1, amount: '25', edit_feed_ref: null, edit_allow_list: null,
            edit_block_list: null, edit_status: null }],
        [503, { action: 'BET', action_format: 4, action_index: 503, edit_feed_ref: null,
            edit_allow_list: null, edit_block_list: null, edit_status: null }]
    ]);
    const db = databaseWith(async (cfg, statement, args) => {
        issued.push(statement);
        if(isTypeQuery(statement)) return [{ action: 'BET' }];
        if(/information_schema\.TABLES/i.test(statement)) return [];
        if(statement === governanceSql.BET_DETAIL_PRE_EDITS) return [details.get(args[0])];
        if(statement === governanceSql.BET_FEED_LISTS_PRE_EDITS)
            return [{ allow_list: 17, block_list: 18 }];
        return [];
    });

    const feed = await db.getActionData(config, 501);
    const bet = await db.getActionData(config, 502);
    const edit = await db.getActionData(config, 503);

    assert.equal(feed.bet_kind, 'feed');
    assert.equal(bet.bet_kind, 'bet');
    assert.equal(edit.bet_kind, 'edit');
    assert.equal(edit.edit_allow_list, null);
    assert.equal(edit.edit_block_list, null);
    assert.ok(issued.every(statement => !/bet_edits/i.test(statement)));
    assert.equal(issued.filter(statement => /information_schema\.TABLES/i.test(statement)).length, 1);
}

async function retriesMissingTableOnce(){
    const config = makeConfig({ coin: 'BTC' });
    let probes = 0;
    let currentReads = 0;
    let preEditReads = 0;
    const db = databaseWith(async (cfg, statement, args) => {
        if(isTypeQuery(statement)) return [{ action: 'BET' }];
        if(/information_schema\.TABLES/i.test(statement)) {
            probes++;
            return [{ TABLE_NAME: 'bet_edits' }];
        }
        if(statement === governanceSql.BET_DETAIL) {
            currentReads++;
            const err = new Error('missing table');
            err.errno = 1146;
            throw err;
        }
        if(statement === governanceSql.BET_DETAIL_PRE_EDITS) {
            preEditReads++;
            return [{ action: 'BET', action_format: 2, action_index: args[0], feed_action_index: 501,
                outcome: 1, amount: '25', edit_feed_ref: null, edit_allow_list: null,
                edit_block_list: null, edit_status: null }];
        }
        return [];
    });

    assert.equal((await db.getActionData(config, 504)).bet_kind, 'bet');
    assert.equal((await db.getActionData(config, 505)).bet_kind, 'bet');
    assert.equal(probes, 1);
    assert.equal(currentReads, 1);
    assert.equal(preEditReads, 2);
    assert.equal(db.schemaTableMemo.BTC.bet_edits.present, false);
}

async function rethrowsRetryError(){
    const config = makeConfig({ coin: 'BTC' });
    let detailReads = 0;
    const db = databaseWith(async (cfg, statement) => {
        if(isTypeQuery(statement)) return [{ action: 'BET' }];
        if(/information_schema\.TABLES/i.test(statement)) return [{ TABLE_NAME: 'bet_edits' }];
        if(statement === governanceSql.BET_DETAIL || statement === governanceSql.BET_DETAIL_PRE_EDITS) {
            detailReads++;
            const err = new Error('still missing');
            err.errno = 1146;
            throw err;
        }
        return [];
    });

    await assert.rejects(db.getActionData(config, 506), /still missing/);
    assert.equal(detailReads, 2);
}

async function skipsRetryWithoutOptionalTables(){
    const config = makeConfig({ coin: 'BTC' });
    let voteReads = 0;
    const db = databaseWith(async (cfg, statement) => {
        if(isTypeQuery(statement)) return [{ action: 'VOTE' }];
        if(statement === governanceSql.VOTE_DETAIL) {
            voteReads++;
            const err = new Error('vote table missing');
            err.errno = 1146;
            throw err;
        }
        return [];
    });

    await assert.rejects(db.getActionData(config, 507), /vote table missing/);
    assert.equal(voteReads, 1);
}

describe('BET action detail without bet_edits', function(){
    it('returns feed, wager, and edit shapes without issuing a statement that names bet_edits', returnsPreEditShapes);
    it('retries one missing-table failure with the pre-edit statement and memoizes the absence', retriesMissingTableOnce);
    it('rethrows a missing-table error from the retry', rethrowsRetryError);
    it('does not retry a handler without optional tables', skipsRetryWithoutOptionalTables);
});
