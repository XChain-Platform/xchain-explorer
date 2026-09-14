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


function sanitizerTests() {

    it('strips every character BOOLEAN MODE reads as an operator', function(){
        const db = makeDb();
        expect(db.fulltextTerm('+escrow -vault ~auction *star "quoted" (group) <a> @1'))
            .to.equal('escrow vault auction star quoted group a 1');
    });

    it('holds the term to the same 3-character floor as the LIKE panels', function(){
        const db = makeDb();
        expect(db.fulltextTerm('ab')).to.equal('');
        expect(db.fulltextTerm('  a  ')).to.equal('');
        expect(db.fulltextTerm('esc')).to.equal('esc');
    });

    it('answers empty for an absent term instead of binding the word null', function(){
        const db = makeDb();
        expect(db.fulltextTerm(null)).to.equal('');
        expect(db.fulltextTerm(undefined)).to.equal('');
    });

}

module.exports = { sanitizerTests };
