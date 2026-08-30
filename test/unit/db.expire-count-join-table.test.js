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
 *
 * `/{COIN}/api/swap_expires` and `/{COIN}/api/dispenser_expires` returned
 * rows in `data` and `"total": 0` alongside them.
 *
 * CAUSE: both getters were copied from getOrderExpires and their COUNT
 * queries kept its `INNER JOIN orders o1`, while each main query correctly
 * joins its own lifecycle table. A swap's `swap_action_index` and a
 * dispenser's `dispenser_action_index` are not order indexes, so the count
 * join matched nothing and the INNER JOIN dropped every row - the count
 * came back 0 while the list beside it returned rows.
 *
 * WHY IT MATTERS BEYOND A WRONG NUMBER: these feeds back DataTables list
 * pages, which page off the count. A count of 0 is not a cosmetic figure,
 * it is a table that reports itself empty while holding rows.
 *
 * The invariant this pins is the one that was violated, and it is stronger
 * than "join the right table": a list getter's COUNT and its main query
 * must count the SAME set, so every lifecycle table the main query joins
 * INNER must also be joined by the count. Anything else can only make the
 * two disagree.
 *
 * Found 2026-08-28 by the explorer E2E campaign (M4), driving ORDER_EXPIRE,
 * SWAP_EXPIRE and DISPENSER_EXPIRE on the regtest venue and reading each
 * feed's own `total` against the rows it returned.
 *********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function makeDb(){
    return new Database({ configInfo, util });
}

function listConfig(){
    return makeConfig({
        data: {
            method: 'x',
            search: '1',
            type:   'block',
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.action_index IS NOT NULL', offset: '' }
            }
        }
    });
}

// Every INNER-joined table name in one SQL string, as a Set.
function innerJoinedTables(sql){
    const out = new Set();
    const re  = /INNER\s+JOIN\s+([a-z_]+)\s/gi;
    let m;
    while((m = re.exec(sql)) !== null)
        out.add(m[1]);
    return out;
}

// The lifecycle tables a copy-paste can silently swap between. Deliberately
// NOT every table: joins like `actions` and `blocks` are shared by every
// getter and carry no risk of naming the wrong entity.
const LIFECYCLE = ['orders', 'swaps', 'dispensers', 'bet_feeds', 'coinpay_obligations'];

describe('expire-feed COUNT queries count the same set as their list queries', () => {

    const CASES = [
        { method: 'getOrderExpires',     expected: 'orders'      },
        { method: 'getSwapExpires',      expected: 'swaps'       },
        { method: 'getDispenserExpires', expected: 'dispensers'  }
    ];

    for(const { method, expected } of CASES){

        it(method + ' joins ' + expected + ' in BOTH its count and its list query', async () => {
            const db = makeDb();
            const [query, , count] = await db[method](listConfig());

            const inList  = innerJoinedTables(query);
            const inCount = innerJoinedTables(count);

            expect(inList,  method + ' list query should join ' + expected).to.include(expected);
            expect(inCount, method + ' COUNT query should join ' + expected).to.include(expected);
        });

        it(method + ' count and list agree on every lifecycle table they join', async () => {
            const db = makeDb();
            const [query, , count] = await db[method](listConfig());

            const inList  = innerJoinedTables(query);
            const inCount = innerJoinedTables(count);

            // The defect's exact shape: the count joined a lifecycle table the
            // list did not, so the two selected different sets.
            for(const table of LIFECYCLE){
                expect(inCount.has(table), method + ': count joins ' + table + ' but the list query does not')
                    .to.equal(inList.has(table));
            }
        });
    }

    // A second, independent defect on the same family, found the same way: the
    // dispenser_closes feed served no reason, so a close after an auto-drain and a
    // close after a cancel were byte-identical on the wire. Every other column of
    // the two is the same, so nothing else could tell them apart.
    it('getDispenserCloses serves the close reason, joined on the CLOSE\'s own action index', async () => {
        const db = makeDb();
        const [query, , count] = await db.getDispenserCloses(listConfig());

        expect(query, 'list query must select a close_reason').to.match(/as\s+close_reason/);

        // Keyed on the close's own action_index. dispenser_close.js writes exactly one
        // dispenser_statuses row that way, so this is a point read of the reason THIS
        // close recorded. Joining the dispenser's LATEST status instead would make the
        // column drift if any later row is ever written for that dispenser.
        expect(query, 'the reason must join dispenser_statuses on m.action_index')
            .to.match(/JOIN\s+dispenser_statuses\s+\w+\s+ON\s*\(\s*\w+\.action_index\s*=\s*m\.action_index\s*\)/);
        expect(query, 'the reason join must not key off the dispenser index')
            .to.not.match(/JOIN\s+dispenser_statuses\s+\w+\s+ON\s*\(\s*\w+\.\w+\s*=\s*m\.dispenser_action_index\s*\)/);

        // LEFT, not INNER: a close with no status row must still list, and must not
        // silently vanish from the page the way the count defect above made rows vanish.
        expect(query, 'the reason join must be a LEFT JOIN so a reasonless close still lists')
            .to.match(/LEFT\s+JOIN\s+dispenser_statuses/);

        // ...and adding it must not have changed what the feed COUNTS.
        expect(count, 'the count query must not join dispenser_statuses')
            .to.not.match(/dispenser_statuses/);
    });

    it('no expire getter joins orders against a non-order action index', async () => {
        const db = makeDb();

        for(const method of ['getSwapExpires', 'getDispenserExpires']){
            const [query, , count] = await db[method](listConfig());
            for(const sql of [query, count]){
                // `orders o1 ON (o1.action_index = m.swap_action_index)` is the
                // literal bug: an orders join keyed off another entity's index.
                expect(/JOIN\s+orders\s+\w+\s+ON\s*\(\s*\w+\.action_index\s*=\s*m\.(swap|dispenser)_action_index/i.test(sql),
                    method + ' must not join orders against a ' + method.replace(/get|Expires/g, '').toLowerCase() + ' index')
                    .to.equal(false);
            }
        }
    });
});
