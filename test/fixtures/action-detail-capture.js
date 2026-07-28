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
 * Deterministic capture harness for getActionData, shared by the golden
 * generator (bin/gen-action-detail-golden.js) and the parity test
 * (test/unit/db.action-detail-registry.test.js).
 *
 * For one action type it drives getActionData with a doQuery stub that
 * answers every statement from a fixed script, and records BOTH the exact
 * SQL text of every statement issued (in order) and the shaped object the
 * method returned. That pair is the behaviour contract of a per-action
 * detail branch: which queries it runs, and what shape it hands the client.
 *
 * Two modes, because the two halves of a branch only run under different
 * result conditions:
 *   empty - every query returns no rows, so the de-blank fallback and the
 *           row-less variants are exercised
 *   rows  - every query returns one generic row, so the follow-up queries
 *           (query2 / query3) and the per-type shaping run
 *
 * A branch that throws under the synthetic row is captured as its error
 * text rather than hidden: an unchanged error is still unchanged behaviour.
 *********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('./mock-config.js');
const { makeConfig }           = require('./mock-query-args.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

// One generic row answering every statement in `rows` mode. Deliberately has no
// `action` column: getActionType reads that, so a nested getActionData (BATCH
// recurses into its children) terminates instead of recursing forever.
const GENERIC_ROW = Object.freeze({
    action_index:        42,
    tx_index:            7,
    tx_hash:             'aa'.repeat(32),
    block_index:         100,
    block_time:          1700000000,
    timestamp:           1700000000,
    action_format:       0,
    source:              'source-address',
    destination:         'destination-address',
    address:             'some-address',
    tick:                'TESTTOK',
    amount:              '10.00000000',
    give_amount:         '5.00000000',
    get_amount:          '3.00000000',
    give_quantity:       '5.00000000',
    get_quantity:        '3.00000000',
    expiration:          10,
    allow_list:          null,
    block_list:          null,
    current_status:      'open',
    status:              'valid',
    memo:                null,
    type:                1,
    call_id:             'call-id-1',
    match_id:            'match-id-1',
    code_hash:           'cc'.repeat(32),
    chunk_index:         0,
    total_chunks:        1,
    escrow_remaining:    '5.00000000',
    give_remaining:      '5.00000000',
    get_action_index:    42,
    give_action_index:   43,
    feed_action_index:   44,
    label:               'a-feed',
    delegator:           'delegator-address',
    poll_status:         null,
    signing_pubkey:      'dd'.repeat(33),
    revoked_pubkey:      null,
    deactivation_block:  null,
    version:             1,
    data:                null,
    wire_data:           null
});

// Statements whose text embeds a value that is not stable across runs would
// break the golden; none currently do (every branch is parameterized), so the
// SQL is recorded verbatim after collapsing runs of whitespace. Collapsing keeps
// the golden readable and immune to pure re-indentation of an unchanged query,
// while any real change to the selected columns / joins / predicates still trips.
function normalizeSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
}

// Deterministic JSON: BigInt-safe, key-sorted, so an object built in a different
// property order still compares equal (property order is not behaviour here).
function stableStringify(value) {
    return JSON.stringify(value, function (key, val) {
        if (typeof val === 'bigint') return String(val) + 'n';
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            return Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
        }
        return val;
    });
}

// Run getActionData for one action type and return { sql: [...], result }.
// mode: 'empty' | 'rows'
async function captureActionType(type, mode) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    const config     = makeConfig({ coin: 'BTC' });
    const sql        = [];
    let   call       = 0;

    db.doQuery = async function (cfg, statement, args) {
        sql.push(normalizeSql(statement));
        call++;
        // Call 1 is always getActionType; it decides which branch runs.
        if (call === 1) return [{ action: type }];
        return (mode === 'rows') ? [Object.assign({}, GENERIC_ROW)] : [];
    };

    let result;
    try {
        result = await db.getActionData(config, 42);
    } catch (e) {
        result = { __error: String(e && e.message ? e.message : e) };
    }
    return { sql, result: JSON.parse(stableStringify(result)) };
}

// Capture every type in both modes into one golden document. SQL text is
// interned into a shared `statements` table (the ledger-effect, fee and
// transaction queries are identical for all 54 types, so storing them inline
// would be ~10x the bytes for no extra coverage); each capture keeps an ordered
// list of indices into it.
async function captureAll(types) {
    const statements = [];
    const index      = new Map();
    const captures   = {};
    const intern = (s) => {
        if (!index.has(s)) { index.set(s, statements.length); statements.push(s); }
        return index.get(s);
    };
    for (const type of types) {
        captures[type] = {};
        for (const mode of ['empty', 'rows']) {
            const cap = await captureActionType(type, mode);
            captures[type][mode] = { sql: cap.sql.map(intern), result: cap.result };
        }
    }
    return { statements, captures };
}

// Serialize the golden one record per line: each unique statement on its own
// line, each type/mode capture on its own line. Pretty-printing the nested
// arrays instead would quadruple the file and bury a one-branch change in
// thousands of moved lines; this way a changed branch is a handful of lines.
function serializeGolden(golden) {
    const out = [];
    out.push('{');
    out.push(' "statements": [');
    out.push(golden.statements.map((s) => '  ' + JSON.stringify(s)).join(',\n'));
    out.push(' ],');
    out.push(' "captures": {');
    const entries = Object.entries(golden.captures).map(([type, modes]) => {
        const lines = Object.entries(modes).map(([mode, cap]) => '   ' + JSON.stringify(mode) + ': ' + stableStringify(cap));
        return '  ' + JSON.stringify(type) + ': {\n' + lines.join(',\n') + '\n  }';
    });
    out.push(entries.join(',\n'));
    out.push(' }');
    out.push('}');
    return out.join('\n') + '\n';
}

module.exports = { captureActionType, captureAll, serializeGolden, normalizeSql, stableStringify, GENERIC_ROW };
