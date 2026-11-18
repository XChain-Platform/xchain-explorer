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
 * The oracle record's headline counts markets that opened.
 *
 * The indexer stores a feed row for every create, valid or not, and marks a
 * rejected one 'invalid'. Totalling every row padded the headline with creates
 * that never opened a market and left it larger than the sum of the lifecycle
 * lines under it. Rejected creates are reported as their own count instead.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ORACLE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const config = { coin: 'BTC', data: { search: ORACLE } };

function makeDb(statusRows) {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const db             = new Database({ configInfo: mockConfigInfo, util });
    db.doQuery = async (cfg, sql) => String(sql).includes('GROUP BY fs.status') ? statusRows : [];
    return db;
}

function lifecycleSum(rec) {
    const c = rec.counts;
    return rec.active_feeds + c.resolved + c.resolved_void + c.cancelled + c.expired;
}

describe('Betting oracle record rejected creates @regression', function () {
    it('keeps rejected creates out of total_feeds and reports them separately', async function () {
        const db = makeDb([
            { feed_status: 'resolved', feeds: 2 },
            { feed_status: 'expired',  feeds: 1 },
            { feed_status: 'invalid',  feeds: 3 },
        ]);
        const [rec] = await db.getOracleStats(config);
        assert.strictEqual(rec.total_feeds, 3);
        assert.strictEqual(rec.rejected_feeds, 3);
        assert.strictEqual('invalid' in rec.counts, false);
        assert.strictEqual(rec.total_feeds, lifecycleSum(rec));
    });

    it('reports a zero headline for an address whose creates were all rejected', async function () {
        const db = makeDb([{ feed_status: 'invalid', feeds: 2 }]);
        const [rec] = await db.getOracleStats(config);
        assert.strictEqual(rec.total_feeds, 0);
        assert.strictEqual(rec.rejected_feeds, 2);
        assert.strictEqual(rec.active_feeds, 0);
        assert.deepStrictEqual(Object.values(rec.counts), [0, 0, 0, 0, 0, 0]);
    });

    it('always carries rejected_feeds, zero when nothing was rejected', async function () {
        const db = makeDb([{ feed_status: 'open', feeds: 4 }]);
        const [rec] = await db.getOracleStats(config);
        assert.strictEqual(rec.rejected_feeds, 0);
        assert.strictEqual(rec.total_feeds, 4);
        assert.strictEqual(rec.total_feeds, lifecycleSum(rec));
    });
});
