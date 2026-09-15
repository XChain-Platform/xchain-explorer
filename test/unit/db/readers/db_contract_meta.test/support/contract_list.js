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


function contractListTests() {

    it('names all four meta columns in its explicit column list', async function(){
        const db = makeDb();
        const [query] = await db.getContracts(makeConfig({ data: { method: 'getContracts' } }));
        for(const col of ['m.meta_name', 'm.meta_description', 'm.meta_version', 'm.meta_json'])
            expect(query, 'contracts SELECT is missing ' + col).to.include(col);
    });

    it('binds nothing of its own on the block/address/source lanes', async function(){
        const db = makeDb();
        const [, args] = await db.getContracts(makeConfig({ data: { method: 'getContracts', type: 'source', search: 'addr1' } }));
        expect(args).to.equal(null);
    });

    it('binds the SANITIZED term on the name lane, not the raw path segment', async function(){
        const db = makeDb();
        const [, args] = await db.getContracts(makeConfig({
            data: { method: 'getContracts', type: 'name', search: '+escrow* -"vault"' }
        }));
        expect(args).to.deep.equal(['escrow vault']);
    });

    it('answers the empty page when the term sanitizes to nothing usable', async function(){
        const db = makeDb();
        const [data, args, total] = await db.getContracts(makeConfig({
            data: { method: 'getContracts', type: 'name', search: '+++*' }
        }));
        expect(data).to.deep.equal([]);
        expect(args).to.equal(null);
        expect(total).to.equal(0);
    });

    it('filters the name lane through the FULLTEXT index, not with LIKE', async function(){
        const db = makeDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'name' } }));
        expect(sql).to.include('MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)');
        expect(sql).to.not.include('LIKE');
    });

    it('leaves the other contract lanes exactly as they were', async function(){
        const db = makeDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getContracts', type: 'source' } }));
        expect(sql).to.include('a2.address=?');
        expect(sql).to.not.include('MATCH');
    });

    // The list rows go through getData, which is where meta_json is parsed for a
    // page of rows; the shared helper is driven directly here.
    it('gives every list row the same parsed meta the single-contract route serves', function(){
        const db = makeDb();
        const row = db.attachContractMeta({ action_index: 5, meta_name: 'Escrow', meta_json: JSON.stringify(META) });
        expect(row.meta).to.deep.equal(META);
        expect(row).to.not.have.property('meta_json');
    });

}

module.exports = { contractListTests };
