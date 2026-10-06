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
const stakingSql = require('../../../../src/db/action_detail/staking_sql.js');

const EXPECTED_BINDINGS = {
    COLLECT_DETAIL: 1,
    DELEGATE_DETAIL: 1,
    DELEGATE_CONTRACT_REVOKE_PARENT: 4,
    DELEGATE_CAPABILITY_REVOKE_PARENT: 2,
    SLASH_DETAIL: 1,
    STAKE_DETAIL: 1,
    UNSTAKE_DETAIL: 1
};

function expectSingleSelect(sql) {
    const trimmed = sql.trim();
    expect(trimmed).to.match(/^SELECT\b/i);
    expect(trimmed.match(/\bSELECT\b/gi) || []).to.have.length(1);
    expect(trimmed).to.not.match(/;\s*\S/);
}

function expectBindings(sql, expectedCount) {
    const whereClause = sql.match(/\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i);
    expect(whereClause).to.not.equal(null);
    expect(whereClause[1].match(/\?/g) || []).to.have.length(expectedCount);
    expect(sql.match(/\?/g) || []).to.have.length(expectedCount);
}

describe('staking action-detail SQL', function() {
    for(const [name, expectedBindings] of Object.entries(EXPECTED_BINDINGS)) {
        it(`exports a valid ${name} query`, function() {
            const sql = stakingSql[name];
            expect(sql).to.be.a('string').and.not.be.empty;
            expectSingleSelect(sql);
            expectBindings(sql, expectedBindings);
        });
    }
});

describe('SLASH detail status', function() {
    it('selects a status derived from the slash event row, so the page never shows a bare dash', function() {
        const flat = stakingSql.SLASH_DETAIL.replace(/\s+/g, ' ');
        // The indexer writes capability_slash_events for a valid proof and only for one.
        expect(flat).to.include("CASE WHEN m.slash_action_index IS NULL THEN 'invalid' ELSE 'valid' END as status");
        expect(flat).to.include('LEFT JOIN capability_slash_events m ON (m.slash_action_index=a1.action_index)');
    });
});
