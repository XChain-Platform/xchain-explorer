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
 * Golden pin on the per-action detail registry (src/action-detail/), the
 * decomposition of the old ~2,600-line getActionData if-chain.
 *
 * The whole point of the extraction is that behaviour did NOT change, so the
 * pin is byte-level: for every action type, in two result modes, the exact SQL
 * getActionData issues and the exact object it returns must match
 * test/fixtures/action-detail-golden.json, which was captured from the
 * pre-extraction if-chain. A handler that drops a column, reorders a join,
 * loses a follow-up query or stops shaping a field fails here.
 *
 * Regenerate deliberately (never to make this go green):
 *     node bin/gen-action-detail-golden.js
 * and review the diff - each line is a rendered field on a public action page.
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const { captureActionType, stableStringify } = require('../fixtures/action-detail-capture.js');
const { REGISTRY, ACTION_TYPES, getHandler }  = require('../../src/action-detail');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'action-detail-golden.json'), 'utf8'));
const sqlText = (indices) => indices.map((i) => GOLDEN.statements[i]);

// Every hook getActionData actually calls. A handler key outside this set is a
// typo that would silently never run (the old if-chain had no such failure mode,
// so the registry has to grow its own guard).
const HOOKS = ['effects', 'queries', 'afterMain', 'query2Args', 'query3Args', 'afterQuery2', 'afterQuery3', 'afterQueries', 'afterEffects'];

describe('action-detail registry @regression', function () {
    this.timeout(20000);

    describe('registry shape', function () {
        it('covers exactly the action types the golden was captured for', function () {
            const expected = Object.keys(GOLDEN.captures).filter((t) => t !== 'NOT_A_REAL_ACTION').sort();
            assert.deepStrictEqual(ACTION_TYPES, expected,
                'the registry gained or lost an action type without the golden being regenerated; ' +
                'run node bin/gen-action-detail-golden.js and review the diff');
        });

        it('every handler exposes only hooks getActionData calls', function () {
            const bad = [];
            for (const [type, handler] of Object.entries(REGISTRY)) {
                for (const key of Object.keys(handler))
                    if (!HOOKS.includes(key)) bad.push(type + '.' + key);
            }
            assert.deepStrictEqual(bad, [], 'handler hook(s) that getActionData never calls (typo?): ' + JSON.stringify(bad));
        });

        it('every handler builds at least a detail query', function () {
            const missing = Object.entries(REGISTRY).filter(([, h]) => typeof h.queries !== 'function').map(([t]) => t);
            assert.deepStrictEqual(missing, [], 'handler(s) with no queries() would render the de-blank baseline only: ' + JSON.stringify(missing));
        });

        it('an unregistered action type falls back to the empty handler, not a throw', function () {
            const handler = getHandler('NOT_A_REAL_ACTION');
            assert.ok(handler && typeof handler === 'object');
            assert.strictEqual(handler.queries, undefined);
        });

        it('DEPOSIT and WITHDRAW share one handler (one row shape, two action names)', function () {
            assert.strictEqual(REGISTRY.DEPOSIT, REGISTRY.WITHDRAW);
        });

        it('the ledger-effect opt-outs are exactly the four non-ledger actions', function () {
            const optedOut = Object.entries(REGISTRY)
                .filter(([, h]) => h.effects && (h.effects.credits === false || h.effects.debits === false || h.effects.escrows === false))
                .map(([t]) => t).sort();
            assert.deepStrictEqual(optedOut, ['ADDRESS', 'BROADCAST', 'NODEPROOF', 'XCALL'],
                'an action changed whether it queries credits/debits/escrows');
        });
    });

    describe('behaviour is byte-identical to the pre-extraction if-chain', function () {
        for (const type of Object.keys(GOLDEN.captures)) {
            for (const mode of ['empty', 'rows']) {
                it(type + ' (' + mode + ' results) issues the same SQL and returns the same shape', async function () {
                    const expected = GOLDEN.captures[type][mode];
                    const actual   = await captureActionType(type, mode);
                    assert.deepStrictEqual(actual.sql, sqlText(expected.sql),
                        type + ' (' + mode + '): the statements getActionData issues changed');
                    assert.strictEqual(stableStringify(actual.result), stableStringify(expected.result),
                        type + ' (' + mode + '): the object getActionData returns changed');
                });
            }
        }
    });

    // The item this extraction closes is a god-file regression: the if-chain had
    // grown from 2,105 to ~2,667 lines because every new action was appended to
    // it. Pin the method small so the chain cannot quietly grow back inside db.js.
    describe('getActionData stays a pipeline', function () {
        function getActionDataBody() {
            const src    = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db.js'), 'utf8');
            const marker = 'async getActionData(';
            const start  = src.indexOf(marker);
            assert.ok(start >= 0, 'getActionData not found in src/db.js');
            const rest = src.slice(start + marker.length);
            const next = rest.match(/\n {4}(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/);
            return next ? rest.slice(0, next.index) : rest;
        }

        it('holds no per-action-type branches (those belong in a handler)', function () {
            const body    = getActionDataBody().replace(/\/\/.*$/gm, '');
            const branches = [...new Set([...body.matchAll(/type\s*==\s*["']([A-Z_]+)["']/g)].map((m) => m[1]))];
            assert.deepStrictEqual(branches, [],
                'per-action branch(es) re-appeared inside getActionData: ' + JSON.stringify(branches) +
                '. Add a handler in src/action-detail/ instead of a branch here.');
        });

        // 89 lines at extraction time (down from ~2,667). The cap leaves room for
        // a genuine pipeline change and still trips long before an if-chain grows
        // back, which is exactly how the original got to 2,667 lines.
        it('stays under 130 lines', function () {
            const size = getActionDataBody().split('\n').length;
            assert.ok(size < 130, 'getActionData is ' + size + ' lines; it is the shared pipeline only, ' +
                'so growth means action-specific code leaked back in - put it in a src/action-detail/ handler');
        });
    });
});
