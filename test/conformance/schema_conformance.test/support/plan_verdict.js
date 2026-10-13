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
 **********************************************************************
 * Query-plan verdicts: judges one statement's EXPLAIN rows. Pure, no DB.
 *
 * A statement offends when it reads a table that is large in production
 * either whole (`scan`: access type ALL, or a full `index` scan) or through a
 * correlated subquery inside a COUNT (`dependent-count`). ALL and index fold
 * into one finding name because which of the two the optimizer picks for the
 * same missing index differs between MariaDB versions, and the allowlist must
 * not flap on that.
 *
 * One `index` scan is the ideal unfiltered list plan, not a scan: the driving
 * table of the outermost SELECT walked in ORDER BY order and cut by LIMIT, with
 * no filesort or temporary table. The same scan inside a DERIVED block (a CTE
 * or derived table) still offends, because that block is materialized before
 * any LIMIT outside it applies. A filtered request gets no such pass: on the
 * seeded data every filter value is rare, so a plan that still walks a large
 * table in order is testing the filter row by row, which in production runs
 * until LIMIT matches turn up, or to the end of the table.
 *
 * EXPLAIN names a table by its alias, so aliases are mapped back to base
 * tables from the SQL text. An alias reused for two tables in one statement
 * maps to both, and the row counts as large when either is.
 *
 ********************************************************************/

'use strict';

const SCAN_TYPES = new Set(['ALL', 'index']);
const OUTER_SELECT_TYPES = new Set(['SIMPLE', 'PRIMARY']);

// EXPLAIN collapses to one tableless row when the optimizer settles the WHERE
// from const tables at plan time. Such a plan shows nothing to judge, so the
// caller reports it instead of counting it as clean.
const UNJUDGEABLE = /Impossible WHERE|Impossible HAVING|no matching row in const table|No matching min\/max row/i;

// Words that can follow a table name where an alias would otherwise sit.
const NOT_AN_ALIAS = new Set([
    'WHERE', 'ON', 'USING', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'JOIN', 'STRAIGHT_JOIN',
    'NATURAL', 'OUTER', 'ORDER', 'GROUP', 'LIMIT', 'HAVING', 'UNION', 'FORCE', 'USE',
    'IGNORE', 'WINDOW', 'FOR', 'LOCK', 'PARTITION', 'SET', 'WITH', 'SELECT', 'INTO',
    'OFFSET', 'EXCEPT', 'INTERSECT', 'AS'
]);

const TABLE_REF = /\b(?:FROM|JOIN)\s+(?:`?\w+`?\.)?`?(\w+)`?(?:\s+(?:AS\s+)?`?(\w+)`?)?/gi;

/** Maps each alias in `sql` to the set of base table names it stands for. */
function tableAliases(sql) {
    const aliases = new Map();
    for (const m of String(sql).matchAll(TABLE_REF)) {
        const table = m[1];
        const alias = (m[2] && !NOT_AN_ALIAS.has(m[2].toUpperCase())) ? m[2] : table;
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(table);
    }
    return aliases;
}

function largeTableFor(alias, aliases, largeTables) {
    const candidates = aliases.has(alias) ? [...aliases.get(alias)] : [alias];
    return candidates.filter((t) => largeTables.has(t)).sort()[0] || null;
}

// True for the driving table of the outermost SELECT read in index order and
// stopped by LIMIT: the first row of its id group, no sort or temporary table
// anywhere in that group, and a LIMIT in the statement.
function isOrderedLimitDriver(row, rows, sql) {
    if (row.type !== 'index' || !OUTER_SELECT_TYPES.has(row.select_type)) return false;
    if (!/\bLIMIT\b/i.test(sql)) return false;
    const group = rows.filter((r) => String(r.id) === String(row.id));
    if (group[0] !== row) return false;
    return !group.some((r) => /Using filesort|Using temporary/i.test(r.Extra || ''));
}

function evidence(row) {
    return {
        select_type:   row.select_type,
        type:          row.type,
        possible_keys: row.possible_keys || null,
        key:           row.key || null,
        rows:          row.rows === undefined || row.rows === null ? null : Number(row.rows),
        extra:         row.Extra || ''
    };
}

/**
 * Judges one statement.
 *
 * @param {object} input
 * @param {string} input.sql          the statement as issued (placeholders intact)
 * @param {string} input.kind         'row' or 'count'
 * @param {object[]} input.rows       EXPLAIN rows as the mariadb driver returns them
 * @param {Set<string>} input.largeTables  base tables that are large in production
 * @param {boolean} [input.filtered]  true when the request carried a filter type
 * @returns {{unjudgeable: string|null, findings: object[]}}
 */
function judgePlan({ sql, kind, rows, largeTables, filtered = false }) {
    const blocker = rows.find((r) => UNJUDGEABLE.test(r.Extra || ''));
    if (blocker) return { unjudgeable: blocker.Extra, findings: [] };

    const aliases  = tableAliases(sql);
    const findings = new Map();
    for (const row of rows) {
        if (!row.table || String(row.table).startsWith('<')) continue;
        const table = largeTableFor(row.table, aliases, largeTables);
        if (!table) continue;
        const orderedWalk = kind === 'row' && !filtered && isOrderedLimitDriver(row, rows, sql);
        if (SCAN_TYPES.has(row.type) && !orderedWalk)
            findings.set(table + ' scan', { table, finding: 'scan', evidence: evidence(row) });
        if (kind === 'count' && /DEPENDENT/.test(row.select_type || ''))
            findings.set(table + ' dependent-count', { table, finding: 'dependent-count', evidence: evidence(row) });
    }
    return { unjudgeable: null, findings: [...findings.values()] };
}

/** The allowlist key for one finding of one probe. */
function findingKey(probe, kind, finding) {
    return [probe.method, probe.filter, kind, finding.table, finding.finding].join(' ');
}

/** A one-line reason derived from the plan evidence, for a new allowlist entry. */
function describeFinding(probe, kind, finding) {
    const e = finding.evidence;
    if (finding.finding === 'dependent-count')
        return 'the count runs a correlated subquery on ' + finding.table + ' once per counted row';
    if (/DERIVED|MATERIALIZED/.test(e.select_type))
        return 'a derived table or CTE reads all of ' + finding.table + ' before the page is cut';
    if (probe.filter === 'all')
        return 'an unfiltered ' + (kind === 'count' ? 'count' : 'sorted read') + ' covers every ' + finding.table + ' row';
    if (e.type === 'index' && !/Using filesort|Using temporary/.test(e.extra))
        return 'the ' + probe.filter + ' filter walks ' + finding.table + ' in index order because no index drives it';
    if (!e.possible_keys)
        return 'no index on ' + finding.table + ' serves this ' + probe.filter + ' predicate or join';
    return 'the optimizer reads all of ' + finding.table + ' although ' + e.possible_keys + ' exist';
}

module.exports = { tableAliases, judgePlan, findingKey, describeFinding, isOrderedLimitDriver };
