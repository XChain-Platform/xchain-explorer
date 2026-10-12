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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const statements = require('../../../../src/db/action_detail/swaps_sql.js');

const EXPECTED_STATEMENTS = [
    'SWAP_DETAIL',
    'SWAP_EDITS',
    'SWAP_CANCEL_DETAIL',
    'SWAP_EDIT_DETAIL',
    'SWAP_EXPIRE_DETAIL',
    'SWAP_MATCH_DETAIL'
];

function expectValidSelect(sql) {
    const trimmed = sql.trim();
    expect(trimmed).to.match(/^SELECT\b/i);
    expect(trimmed).to.not.match(/;\s*\S/);
    expect(trimmed.match(/\?/g) || []).to.have.length(1);
}

describe('swap action-detail SQL', function() {
    it('exports exactly the documented statements', function() {
        expect(Object.keys(statements).sort()).to.deep.equal([...EXPECTED_STATEMENTS].sort());
    });

    it('defines each statement as a valid SELECT with one binding', function() {
        for(const name of EXPECTED_STATEMENTS) {
            expect(statements[name]).to.be.a('string').and.not.be.empty;
            expectValidSelect(statements[name]);
        }
    });

    it('limits detail reads but leaves the edits list unlimited', function() {
        for(const name of EXPECTED_STATEMENTS.filter((key) => key !== 'SWAP_EDITS'))
            expect(statements[name].trim()).to.match(/LIMIT 1$/i);
        expect(statements.SWAP_EDITS.trim()).to.not.match(/LIMIT 1$/i);
    });
});
