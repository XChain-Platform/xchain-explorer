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
const miscSql = require('../../../../src/db/action_detail/misc_sql.js');

const EXPECTED_BINDINGS = {
    ADDRESS_QUERY: 1,
    ADDRESS_QUERY2: 1,
    BATCH_QUERY: 1,
    BATCH_QUERY2: 2,
    BROADCAST_QUERY: 1,
    CALLBACK_QUERY: 1,
    FILE_QUERY: 1,
    MESSAGE_QUERY: 1,
    SLEEP_QUERY: 1,
    LIST_QUERY: 1,
    LIST_QUERY2: 1,
    LIST_QUERY3: 1,
    UNKNOWN_QUERY: 1
};

const QUERIES_WITHOUT_LIMIT = new Set([
    'BATCH_QUERY2',
    'LIST_QUERY2',
    'LIST_QUERY3'
]);

function expectQueryShape(sql) {
    const trimmed = sql.trim();
    expect(trimmed).to.match(/^SELECT\b/i);
    expect(trimmed).to.not.match(/;\s*\S/);
}

function expectBindings(sql, expectedCount) {
    expect(sql.match(/\?/g) || []).to.have.length(expectedCount);
}

describe('miscellaneous action-detail SQL', function() {
    it('exports exactly the expected queries', function() {
        expect(Object.keys(miscSql).sort()).to.deep.equal(
            Object.keys(EXPECTED_BINDINGS).sort()
        );
    });

    for(const [name, expectedBindings] of Object.entries(EXPECTED_BINDINGS)) {
        it(`exports a valid ${name} query`, function() {
            const sql = miscSql[name];
            expect(sql).to.be.a('string').and.not.be.empty;
            expectQueryShape(sql);
            expectBindings(sql, expectedBindings);

            if(!QUERIES_WITHOUT_LIMIT.has(name)) {
                expect(sql.trim()).to.match(/LIMIT\s+1$/i);
            }
        });
    }
});
