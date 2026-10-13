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
const { withIndexProbe, panelCalls }      = require('./support/index_probe.js');

// /{COIN}/api/contracts/{QUERY}/name and its explorer twin, built the way the
// router builds them, so getData runs the real WHERE builder and getContracts.
function nameCfg(type, query){
    return makeConfig({ coin: 'RTEST', type, data: { method: 'getContracts', type: 'name', search: 'test', query } });
}

const contractStatements = stub => panelCalls(stub).filter(call => /FROM\s+contracts/.test(call.args[1]));

describe('Database#getContracts name lane without the meta_search FULLTEXT index', function(){
    for(const [type, query] of [['api', {}], ['explorer', { start: '0', length: '10', action: 'first' }]]){
        it('answers the empty page and runs no MATCH on the ' + type + ' route', async function(){
            const db   = makeDb();
            const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async () => [], { contractFulltext: false }));

            const [data, total] = await db.getData(nameCfg(type, query));

            expect(data).to.deep.equal([]);
            expect(total).to.equal(0);
            expect(contractStatements(stub)).to.have.lengthOf(0);
            expect(panelCalls(stub).some(call => /MATCH/.test(call.args[1]))).to.equal(false);
        });
    }

    it('keeps the MATCH, bound to the sanitized term, when the index exists', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async (config, sql) =>
            (/count\(\*\) as total/.test(sql) ? [{ total: 0 }] : [])));

        await db.getData(nameCfg('api', {}));

        const statements = contractStatements(stub);
        expect(statements).to.have.lengthOf(2);
        for(const call of statements){
            expect(call.args[1]).to.include('MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)');
            expect((call.args[1].match(/\?/g) || []).length).to.equal(call.args[2].length);
            expect(call.args[2]).to.deep.equal(['test']);
        }
    });

    it('probes the contracts table once per coin, not once per request', async function(){
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').callsFake(withIndexProbe(async () => [], { contractFulltext: false }));

        await db.getData(nameCfg('api', { limit: '10' }));
        await db.getData(nameCfg('api', { limit: '20' }));

        const probes = stub.getCalls().filter(call => /information_schema\.STATISTICS/.test(call.args[1]));
        expect(probes).to.have.lengthOf(1);
        expect(probes[0].args[2]).to.deep.equal(['contracts']);
    });
});
