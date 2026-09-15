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

const handlers = require('../../../../src/action-detail/contracts.js');
const { expect, setupSqlite, seed, run } = require('./helpers.js');


// EXECUTE / DEPOSIT / WITHDRAW name a contract by index; the identity comes off
// the contracts row through a LEFT JOIN, so a call against a pre-activation
// contract still answers the row (with nulls) rather than disappearing.
// Driven against the shipped SQL rather than matched as text: a JOIN written on
// the wrong key type-checks fine and answers the wrong contract.
function payloadTests() {
    beforeEach(setupSqlite);

        it('an EXECUTE answers the called contract name and version', function(){
            const sq = seed();
            sq.exec(`INSERT INTO contract_executions VALUES (700, 42, 1, 'release', NULL, 10, 100, 0, NULL, 1)`);
            const row = run(sq, handlers.EXECUTE.queries().query, 700);
            expect(row.contract_index).to.equal(42);
            expect(row.contract_meta_name).to.equal('Escrow');
            expect(row.contract_meta_version).to.equal('2.0.0');
        });

        it('an EXECUTE against a pre-activation contract still answers, with nulls', function(){
            const sq = seed();
            sq.exec(`INSERT INTO contract_executions VALUES (700, 43, 1, 'release', NULL, 10, 100, 0, NULL, 1)`);
            const row = run(sq, handlers.EXECUTE.queries().query, 700);
            expect(row, 'the LEFT JOIN must not drop the execution row').to.be.an('object');
            expect(row.contract_meta_name).to.equal(null);
        });

        it('a DEPOSIT answers the custody contract name and version', function(){
            const sq = seed();
            sq.exec(`INSERT INTO deposits VALUES (800, 42, 1, 1, '100', 1)`);
            const row = run(sq, handlers.DEPOSIT.queries({ type: 'DEPOSIT' }).query, 800);
            expect(row.contract_meta_name).to.equal('Escrow');
            expect(row.contract_meta_version).to.equal('2.0.0');
            expect(row.tick).to.equal('XCHAIN');
        });

        it('WITHDRAW shares the shape, on its own table', function(){
            const sq = seed();
            sq.exec('CREATE TABLE withdrawals (action_index INTEGER, contract_index INTEGER, source_id INTEGER, tick_id INTEGER, amount TEXT, status_id INTEGER)');
            sq.exec(`INSERT INTO withdrawals VALUES (800, 42, 1, 1, '100', 1)`);
            const row = run(sq, handlers.WITHDRAW.queries({ type: 'WITHDRAW' }).query, 800);
            expect(row.contract_meta_name).to.equal('Escrow');
        });

}

module.exports = { payloadTests };
