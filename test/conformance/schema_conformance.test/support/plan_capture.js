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
 * Captures the row and count statements a list reader issues and EXPLAINs
 * each one through the pool that ran it.
 *
 * The probes come from the live route table: one per declared filter type of
 * every list route, plus `all` for every list method, because the /explorer
 * feeds serve every list bare and that unfiltered page is the hot path. The
 * reader runs for real through db.getData; doQuery is wrapped only to record
 * what it was asked, and getQuery only to learn which statement is the row
 * query and which the count.
 *
 ********************************************************************/

'use strict';

const { makeConfig } = require('../../../fixtures/mock-query-args.js');
const { RESULT_CACHES } = require('../../../../src/db/query_sql/data_cache.js');

// The seed fills every column of row 7 with 7 (see plan_seed.js), so one value
// names an existing address, ticker, block, contract and key at once. An
// existing subject keeps the optimizer from settling the WHERE from const
// tables, which would leave EXPLAIN with no plan to judge.
const PROBE_SEARCH = '7';
const PROBE_LIMIT  = 10;

/** [{method, filter}] for every routed list reader and each filter it declares. */
function listProbes(apiUrls, db) {
    const filters = new Map();
    for (const url in apiUrls) {
        const [method, types] = Array.isArray(apiUrls[url]) ? apiUrls[url] : [apiUrls[url]];
        if (typeof method !== 'string' || typeof db[method] !== 'function') continue;
        const bare = !/\{(?!COIN\})/.test(url);
        if (!Array.isArray(types) && !bare) continue;
        if (!filters.has(method)) filters.set(method, new Set());
        filters.get(method).add('all');
        for (const t of (Array.isArray(types) ? types : [])) filters.get(method).add(t);
    }
    const probes = [];
    for (const [method, set] of [...filters].sort((a, b) => a[0].localeCompare(b[0])))
        for (const filter of [...set].sort()) probes.push({ method, filter });
    return probes;
}

function probeConfig(probe) {
    const typed = probe.filter !== 'all';
    return makeConfig({ coin: 'RBTC', type: 'api', data: {
        method: probe.method,
        search: typed ? PROBE_SEARCH : null,
        type:   typed ? probe.filter : null,
        query:  { limit: PROBE_LIMIT }
    } });
}

function isSelect(sql) {
    return typeof sql === 'string' && /^\s*\(?\s*(SELECT|WITH)\b/i.test(sql) &&
        !/information_schema/i.test(sql);
}

function statementKind(sql, triples) {
    for (const [rowSql, , countSql] of triples) {
        if (countSql && sql === countSql) return 'count';
        if (rowSql && sql.startsWith(rowSql)) return 'row';
    }
    return null;
}

// Installs `wrapper(original)` as db[name] and returns the function that puts
// the original binding back, own property or prototype lookup alike.
function hook(db, name, wrapper) {
    const own = Object.prototype.hasOwnProperty.call(db, name);
    const original = db[name];
    db[name] = wrapper(original);
    return () => { if (own) db[name] = original; else delete db[name]; };
}

// Runs one probe through getData with both hooks installed, and returns the
// captured row and count statements. A reader that throws after issuing its
// SQL still yields what it issued; the error is reported beside it.
async function captureProbe(db, probe) {
    const doQuery = db.doQuery;
    const issued  = [];
    const triples = [];
    const restoreDo = hook(db, 'doQuery', (original) => async function (config, sql, args, poolOverride) {
        if (isSelect(sql)) issued.push({ config, sql, args: Array.isArray(args) ? args.slice() : args, poolOverride });
        return original.call(this, config, sql, args, poolOverride);
    });
    const restoreGet = hook(db, 'getQuery', (original) => async function (config) {
        const triple = await original.call(this, config);
        if (typeof triple[0] === 'string') triples.push(triple);
        return triple;
    });
    let error = null;
    try { await db.getData(probeConfig(probe)); }
    catch (e) { error = e.message.split('\n')[0]; }
    finally { restoreDo(); restoreGet(); }
    const statements = issued
        .map((s) => Object.assign(s, { kind: statementKind(s.sql, triples) }))
        .filter((s) => s.kind !== null);
    return { statements, error, explain: (s) => doQuery.call(db, s.config, 'EXPLAIN ' + s.sql, s.args, s.poolOverride) };
}

/** Empties the per-request result caches so every probe reaches the database. */
function clearResultCaches(db) {
    for (const method in RESULT_CACHES) db[RESULT_CACHES[method][0]] = new Map();
}

module.exports = { PROBE_SEARCH, PROBE_LIMIT, listProbes, probeConfig, statementKind, captureProbe, clearResultCaches };
