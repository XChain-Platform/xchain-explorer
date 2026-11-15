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
 * The broadcast search panel's memo predicate. index_memos.memo is byte-exact
 * upstream, so the explorer folds it to the message column's collation on both
 * the count and the page statement. The collation behaviour itself is pinned
 * against a real engine in test/conformance/broadcast_memo_search.test.js.
 *********************************************************************/

'use strict';

const { sinon, expect, makeConfig, makeDb } = require('../db_contract_meta.test/support/helpers.js');
const { withIndexProbe, panelCalls }       = require('./support/index_probe.js');

const FOLDED = 'CONVERT(m.memo USING utf8mb4) COLLATE utf8mb4_general_ci LIKE ?';
const squash = sql => String(sql).replace(/\s+/g, ' ').trim();

describe('Database#getSearch broadcast panel memo predicate', function(){
    afterEach(() => sinon.restore());

    it('folds the memo to the message collation on the count and the page statement', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) =>
            /COUNT\(\*\)/.test(query) ? [{ count: 1 }] : [{ message: 'x', memo: 'Hello' }], { tokenDescription: false }));
        await db.getSearch(makeConfig({
            coin: 'RTEST',
            data: { method: 'getSearch', search: 'hello', type: 'broadcast', sql: { limit: 10 } }
        }));
        const calls = panelCalls(stub).filter(call => /broadcasts b/.test(call.args[1]));
        expect(calls).to.have.lengthOf(2);
        for(const call of calls){
            const sql = squash(call.args[1]);
            expect(sql).to.include('b.message LIKE ? OR ' + FOLDED);
            expect(sql).to.not.match(/m\.memo\s+LIKE/);
            expect(call.args[2]).to.deep.equal(['hello%', 'hello%']);
        }
    });
});
