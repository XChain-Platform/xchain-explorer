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

// A BET format-4 edit never rewrites the feed row, so the feed's action detail must
// read the lists in force the way /api/bet_feed and the indexer's wager checks do.

const fs         = require('fs');
const path       = require('path');
const assert     = require('node:assert/strict');
const proxyquire = require('proxyquire');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig } = require('../../fixtures/mock-query-args.js');
const governanceSql = require('../../../src/db/action_detail/governance_sql.js');
const governance    = require('../../../src/action-detail/governance.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const FEED = 1193;
const util = { isNull: value => value === null || value === undefined };

// A db that answers the BET detail read with a feed created with lists 77 / 88.
function feedDb(inForce) {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.listReads = [];
    let call = 0;
    db.doQuery = async (config, statement, args) => {
        call++;
        if (call === 1) return [{ action: 'BET' }];
        if (statement === governanceSql.BET_DETAIL)
            return [{ action: 'BET', action_format: 0, action_index: FEED, label: 'market',
                outcomes: 'YES,NO', allow_list: 77, block_list: 88, feed_status: 'open', status: 'valid' }];
        if (statement === governanceSql.BET_FEED_LISTS) { db.listReads.push(args); return inForce; }
        return [];
    };
    db.buildActionPreload = async () => null;
    return db;
}

describe('BET feed action detail reads the lists in force', function () {
    it('reports an edited feed\'s lists and keeps the created ones beside them', async function () {
        const db = feedDb([{ allow_list: 91, block_list: 88 }]);
        const data = await db.getActionData(makeConfig({ coin: 'BTC' }), FEED);
        assert.deepEqual(db.listReads, [[FEED]]);
        assert.equal(data.bet_kind, 'feed');
        assert.equal(data.allow_list, 91);
        assert.equal(data.block_list, 88);
        assert.equal(data.created_allow_list, 77);
        assert.equal(data.created_block_list, 88);
    });

    it('reports a list an edit cleared with 0 as cleared, not as created', async function () {
        const db = feedDb([{ allow_list: null, block_list: 88 }]);
        const data = await db.getActionData(makeConfig({ coin: 'BTC' }), FEED);
        assert.equal(data.allow_list, null);
        assert.equal(data.created_allow_list, 77);
    });

    it('keeps the created lists when the in-force read finds no feed row', async function () {
        const db = feedDb([]);
        const data = await db.getActionData(makeConfig({ coin: 'BTC' }), FEED);
        assert.equal(data.allow_list, 77);
        assert.equal(data.block_list, 88);
    });
});

describe('BET feed lists in force: the statement and the other shapes', function () {
    it('reads the lists through the shared latest-valid-edit rule', function () {
        const sql = governanceSql.BET_FEED_LISTS;
        assert.equal((sql.match(/LEFT\s+JOIN bet_edits/g) || []).length, 2, 'one overlay join per list');
        assert.match(sql, /CASE WHEN ae\.action_index IS NULL THEN m\.allow_list ELSE NULLIF\(ae\.allow_list, 0\) END as allow_list/);
        assert.match(sql, /CASE WHEN be\.action_index IS NULL THEN m\.block_list ELSE NULLIF\(be\.block_list, 0\) END as block_list/);
        assert.match(sql, /e\.feed_action_index=m\.action_index AND es\.status='valid' AND e\.allow_list IS NOT NULL/);
        assert.match(sql, /FROM bet_feeds m[\s\S]*WHERE m\.action_index=\? LIMIT 1$/);
    });

    it('issues no in-force read and carries no created lists on a wager, edit or cancel', async function () {
        for (const data of [{ action_format: 2, feed_action_index: 41 }, { action_format: 4, edit_feed_ref: 41 },
            { action_format: 1, cancel_feed_ref: 41 }]) {
            const issued = [];
            const db = { util, doQuery: async (config, statement) => { issued.push(statement); return []; } };
            await governance.BET.afterMain({ db, config: {}, action_index: 56 }, data);
            assert.ok(!issued.includes(governanceSql.BET_FEED_LISTS), 'format ' + data.action_format);
            assert.ok(!('created_allow_list' in data) && !('created_block_list' in data), 'format ' + data.action_format);
        }
    });

    // A second hand-written copy of the rule is how the action detail drifted from /api/bet_feed.
    it('keeps the explorer to one copy of the list rule', function () {
        const src = path.resolve(__dirname, '..', '..', '..', 'src');
        const holders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('NULLIF(ae.allow_list'))
                    holders.push(path.relative(src, full));
            }
        };
        walk(src);
        assert.deepEqual(holders, ['db/bet_list_overlay.js']);
    });
});
