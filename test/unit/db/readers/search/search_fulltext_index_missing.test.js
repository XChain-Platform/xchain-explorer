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

const { sinon, expect, makeConfig, makeDb } = require('../db_contract_meta.test/support/helpers.js');
const { DbQueryError }                     = require('../../../../../src/db/shared.js');

const searchCfg = () => makeConfig({
    coin: 'RTEST',
    data: { method: 'getSearch', search: 'escrow', type: 'contract', sql: { limit: 10 } }
});

function queryError(errno){
    return new DbQueryError('SQL query failed', Object.assign(new Error('query failed'), { errno }));
}

function countFor(query){
    if(/FROM index_addresses/.test(query)) return 1;
    if(/FROM transactions/.test(query))    return 2;
    if(/FROM broadcasts/.test(query))      return 3;
    if(/FROM tokens/.test(query))          return 4;
    return 5;
}

function stubSearch(db, failure, failPage){
    return sinon.stub(db, 'doQuery').callsFake(async (config, query) => {
        const isContract = /FROM\s+contracts/.test(query);
        const isPage     = /SELECT\s+m\.action_index/.test(query);
        if(isContract && isPage === failPage) throw failure;
        return [{ count: countFor(query) }];
    });
}

async function rejectionOf(promise){
    try {
        await promise;
    } catch(error){
        return error;
    }
    throw new Error('Expected promise to reject');
}

describe('Database#getSearch without a contract FULLTEXT index', function(){
    it('keeps the other totals when the contract count raises errno 1191', async function(){
        const db = makeDb();
        stubSearch(db, queryError(1191), false);

        const [data, second, total] = await db.getSearch(searchCfg());

        expect(data).to.deep.equal({
            data: [],
            totals: { addresses: 1, broadcasts: 3, contracts: 0, tokens: 4, transactions: 2 }
        });
        expect(second).to.equal(null);
        expect(total).to.equal(0);
    });

    it('empties the contract panel when its page query raises errno 1191', async function(){
        const db   = makeDb();
        const stub = stubSearch(db, queryError(1191), true);

        const [data, , total] = await db.getSearch(searchCfg());

        expect(data.data).to.deep.equal([]);
        expect(data.totals).to.deep.equal({
            addresses: 1, broadcasts: 3, contracts: 0, tokens: 4, transactions: 2
        });
        expect(total).to.equal(0);
        expect(stub.getCalls().filter(call => /FROM\s+contracts/.test(call.args[1]))).to.have.lengthOf(2);
    });

    for(const failPage of [false, true]){
        it('propagates a non-1191 contract ' + (failPage ? 'page' : 'count') + ' error', async function(){
            const db      = makeDb();
            const failure = queryError(1146);
            stubSearch(db, failure, failPage);

            expect(await rejectionOf(db.getSearch(searchCfg()))).to.equal(failure);
        });
    }
});
