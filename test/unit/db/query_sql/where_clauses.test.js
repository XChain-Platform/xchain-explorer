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

const QueryWhereClauses = require('../../../../src/db/query_sql/where_clauses.js');

function config(method, type, search, search2){
    return { data: { method, type, search, search2 } };
}

function assertParameterized(sql, params){
    assert.strictEqual((sql.match(/\?/g) || []).length, params.length);
    for (const param of params)
        assert.ok(!sql.includes(param));
}

describe('QueryWhereClauses', function(){
    let clauses;

    beforeEach(function(){
        clauses = Object.create(QueryWhereClauses);
    });

    it('routes a known action method to its clause builder', async function(){
        const params = ['XCP', 'BTC', 'BTC', 'XCP'];
        const sql = await clauses.getQueryWhereSql(
            config('getMarket', null, params[0], params[1])
        );

        assert.strictEqual(sql, 'm.id IS NOT NULL AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))');
        assertParameterized(sql, params);
    });

    it('routes an unknown method through the generic clause', async function(){
        const params = ['1ExampleAddress'];
        const sql = await clauses.getQueryWhereSql(
            config('unknownMethod', 'address', params[0])
        );

        assert.strictEqual(sql, 'm.action_index IS NOT NULL AND a2.address=?');
        assertParameterized(sql, params);
    });
});
