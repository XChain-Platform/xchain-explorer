/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Lint over the captured detail SQL: no per-action column may be selected
 * under a name getActionData reserves for a generic payload slot.
 *
 * The golden pin next door records whatever the queries do, collision and all,
 * so it cannot catch this class; this file states the invariant instead. It
 * reads the same generated fixture, so a new handler is covered on the next
 * regen with no per-action maintenance.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'action-detail-golden.json'), 'utf8'));

// Slots getActionData assigns AFTER the handler runs: credits/debits/escrows/fee are
// seeded before the main row and fee is refilled from getActionFeeData, tx_data last.
// A detail query selecting one of these names has its value silently overwritten by the
// generic record and the renderer prints '[object Object]'. This has recurred across
// several action types; the fix is always an alias, e.g. `f.fee as bet_fee`.
const RESERVED = ['credits', 'debits', 'escrows', 'fee', 'tx_data'];

// The transactions lookup selects t1.fee, but getActionData reads only txData.data from
// it, so that column never reaches the payload. Only entry allowed here: a second one
// means a real collision is being waved through.
const ALLOW = [/SELECT t1\.tx_index, t1\.block_index, t2\.hash, t1\.fee, t1\.data/];

describe('action-detail queries never select into a reserved payload slot @regression', function () {
    it('every selected column that shadows a generic slot is aliased', function () {
        const hits = [];
        GOLDEN.statements.forEach((s, i) => {
            if(ALLOW.some((re) => re.test(s))) return;
            // Scope the scan to the SELECT list so a `WHERE x.fee = ?` cannot false-positive,
            // and judge each item by its LAST token: that is the output name, whether the
            // item carries an `as` alias or a leading `--` comment (the fixture collapses
            // newlines, so a comment otherwise runs into the column it annotates).
            const select = s.split(/\sFROM\s/i)[0];
            select.split(',').forEach((item) => {
                const out = item.trim().split(/\s+/).pop() || '';
                for(const r of RESERVED)
                    if(new RegExp('^[a-z0-9_]+\\.' + r + '$', 'i').test(out))
                        hits.push('statement ' + i + ' selects an unaliased `' + r + '`: ' + item.trim());
            });
        });
        assert.deepStrictEqual(hits, [],
            'alias the column (e.g. `f.fee as bet_fee`) and read the alias in the renderer:\n' + hits.join('\n'));
    });
});
