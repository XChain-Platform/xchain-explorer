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
    ACTION_BASELINE,
    ledgerEffectsQuery,
    ledgerEffectsBatchQuery
} = require('../../../../src/db/action_detail/shared_sql.js');

const EFFECT = { alias: 'x', table: 'some_table' };

function expectOrdered(sql, fragments) {
    let offset = -1;
    for(const fragment of fragments) {
        const nextOffset = sql.indexOf(fragment);
        expect(nextOffset).to.be.greaterThan(offset);
        offset = nextOffset;
    }
}

describe('shared action-detail SQL', function() {
    it('defines the action baseline lookup', function() {
        expect(ACTION_BASELINE).to.match(/FROM\s+actions\s+a1\b/);
        expect(ACTION_BASELINE).to.include('a1.action_index=?');
        expect(ACTION_BASELINE).to.match(/LIMIT 1\s*$/);
    });

    it('builds a single-action ledger effects query', function() {
        const sql = ledgerEffectsQuery(EFFECT);
        expect(sql).to.match(/FROM\s+some_table\b/);
        expect(sql).to.match(/JOIN\s+index_tickers\s+t1\b/);
        expect(sql).to.match(/JOIN\s+index_addresses\s+a1\b/);
        expect(sql).to.include('x.action_index=?');
        expectOrdered(sql, [
            'ORDER BY',
            't1.tick ASC',
            'CAST(x.amount as DECIMAL(64,18)) DESC',
            'a1.address ASC'
        ]);
        expect(sql).to.not.match(/\bIN\s*\(/);
        expect(sql).to.not.include('${');
    });

    it('builds a grouped ledger effects query for every action index', function() {
        const sql = ledgerEffectsBatchQuery(EFFECT, [1, 2, 3]);
        expect(sql).to.include('x.action_index as _group_index');
        expect(sql).to.include('x.action_index IN (?,?,?)');
        expectOrdered(sql, [
            'ORDER BY',
            'x.action_index ASC',
            't1.tick ASC',
            'CAST(x.amount as DECIMAL(64,18)) DESC',
            'a1.address ASC'
        ]);
        expect(sql).to.not.include('${');
    });
});
