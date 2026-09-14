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

const sinon = require('sinon');
const { contractObjectOne, contractObjectTwo } = require('./contract_object.js');
const { contractListTests } = require('./contract_list.js');
const { sanitizerTests } = require('./sanitizer.js');
const { payloadTests } = require('./payloads.js');
const { searchTestsOne, searchTestsTwo } = require('./search.js');

describe('contract identity manifest: the explorer side', function(){
    afterEach(() => sinon.restore());

    describe('the contract object (getContract)', contractObjectOne);
    describe('the contract object (getContract)', contractObjectTwo);
    describe('the contract list (getContracts)', contractListTests);
    describe('the BOOLEAN MODE term sanitizer', sanitizerTests);
    describe('the EXECUTE / DEPOSIT / WITHDRAW payloads', payloadTests);
    describe('global search: contract is the fifth category', searchTestsOne);
    describe('global search: contract is the fifth category', searchTestsTwo);
});
