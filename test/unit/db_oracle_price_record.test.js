/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The per-address oracle track record covers PRICE v1 publishers, not just
 * betting-market oracles.
 *
 * getOracleStats was scoped exclusively to bet_feeds, so an address that had
 * published real PRICE v1 rounds (hub-mirrored oracle_prices) reported
 * active_feeds / total_feeds 0 and all-zero counts before AND after publishing:
 * the /oracle/{addr} page showed a working price oracle as having no record at
 * all. The record now carries a `price` half aggregated per published pair.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const ORACLE = 'ms2Qea1kzmENE798jGfXREMM4wGHQJkxyt';

function makeDb(rows, withMirror) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    if (withMirror)
        db.checkpointDb = { DOGE: { name: 'hub_checkpoint' } };
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        db.calls.push({ sql: String(sql), args: args || [] });
        for (const [needle, result] of rows)
            if (String(sql).includes(needle)) return result;
        return [];
    };
    return db;
}

const config = { coin: 'DOGE', data: { search: ORACLE } };

const PAIR_ROWS = [
    { coin: 'DOGE', tick: 'CAMPA', fiat: 'USD', publishes: 2n, first_publish: 1787848846n, last_publish: 1787848894n },
    { coin: 'DOGE', tick: 'OTHER', fiat: 'EUR', publishes: 1n, first_publish: 1787000000n, last_publish: 1787000000n },
];

describe('Oracle track record covers PRICE v1 publishers @regression', function () {

    it('reports the publisher\'s rounds per pair, with counts and the publish window', async function () {
        const db = makeDb([['oracle_prices', PAIR_ROWS]], true);
        const [rec] = await db.getOracleStats(config);
        assert.ok(rec.price, 'the price half of the record is missing entirely');
        assert.strictEqual(rec.price.total_publishes, 3);
        assert.deepStrictEqual(rec.price.pairs, [
            { coin: 'DOGE', tick: 'CAMPA', fiat: 'USD', publishes: 2, first_publish: 1787848846, last_publish: 1787848894 },
            { coin: 'DOGE', tick: 'OTHER', fiat: 'EUR', publishes: 1, first_publish: 1787000000, last_publish: 1787000000 },
        ]);
        // The betting half must survive the addition unchanged
        assert.strictEqual(rec.total_feeds, 0);
        assert.deepStrictEqual(rec.fees_earned, []);
    });

    it('reads the hub-mirror table and binds the publisher address', async function () {
        const db = makeDb([['oracle_prices', PAIR_ROWS]], true);
        await db.getOracleStats(config);
        const call = db.calls.find(c => c.sql.includes('oracle_prices'));
        assert.ok(call, 'no oracle_prices query was issued at all');
        assert.ok(call.sql.includes('`hub_checkpoint`.oracle_prices'),
            'the price record must read the co-located hub mirror, never a stale local replica');
        assert.ok(/WHERE\s+m\.source_address=\?/.test(call.sql));
        assert.ok(call.sql.includes('GROUP BY m.coin, m.tick, m.fiat'),
            'the record must aggregate per published pair');
        assert.deepStrictEqual(call.args, [ORACLE]);
    });

    it('an address that never published gets the zero record, not null', async function () {
        const db = makeDb([['oracle_prices', []]], true);
        const [rec] = await db.getOracleStats(config);
        assert.deepStrictEqual(rec.price, { total_publishes: 0, pairs: [] });
    });

    it('a node with no co-located hub DB answers price:null (unknown), and the betting record still answers', async function () {
        const db = makeDb([['GROUP BY fs.status', [{ feed_status: 'resolved', feeds: 2 }]]], false);
        const [rec] = await db.getOracleStats(config);
        assert.strictEqual(rec.price, null,
            'without the mirror the price half must be null (cannot know), not a fake zero record');
        assert.strictEqual(rec.counts.resolved, 2, 'the betting half must not be taken down with it');
    });
});
