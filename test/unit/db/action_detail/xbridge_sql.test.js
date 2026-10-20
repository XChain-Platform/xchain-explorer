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
    listSnapshotSql,
    LIST_SNAPSHOTS_TABLE,
    policySnapshotSql,
    POLICY_SNAPSHOTS_TABLE,
    XBRIDGE_SETTLEMENT,
    XBRIDGES_TABLE,
    XBRIDGE_RECORD
} = require('../../../../src/db/action_detail/xbridge_sql.js');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OTHER_INPUT_MARKER = /\$\{|\{\{|:[A-Za-z_][A-Za-z0-9_]*|\$[1-9][0-9]*|%[sd]/;
// The snapshot reads name the hub schema's table and bind the snapshot id and its network.
const POLICY_SNAPSHOT = policySnapshotSql('`hub`.' + POLICY_SNAPSHOTS_TABLE);
const LIST_SNAPSHOT = listSnapshotSql('`hub`.' + LIST_SNAPSHOTS_TABLE);
const SQL_FRAGMENTS = [
    [BRIDGE_SETTLEMENTS_TABLE, XBRIDGE_SETTLEMENT, 1],
    [XBRIDGES_TABLE, XBRIDGE_RECORD, 1],
    ['`hub`\\.' + POLICY_SNAPSHOTS_TABLE, POLICY_SNAPSHOT, 2],
    ['`hub`\\.' + LIST_SNAPSHOTS_TABLE, LIST_SNAPSHOT, 2]
];

// The member-list counts the XPOLICY and LIST_SHARE cards render, by query.
const SNAPSHOT_COUNTS = [
    [POLICY_SNAPSHOT, { allow_list: 'allow_count', block_list: 'block_count' }],
    [LIST_SNAPSHOT, { added: 'added_count', removed: 'removed_count' }]
];

describe('XBRIDGE SQL constants', function() {
    it('exports table names that are safe plain identifiers', function() {
        expect(BRIDGE_SETTLEMENTS_TABLE).to.match(IDENTIFIER);
        expect(XBRIDGES_TABLE).to.match(IDENTIFIER);
        expect(POLICY_SNAPSHOTS_TABLE).to.match(IDENTIFIER);
        expect(LIST_SNAPSHOTS_TABLE).to.match(IDENTIFIER);
    });

    it('counts each snapshot member list in SQL and never ships the list itself', function() {
        for(const [sql, counts] of SNAPSHOT_COUNTS) {
            for(const [column, alias] of Object.entries(counts)) {
                const guarded = `CASE WHEN JSON_VALID(${column}) THEN JSON_LENGTH(${column}) END AS ${alias}`;
                expect(sql).to.contain(guarded);
                const rest = sql.split(guarded).join('');
                expect(rest).to.not.match(new RegExp(`\\b${column}\\b`), `${column} is selected raw`);
            }
        }
        expect(POLICY_SNAPSHOT).to.match(/\bsleeping\b/);
    });

    it('keeps each query tied to its table and uses only question-mark binding', function() {
        for(const [table, sql, binds] of SQL_FRAGMENTS) {
            expect(sql).to.match(new RegExp(`FROM\\s+${table}\\b`));
            expect(sql).to.not.match(OTHER_INPUT_MARKER);
            expect(sql.match(/\?/g) || []).to.have.length(binds);
        }
    });
});
