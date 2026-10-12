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
const statements = require('../../../../src/db/action_detail/orders_sql.js');

const EXPECTED_PLACEHOLDERS = {
    ORDER_DETAIL: 1,
    ORDER_EDITS: 1,
    ORDER_MATCHES: 2,
    ORDER_CANCEL_DETAIL: 1,
    ORDER_EDIT_DETAIL: 1,
    ORDER_EXPIRE_DETAIL: 1,
    ORDER_MATCH_DETAIL: 1
};
const DETAIL_STATEMENTS = [
    'ORDER_DETAIL',
    'ORDER_CANCEL_DETAIL',
    'ORDER_EDIT_DETAIL',
    'ORDER_EXPIRE_DETAIL',
    'ORDER_MATCH_DETAIL'
];
const LIST_STATEMENTS = ['ORDER_EDITS', 'ORDER_MATCHES'];

describe('order action-detail SQL', function() {
    it('exports exactly the documented statements', function() {
        expect(statements).to.have.all.keys(Object.keys(EXPECTED_PLACEHOLDERS));
    });

    it('defines SELECT statements with the expected bindings', function() {
        for(const [name, placeholderCount] of Object.entries(EXPECTED_PLACEHOLDERS)) {
            const sql = statements[name];
            expect(sql).to.be.a('string').and.not.be.empty;
            expect(sql).to.match(/^SELECT\b/i);
            expect(sql).to.not.match(/;\s*\S/);
            expect(sql.match(/\?/g) || []).to.have.length(placeholderCount);
        }
    });

    it('limits detail statements to one row', function() {
        for(const name of DETAIL_STATEMENTS) {
            expect(statements[name]).to.match(/LIMIT 1\s*$/i);
        }
    });

    it('leaves list statements unlimited', function() {
        for(const name of LIST_STATEMENTS) {
            expect(statements[name]).to.not.match(/LIMIT 1\s*$/i);
        }
    });
});
