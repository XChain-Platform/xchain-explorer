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

const assert = require('assert');
const transfers = require('../../../../../src/db/readers/action_lists/transfers.js');
const tokens = require('../../../../../src/db/readers/action_lists/tokens.js');
const { firstLastSql, stopSql } = require('../../../../../src/db/query_sql/offset_boundaries.js');

function config(method, apiOffset = 0){
    return {
        type: 'api',
        data: {
            method,
            search: 'address-1',
            type: 'address',
            sql: {
                order: 'DESC',
                limit: 2,
                apiOffset,
                where: {
                    data: 'm.action_index IS NOT NULL AND a2.address=?',
                    offset: ' AND m.action_index < ?',
                    offsetArgs: [50]
                }
            }
        }
    };
}

function boundaryContext(method){
    return {
        method,
        type: 'address',
        table: method.slice(3).toLowerCase(),
        where: '',
        hCursor: 'a1.action_index',
        hSource: 'actions a1',
        pagesOverBlocks: false,
        includeListMetaRenames: false
    };
}

describe('SEND and DESTROY whole-action paging', () => {
    for(const [method, reader, cte] of [
        ['getSends', transfers.getSends, 'filtered_sends'],
        ['getDestroys', tokens.getDestroys, 'filtered_destroys']
    ]){
        it(method + ' limits distinct actions and returns every selected leg', async () => {
            const cfg = config(method);
            const [query, , count] = await reader.call({}, cfg);

            assert.match(query, new RegExp('WITH ' + cte + ' AS'));
            assert.match(query, /SELECT DISTINCT action_index[\s\S]*LIMIT 2 OFFSET 0/);
            assert.match(query, new RegExp('FROM\\s+' + cte + ' m[\\s\\S]*page_actions p'));
            assert.match(query, /ORDER BY m\.action_index DESC, m\.leg_ordinal ASC/);
            assert.doesNotMatch(query, /page_actions p[\s\S]*LIMIT 2/);
            assert.match(count, /count\(DISTINCT m\.action_index\) as total/);
        });

        it(method + ' applies API offsets to actions instead of legs', async () => {
            const cfg = config(method, 4);
            const [query] = await reader.call({}, cfg);

            assert.match(query, /LIMIT 2 OFFSET 4/);
            assert.strictEqual(cfg.data.sql.apiOffset, 0);
            assert.strictEqual(cfg.data.offset.start, true);
        });

        it(method + ' de-duplicates action cursors in first, last, and stop boundaries', () => {
            const ctx = boundaryContext(method);
            const firstLast = firstLastSql(ctx, 'DESC', 3);
            const stop = stopSql(ctx, '', 'DESC', 3);

            assert.match(firstLast, /SELECT\s+DISTINCT m\.action_index as offset_index/);
            assert.match(stop, /SELECT\s+DISTINCT m\.action_index as offset_index/);
        });
    }

    it('leaves single-row action boundaries unchanged', () => {
        const ctx = boundaryContext('getMints');
        assert.doesNotMatch(firstLastSql(ctx, 'DESC', 3), /DISTINCT m\.action_index/);
        assert.doesNotMatch(stopSql(ctx, '', 'DESC', 3), /DISTINCT m\.action_index/);
    });
});
