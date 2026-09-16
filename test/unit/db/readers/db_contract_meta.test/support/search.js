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
 * The contract identity manifest, on the reader side: the four meta columns
 * the indexer stores for a conforming deploy and the surfaces that show them.
 *
 * A contract now carries a declared name, description and version, extracted
 * into four columns and a FULLTEXT index by the indexer. Everything here is
 * about what the EXPLORER does with them: which columns each contract query
 * names, what the parsed `meta` object is when meta_json is not a plain object,
 * and the two search paths that read the index rather than scanning with LIKE.
 *
 * The MATCH lanes get the most attention, because they are the only queries in
 * this service whose bound value has query-language meaning: MATCH ... AGAINST
 * (? IN BOOLEAN MODE) reads +, -, ~, *, ", ( ), < > and @ inside the value as
 * operators, so a term is sanitized before it is bound and a term with nothing
 * left is answered as no results rather than as a match on everything.
 *********************************************************************/

'use strict';

const { sinon, expect, makeConfig, makeDb, META, contractRow, contractCfg } = require('./helpers.js');

const searchCfg = (type) => makeConfig({
    coin: 'RBTC',
    data: { method: 'getSearch', search: 'escrow', type, sql: { limit: 10 } }
});


function searchTestsOne() {
    // Counts run first, one query per category, then the matched category's rows.
    function stubSearch(db, counts, rows){
        let call = 0;
        return sinon.stub(db, 'doQuery').callsFake(async () => {
            if(call < counts.length) return [{ count: counts[call++] }];
            call++;
            return rows;
        });
    }

    it('reports a contracts total on every search, typed or not', async function(){
        const db = makeDb();
        stubSearch(db, [0, 0, 0, 0, 3], []);
        const [data] = await db.getSearch(searchCfg('address'));
        expect(data.totals).to.have.property('contracts', 3);
    });

    // The short-term guard returns before any read; a search UI reads the whole
    // totals map, so the contracts key has to be there to be zero.
    it('reports contracts: 0 on a term too short to search at all', async function(){
        const db = makeDb();
        const spy = sinon.spy(db, 'doQuery');
        const cfg = searchCfg('contract');
        cfg.data.search = 'ab';
        const [data, , total] = await db.getSearch(cfg);
        expect(data.totals.contracts).to.equal(0);
        expect(total).to.equal(0);
        expect(spy.callCount).to.equal(0);
    });

    it('counts contracts through the FULLTEXT index rather than with LIKE', async function(){
        const db = makeDb();
        const queries = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
        await db.getSearch(searchCfg('address'));
        const contractCount = queries.find((q) => /FROM contracts/.test(q));
        expect(contractCount, 'no contract count query ran').to.be.a('string');
        expect(contractCount).to.include('MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)');
    });

    it('runs no contract query at all when the term is nothing but operators', async function(){
        const db = makeDb();
        const queries = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
        const cfg = searchCfg('address');
        cfg.data.search = '+++***';
        const [data] = await db.getSearch(cfg);
        expect(queries.some((q) => /FROM contracts/.test(q)), 'a contract query ran on an empty term').to.equal(false);
        expect(data.totals.contracts).to.equal(0);
    });

}


function searchTestsTwo() {
    it('binds the sanitized term, not the LIKE pattern, on the contract rows query', async function(){
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
            calls.push({ q, a });
            return /FROM contracts/.test(q) && /SELECT\s+m\.action_index/.test(q)
                ? [{ action_index: 42, meta_name: 'Escrow', meta_version: '2.0.0', meta_description: 'Two-party escrow' }]
                : [{ count: 1 }];
        });
        await db.getSearch(searchCfg('contract'));
        const rowsCall = calls.find((c) => /ORDER BY m.action_index DESC/.test(c.q));
        expect(rowsCall, 'no contract rows query ran').to.be.an('object');
        expect(rowsCall.a).to.deep.equal(['escrow']);
        expect(String(rowsCall.a[0])).to.not.include('%');
    });

    it('shapes a hit as name, version, derived address and a description snippet', async function(){
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/ORDER BY m.action_index DESC/.test(q))
                return [{ action_index: 42, meta_name: 'Escrow', meta_version: '2.0.0', meta_description: 'Two-party escrow' }];
            return [{ count: 1 }];
        });
        const [data] = await db.getSearch(searchCfg('contract'));
        expect(data.data).to.deep.equal([{
            action_index:     42,
            contract_address: 'C:BTC:42',
            meta_name:        'Escrow',
            meta_version:     '2.0.0',
            snippet:          'Two-party escrow'
        }]);
    });

    it('bounds the snippet so one description cannot take over the results list', async function(){
        const db = makeDb();
        const long = 'x'.repeat(512);
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/ORDER BY m.action_index DESC/.test(q))
                return [{ action_index: 42, meta_name: 'Escrow', meta_version: null, meta_description: long }];
            return [{ count: 1 }];
        });
        const [data] = await db.getSearch(searchCfg('contract'));
        expect(data.data[0].snippet).to.have.lengthOf(160);
        expect(data.data[0].snippet.endsWith('…')).to.equal(true);
        expect(data.data[0].meta_version).to.equal(null);
    });

    it('leaves the four LIKE panels untouched', async function(){
        const db = makeDb();
        const queries = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => { queries.push(q); return [{ count: 0 }]; });
        await db.getSearch(searchCfg('address'));
        const likePanels = queries.filter((q) => /LIKE LOWER/.test(q));
        expect(likePanels).to.have.lengthOf(4);
    });

}

module.exports = { searchTestsOne, searchTestsTwo };
