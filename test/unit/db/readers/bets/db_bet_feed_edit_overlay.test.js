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
 * A BET format 4 edit appends a bet_edits row and never rewrites the feed, and the
 * indexer judges every later wager against the latest valid edit per list. The
 * feed reads must show those same effective lists, and a replica without
 * bet_edits must still render the lists the feed was created with.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const FEED = 1193;

// A db whose schema probe reports whether bet_edits exists, recording every statement.
function makeDb({ hasEdits, failFirstFeedRead = false }) {
    const mockConfigInfo = createConfigInfoStub();
    const db = new Database({ configInfo: mockConfigInfo, util: new Utility(mockConfigInfo) });
    db.queries = [];
    let feedReads = 0;
    db.doQuery = async (config, sql) => {
        const text = String(sql);
        db.queries.push(text);
        if (text.includes('information_schema.TABLES')) return hasEdits ? [{ TABLE_NAME: 'bet_edits' }] : [];
        if (text.includes('FROM\n                        bet_feeds m') && text.includes('m.action_index=?')) {
            feedReads += 1;
            if (failFirstFeedRead && feedReads === 1)
                throw Object.assign(new Error('no such table'), { cause: { errno: 1146, code: 'ER_NO_SUCH_TABLE' } });
            return [{ action_index: FEED, outcomes: 'YES,NO', details: null, closed_block: null, allow_list: null, block_list: 7 }];
        }
        return [];
    };
    return db;
}

const feedRead = (db) => db.queries.filter(q => q.includes('m.action_index=?') && q.includes('bet_feeds m'));
const listConfig = () => ({ coin: 'LTC', data: { sql: { where: { data: '1=1', offset: '' }, order: 'DESC', limit: 10 } } });

describe('BET feed reads apply the bet_edits list overlay', function () {
    it('getBetFeedInfo reads the latest valid edit per list when bet_edits exists', async function () {
        const db = makeDb({ hasEdits: true });
        await db.getBetFeedInfo({ coin: 'LTC' }, FEED);
        const [sql] = feedRead(db);

        assert.strictEqual((sql.match(/LEFT\s+JOIN bet_edits/g) || []).length, 2, 'one overlay join per list');
        assert.match(sql, /CASE WHEN ae\.action_index IS NULL THEN m\.allow_list ELSE NULLIF\(ae\.allow_list, 0\) END as allow_list/);
        assert.match(sql, /CASE WHEN be\.action_index IS NULL THEN m\.block_list ELSE NULLIF\(be\.block_list, 0\) END as block_list/);
        assert.match(sql, /es\.status='valid' AND e\.allow_list IS NOT NULL/);
        assert.match(sql, /es\.status='valid' AND e\.block_list IS NOT NULL/);
        assert.match(sql, /WHERE m\.action_index=\?/);
    });

    it('getBetFeedInfo reads the created lists on a replica without bet_edits', async function () {
        const db = makeDb({ hasEdits: false });
        const row = await db.getBetFeedInfo({ coin: 'LTC' }, FEED);
        const [sql] = feedRead(db);

        assert.ok(!sql.includes('bet_edits'), 'an older replica has no bet_edits table to join');
        assert.match(sql, /m\.allow_list,\s+m\.block_list,/);
        assert.strictEqual(row.action_index, FEED);
    });

    it('getBetFeedInfo retries with the created lists when the overlay meets a missing table', async function () {
        const db = makeDb({ hasEdits: true, failFirstFeedRead: true });
        const row = await db.getBetFeedInfo({ coin: 'LTC' }, FEED);
        const reads = feedRead(db);

        assert.strictEqual(reads.length, 2);
        assert.ok(reads[0].includes('bet_edits') && !reads[1].includes('bet_edits'));
        assert.strictEqual(row.action_index, FEED);
        assert.strictEqual(db.schemaTableMemo.LTC.bet_edits.present, false, 'the next read skips the overlay');
    });

    it('getBetFeeds selects the overlaid lists but leaves the count query plain', async function () {
        const db = makeDb({ hasEdits: true });
        const [query, , count] = await db.getBetFeeds(listConfig());

        assert.strictEqual((query.match(/LEFT\s+JOIN bet_edits/g) || []).length, 2);
        assert.match(query, /NULLIF\(ae\.allow_list, 0\) END as allow_list/);
        assert.match(query, /NULLIF\(be\.block_list, 0\) END as block_list/);
        assert.ok(!count.includes('bet_edits'), 'no list filter exists, so the count needs no overlay');
    });

    it('getBetFeeds selects the created lists on a replica without bet_edits', async function () {
        const db = makeDb({ hasEdits: false });
        const [query] = await db.getBetFeeds(listConfig());

        assert.ok(!query.includes('bet_edits'));
        assert.match(query, /m\.allow_list,\s+m\.block_list,/);
    });
});
