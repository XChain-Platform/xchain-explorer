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
const { withIndexProbe }                   = require('./support/index_probe.js');

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
    if(/\btokens t1\b/.test(query))        return 4;
    return 5;
}

function stubSearch(db, failure, failPage){
    return sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) => {
        const isContract = /FROM\s+contracts/.test(query);
        const isPage     = /SELECT\s+m\.action_index/.test(query);
        if(isContract && isPage === failPage) throw failure;
        return [{ count: countFor(query) }];
    }));
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

const contractStatements = stub => stub.getCalls().filter(call => /FROM\s+contracts/.test(call.args[1]));

describe('Database#getSearch asks the schema probe before the contract MATCH', function(){
    it('runs no contract statement when the replica has no FULLTEXT index', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) => [{ count: countFor(query) }], { contractFulltext: false }));

        const [data, , total] = await db.getSearch(searchCfg());

        expect(contractStatements(stub)).to.have.lengthOf(0);
        expect(data.totals).to.deep.equal({ addresses: 1, broadcasts: 3, contracts: 0, tokens: 4, transactions: 2 });
        expect(total).to.equal(0);
    });

    it('probes STATISTICS for the schema the read lands in, bound by table name', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) => [{ count: countFor(query) }]));

        await db.getSearch(searchCfg());

        const probes = stub.getCalls().filter(call => /information_schema\.STATISTICS/.test(call.args[1]));
        expect(probes.map(call => call.args[2][0]).sort()).to.deep.equal(['contracts', 'tokens']);
        for(const call of probes) expect(call.args[1]).to.include('TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?');
    });

    // MATCH names its columns and only an index over exactly that set serves it.
    it('treats a FULLTEXT index over a different column set as absent', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
            if(/information_schema\.STATISTICS/.test(query))
                return args[0] === 'contracts' ? [{ INDEX_NAME: 'ft_name', INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'meta_name', SEQ_IN_INDEX: 1 }] : [];
            return [{ count: countFor(query) }];
        });
        await db.getSearch(searchCfg());
        expect(contractStatements(stub)).to.have.lengthOf(0);
    });

    it('asks the probe once per coin while the index is present', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, query) => [{ count: countFor(query) }]));

        await db.getSearch(searchCfg());
        await db.getSearch(searchCfg());

        const contractProbes = stub.getCalls().filter(call =>
            /information_schema\.STATISTICS/.test(call.args[1]) && call.args[2][0] === 'contracts');
        expect(contractProbes).to.have.lengthOf(1);
        // A count and a page per search, since the contract panel was asked for.
        expect(contractStatements(stub)).to.have.lengthOf(4);
    });

});

describe('Database#getSearch when the probe answer is wrong', function(){
    it('skips the MATCH on the next search after a count raised errno 1191', async function(){
        const db   = makeDb();
        const stub = stubSearch(db, queryError(1191), false);

        await db.getSearch(searchCfg());
        const [data] = await db.getSearch(searchCfg());

        expect(contractStatements(stub)).to.have.lengthOf(1);
        expect(data.totals.contracts).to.equal(0);
    });

    it('runs the MATCH when the probe itself fails, leaving 1191 as the backstop', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(async (config, query) => {
            if(/information_schema\.STATISTICS/.test(query)) throw queryError(1142);
            return [{ count: countFor(query) }];
        });

        const [data] = await db.getSearch(searchCfg());

        expect(contractStatements(stub)).to.have.lengthOf(2);
        expect(data.totals.contracts).to.equal(5);
    });
});
