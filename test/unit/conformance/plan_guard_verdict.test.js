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
 * The query-plan guard's judgement, proven over EXPLAIN rows recorded from
 * MariaDB in the shape the mariadb driver returns them, so the rules hold
 * without a database.
 */

'use strict';

const assert = require('assert');

const verdict = require('../../conformance/schema_conformance.test/support/plan_verdict.js');
const plans   = require('./plan_guard_explains.json');

const LARGE = new Set(['sends', 'actions', 'transactions', 'index_addresses', 'order_matches', 'blocks']);

function judge(name, filtered = false) {
    const p = plans[name];
    return verdict.judgePlan({ sql: p.sql, kind: p.kind, rows: p.rows, largeTables: LARGE, filtered });
}

function findingNames(result) {
    return result.findings.map((f) => f.table + ' ' + f.finding).sort();
}

describe('plan guard verdict: alias mapping', function () {
    it('maps aliases, bare tables and schema-qualified tables to base names', function () {
        const a = verdict.tableAliases('SELECT 1 FROM sends m INNER JOIN actions AS a1 ON (a1.x=m.x) ' +
            'LEFT JOIN `hub`.`price_snapshots` ps ON (1) JOIN blocks WHERE m.y=1');
        assert.deepStrictEqual([...a.get('m')], ['sends']);
        assert.deepStrictEqual([...a.get('a1')], ['actions']);
        assert.deepStrictEqual([...a.get('ps')], ['price_snapshots']);
        assert.deepStrictEqual([...a.get('blocks')], ['blocks']);
    });

    it('keeps every table an alias stands for when a statement reuses it', function () {
        const a = verdict.tableAliases('SELECT 1 FROM (SELECT 1 FROM sends m) m2 JOIN index_memos m ON (1)');
        assert.deepStrictEqual([...a.get('m')].sort(), ['index_memos', 'sends']);
    });
});

describe('plan guard verdict: scans', function () {
    it('passes an ordered PRIMARY walk cut by LIMIT on the outer driving table', function () {
        assert.deepStrictEqual(findingNames(judge('orderedLimitDriver')), []);
    });

    it('flags a filtered request that walks the driving table in order', function () {
        assert.deepStrictEqual(findingNames(judge('unindexedFilterPk', true)), ['sends scan']);
        assert.deepStrictEqual(findingNames(judge('unindexedFilter', true)), ['actions scan']);
    });

    it('passes the same ordered walk when the request is unfiltered', function () {
        assert.deepStrictEqual(findingNames(judge('unindexedFilterPk', false)), []);
    });

    it('flags an index scan that feeds a filesort', function () {
        assert.deepStrictEqual(findingNames(judge('indexScanFilesort')), ['sends scan']);
    });

    it('flags a scan inside a derived block even when the outer query has a LIMIT', function () {
        assert.deepStrictEqual(findingNames(judge('derivedScan')), ['sends scan']);
    });

    it('flags an unfiltered count as a scan of its driving table', function () {
        assert.deepStrictEqual(findingNames(judge('unfilteredCount')), ['sends scan']);
    });

    it('ignores scans of tables that are small in production', function () {
        assert.deepStrictEqual(findingNames(judge('smallTableScan')), []);
    });
});

describe('plan guard verdict: counts and unjudgeable plans', function () {
    it('flags a dependent subquery on a large table inside a count', function () {
        assert.deepStrictEqual(findingNames(judge('dependentCount')), ['order_matches dependent-count']);
    });

    it('lets the same dependent subquery pass in a LIMIT-bounded row query', function () {
        const p = plans.dependentCount;
        const r = verdict.judgePlan({ sql: p.sql, kind: 'row', rows: p.rows, largeTables: LARGE });
        assert.deepStrictEqual(findingNames(r), []);
    });

    it('reports a plan settled from const tables instead of passing it', function () {
        const r = judge('impossibleWhere');
        assert.match(r.unjudgeable, /Impossible WHERE/);
        assert.deepStrictEqual(r.findings, []);
    });
});

describe('plan guard verdict: keys and reasons', function () {
    it('keys a finding by method, filter, kind, table and finding', function () {
        const key = verdict.findingKey({ method: 'getSends', filter: 'token' }, 'count',
            { table: 'sends', finding: 'scan' });
        assert.strictEqual(key, 'getSends token count sends scan');
    });

    it('derives a reason from the plan evidence', function () {
        const f = judge('unindexedFilterPk', true).findings[0];
        assert.match(verdict.describeFinding({ method: 'getSends', filter: 'token' }, 'row', f),
            /token filter walks sends in index order/);
        const d = judge('derivedScan').findings[0];
        assert.match(verdict.describeFinding({ method: 'getSends', filter: 'all' }, 'row', d), /derived table or CTE/);
        const c = judge('unfilteredCount').findings[0];
        assert.match(verdict.describeFinding({ method: 'getSends', filter: 'all' }, 'count', c),
            /unfiltered count covers every sends row/);
        const g = judge('indexScanFilesort', true).findings[0];
        assert.match(verdict.describeFinding({ method: 'getSends', filter: 'token' }, 'row', g),
            /no index on sends serves this token predicate/);
    });
});
