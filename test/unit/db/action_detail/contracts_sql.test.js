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
const contractsSql = require('../../../../src/db/action_detail/contracts_sql.js');

const LIMITED_STATEMENTS = [
    'ACTION_FORMAT_PROBE',
    'DEPLOY_CHUNK_DETAIL',
    'DEPLOY_CONTRACT_DETAIL',
    'DEPLOY_CARRIER_CONTRACT',
    'DEPLOY_ASSEMBLER',
    'EXECUTE_DETAIL'
];

function expectSelectWithBindings(sql, expectedCount) {
    expect(sql).to.be.a('string').and.not.be.empty;
    const trimmed = sql.trim();
    const executableSql = trimmed.replace(/--.*$/gm, '');
    expect(trimmed).to.match(/^SELECT\b/i);
    expect(executableSql).to.not.match(/;\s*\S/);
    expect(trimmed.match(/\?/g) || []).to.have.length(expectedCount);
}

function expectLimitedSelect(sql) {
    expectSelectWithBindings(sql, 1);
    expect(sql.trim()).to.match(/\bLIMIT\s+1$/i);
}

describe('contract action-detail SQL', function() {
    for(const name of LIMITED_STATEMENTS) {
        it(`exports a single-row ${name} query`, function() {
            expectLimitedSelect(contractsSql[name]);
        });
    }

    it('exports the ordered EXECUTE_EMISSIONS query without a row limit', function() {
        const sql = contractsSql.EXECUTE_EMISSIONS;
        expectSelectWithBindings(sql, 1);
        expect(sql).to.not.match(/\bLIMIT\s+1\b/i);
        expect(sql.trim()).to.match(/\bORDER\s+BY\s+position\s+ASC$/i);
    });

    for(const table of ['deposits', 'withdrawals']) {
        it(`builds the ${table} detail query`, function() {
            const sql = contractsSql.depositWithdrawDetail(table);
            expectLimitedSelect(sql);
            expect(sql).to.match(new RegExp(`\\bFROM\\s+${table}\\s+m\\b`, 'i'));
        });
    }

    it('changes only the custody table between deposit and withdrawal queries', function() {
        const depositSql = contractsSql.depositWithdrawDetail('deposits');
        const withdrawalSql = contractsSql.depositWithdrawDetail('withdrawals');
        expect(withdrawalSql.replace('withdrawals m', 'deposits m')).to.equal(depositSql);
    });
});
