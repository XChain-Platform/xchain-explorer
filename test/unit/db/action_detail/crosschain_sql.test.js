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
const statements = require('../../../../src/db/action_detail/crosschain_sql.js');

const EXPECTED_STATEMENTS = {
    CROSS_SETTLE_DETAIL: ['cross_chain_settlements', 1],
    XCALL_DETAIL: ['xcalls', 1],
    XCALL_EXECUTION: ['cross_chain_call_executions', 1],
    XCALL_CALLBACK: ['cross_chain_call_callbacks', 1],
    XCALL_RESULT_DELIVERY: ['cross_chain_call_callbacks', 1],
    XCALL_CALLBACK_ACTION: ['xcalls', 1],
    XEXEC_DETAIL: ['cross_chain_call_executions', 1]
};

describe('cross-chain action-detail SQL', function() {
    it('exports the documented statements as non-empty strings', function() {
        expect(statements).to.have.all.keys(Object.keys(EXPECTED_STATEMENTS));
        for(const sql of Object.values(statements)) {
            expect(sql).to.be.a('string').and.not.be.empty;
        }
    });

    it('defines each statement as one unstacked SELECT', function() {
        for(const sql of Object.values(statements)) {
            expect(sql).to.match(/^SELECT\b/i);
            expect(sql.match(/\bSELECT\b/gi) || []).to.have.length(1);
            expect(sql).to.not.include(';');
        }
    });

    it('reads the documented table with the expected bindings', function() {
        for(const [name, [table, placeholderCount]] of Object.entries(EXPECTED_STATEMENTS)) {
            const sql = statements[name];
            expect(sql).to.match(new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, 'i'));
            expect(sql.match(/\?/g) || []).to.have.length(placeholderCount);
        }
    });
});
