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
 *********************************************************************
 * The query-plan guard's ratchet and rig: the allowlist both fails a new
 * offender and a stale entry, the seed fills every column it can, and the
 * probe list follows the route table.
 */

'use strict';

const assert = require('assert');

const allowlist = require('../../conformance/schema_conformance.test/support/plan_allowlist.js');
const seed      = require('../../conformance/schema_conformance.test/support/plan_seed.js');
const capture   = require('../../conformance/schema_conformance.test/support/plan_capture.js');

describe('plan guard allowlist: parsing', function () {
    it('reads keys and reasons, skipping comments and blank lines', function () {
        const { entries, errors } = allowlist.parseAllowlist(
            '# header\n\ngetSends all count sends scan | unfiltered count\n');
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(entries.get('getSends all count sends scan'), 'unfiltered count');
    });

    it('refuses a line without a reason, a short key and a repeated key', function () {
        const { errors } = allowlist.parseAllowlist([
            'getSends all count sends scan',
            'getSends all count scan | short',
            'getIssues all count issues scan | one',
            'getIssues all count issues scan | two'
        ].join('\n'));
        assert.strictEqual(errors.length, 3);
        assert.match(errors[2], /repeats getIssues all count issues scan/);
    });

    it('ships a well-formed allowlist file', function () {
        assert.deepStrictEqual(allowlist.readAllowlist().errors, []);
    });
});

describe('plan guard allowlist: the ratchet', function () {
    const entries = new Map([['getSends all count sends scan', 'kept reason'],
        ['getIssues all count issues scan', 'fixed since']]);
    const observed = new Map([['getSends all count sends scan', 'derived'],
        ['getLinks token row links scan', 'new offender']]);

    it('names a new offender with a copy-ready line', function () {
        assert.deepStrictEqual(allowlist.reconcile(entries, observed).offenders,
            ['getLinks token row links scan | new offender']);
    });

    it('names an entry that stopped offending as stale', function () {
        assert.deepStrictEqual(allowlist.reconcile(entries, observed).stale,
            ['getIssues all count issues scan | fixed since']);
    });

    it('rewrites the list from the run, keeping the reasons already written', function () {
        const text = allowlist.renderAllowlist(entries, observed);
        const { entries: back } = allowlist.parseAllowlist(text);
        assert.deepStrictEqual([...back.keys()], ['getLinks token row links scan', 'getSends all count sends scan']);
        assert.strictEqual(back.get('getSends all count sends scan'), 'kept reason');
    });
});

describe('plan guard seed', function () {
    it('fills numbers, strings and times from the row number and leaves enums to their default', function () {
        assert.strictEqual(seed.seedExpression('bigint'), 'seq');
        assert.strictEqual(seed.seedExpression('varchar'), 'CAST(seq AS CHAR)');
        assert.strictEqual(seed.seedExpression('datetime'), 'FROM_UNIXTIME(1700000000 + seq * 600)');
        assert.strictEqual(seed.seedExpression('enum'), null);
    });

    it('builds one INSERT IGNORE from the sequence, skipping generated columns', function () {
        const stmt = seed.seedStatement('db', 'sends', [
            { name: 'action_index', dataType: 'int', extra: '' },
            { name: 'tick_lc', dataType: 'varchar', extra: 'VIRTUAL GENERATED' },
            { name: 'status', dataType: 'enum', extra: '' },
            { name: 'memo', dataType: 'varchar', extra: '' }
        ], 1000);
        assert.strictEqual(stmt, 'INSERT IGNORE INTO `db`.`sends` (`action_index`, `memo`) ' +
            'SELECT seq, CAST(seq AS CHAR) FROM seq_1_to_1000');
    });
});

describe('plan guard probes', function () {
    const db = { getSends() {}, getStatus() {}, getHolders() {}, getMarkets() {} };
    const urls = {
        '/{COIN}/api/sends/{QUERY}/{TYPE}': ['getSends', ['token', 'address']],
        '/{COIN}/api/status':               ['getStatus'],
        '/{COIN}/api/holders/{QUERY}':      ['getHolders', 'token'],
        '/{COIN}/api/markets/{TICK1}':      ['getMarkets'],
        '/{COIN}/api/gone/{QUERY}/{TYPE}':  ['getGone', ['block']]
    };

    it('probes every declared filter plus all, and bare routes as all', function () {
        assert.deepStrictEqual(capture.listProbes(urls, db).map((p) => p.method + ' ' + p.filter), [
            'getSends address', 'getSends all', 'getSends token', 'getStatus all'
        ]);
    });

    it('tags the row and count statements of a getQuery triple', function () {
        const triples = [['SELECT a FROM sends m LIMIT 10', [], 'SELECT count(*) as total FROM sends m']];
        assert.strictEqual(capture.statementKind('SELECT count(*) as total FROM sends m', triples), 'count');
        assert.strictEqual(capture.statementKind('SELECT a FROM sends m LIMIT 10 OFFSET ?', triples), 'row');
        assert.strictEqual(capture.statementKind('SELECT 1', triples), null);
    });
});
