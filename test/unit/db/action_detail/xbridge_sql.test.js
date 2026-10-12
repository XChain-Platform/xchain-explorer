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
const {
    BRIDGE_SETTLEMENTS_TABLE,
    XBRIDGE_SETTLEMENT,
    XBRIDGES_TABLE,
    XBRIDGE_RECORD
} = require('../../../../src/db/action_detail/xbridge_sql.js');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OTHER_INPUT_MARKER = /\$\{|\{\{|:[A-Za-z_][A-Za-z0-9_]*|\$[1-9][0-9]*|%[sd]/;
const SQL_FRAGMENTS = [
    [BRIDGE_SETTLEMENTS_TABLE, XBRIDGE_SETTLEMENT],
    [XBRIDGES_TABLE, XBRIDGE_RECORD]
];

describe('XBRIDGE SQL constants', function() {
    it('exports table names that are safe plain identifiers', function() {
        expect(BRIDGE_SETTLEMENTS_TABLE).to.match(IDENTIFIER);
        expect(XBRIDGES_TABLE).to.match(IDENTIFIER);
    });

    it('keeps each query tied to its table and uses only question-mark binding', function() {
        for(const [table, sql] of SQL_FRAGMENTS) {
            expect(sql).to.match(new RegExp(`\\b${table}\\b`));
            expect(sql).to.not.match(OTHER_INPUT_MARKER);
            expect(sql.match(/\?/g) || []).to.have.length(1);
        }
    });
});
