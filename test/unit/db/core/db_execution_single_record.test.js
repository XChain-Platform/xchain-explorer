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
 *********************************************************************/

'use strict';

const { sinon, expect, makeConfig, makeDb } = require('../readers/db_contract_meta.test/support/helpers.js');

// /{COIN}/api/execution/{QUERY}, built the way the router builds it. Production
// answered ?page=2 with error 1064 near '384': the WHERE carried no placeholder for
// the id, so the id bound to the OFFSET placeholder instead.
function executionCfg(query){
    return makeConfig({ coin: 'RTEST', type: 'api', data: { method: 'getExecution', type: 'execution', search: '384', query } });
}

const placeholders = sql => (sql.match(/\?/g) || []).length;

describe('Database#getExecution binds the execution id', function(){
    it('filters the WHERE on the execution action_index', async function(){
        const db  = makeDb();
        const sql = await db.getQueryWhereSql(executionCfg({}));
        expect(sql).to.include('m.action_index=?');
    });

    for(const page of [undefined, '2', '101']){
        it('binds one arg per placeholder at page=' + page, async function(){
            const db   = makeDb();
            const stub = sinon.stub(db, 'doQuery').callsFake(async (config, sql) =>
                (/count\(\*\) as total/.test(sql) ? [{ total: 1 }] : []));

            await db.getData(executionCfg(page ? { page } : {}));

            const calls = stub.getCalls().filter(call => /contract_executions m/.test(call.args[1]));
            expect(calls).to.have.lengthOf(2);
            for(const call of calls){
                expect(placeholders(call.args[1])).to.equal(call.args[2].length);
                expect(call.args[2][0]).to.equal('384');
            }
            const rows = calls.find(call => !/count\(\*\)/.test(call.args[1]));
            if(page) expect(rows.args[1]).to.match(/OFFSET \?$/);
            if(page) expect(rows.args[2][1]).to.equal((Number(page) - 1) * 100);
        });
    }
});
