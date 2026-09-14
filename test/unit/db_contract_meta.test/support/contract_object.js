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


function contractObjectOne() {
    it('names all four meta columns in its explicit column list', async function(){
        const db = makeDb();
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (c, query) => {
            if(captured === undefined) captured = query;
            return [contractRow()];
        });
        await db.getContract(contractCfg());
        for(const col of ['m.meta_name', 'm.meta_description', 'm.meta_version', 'm.meta_json'])
            expect(captured, 'contract SELECT is missing ' + col).to.include(col);
    });

    it('serves the three flat fields and the parsed meta object', async function(){
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([contractRow()]);
        const [data] = await db.getContract(contractCfg());
        expect(data.meta_name).to.equal('Escrow');
        expect(data.meta_description).to.equal('Two-party escrow with an arbiter');
        expect(data.meta_version).to.equal('2.0.0');
        expect(data.meta).to.deep.equal(META);
    });

    it('serves the parsed object only, never the raw meta_json string beside it', async function(){
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([contractRow()]);
        const [data] = await db.getContract(contractCfg());
        expect(data).to.not.have.property('meta_json');
    });

    it('carries unknown meta keys through, which is what meta_json is for', async function(){
        const db = makeDb();
        const wide = { name: 'Escrow', description: 'd', version: '1', author: 'someone', url: 'https://x' };
        sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: JSON.stringify(wide) })]);
        const [data] = await db.getContract(contractCfg());
        expect(data.meta).to.deep.equal(wide);
    });

    it('answers meta null for a contract that declared none', async function(){
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([contractRow({
            meta_name: null, meta_description: null, meta_version: null, meta_json: null
        })]);
        const [data] = await db.getContract(contractCfg());
        expect(data.meta).to.equal(null);
        expect(data.meta_name).to.equal(null);
    });

    it('answers meta null for malformed JSON rather than throwing or serving a string', async function(){
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: '{not json' })]);
        const [data] = await db.getContract(contractCfg());
        expect(data.meta).to.equal(null);
    });

}


function contractObjectTwo() {
    // metaJson is bounded and shape-checked in the isolate, but the column is a
    // TEXT the explorer does not own: a row holding a JSON array or scalar must
    // not reach a consumer as `meta`, which every reader treats as an object.
    it('answers meta null for JSON that is not a plain object', async function(){
        const db = makeDb();
        for(const raw of ['[1,2,3]', '"a string"', '42', 'null']){
            sinon.restore();
            sinon.stub(db, 'doQuery').resolves([contractRow({ meta_json: raw })]);
            const [data] = await db.getContract(contractCfg());
            expect(data.meta, 'meta_json ' + raw).to.equal(null);
        }
    });

}

module.exports = { contractObjectOne, contractObjectTwo };
