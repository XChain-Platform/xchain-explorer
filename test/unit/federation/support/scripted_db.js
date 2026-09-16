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
 *
 * A scripted database for the federation read suites.
 *
 * Both the explorer's readers and (in the parity suite) the indexer's own
 * accessors run against it. Each statement is classified by the table and
 * clause it names and answered from the scenario's rows for that kind, and every
 * call is recorded as { kind, sql, args }, so a suite can assert that the two
 * sides sent the same statements with the same arguments and got the same rows.
 *
 ********************************************************************/

'use strict';

const federationReaders = require('../../../../src/db/readers/federation_reads.js');
const healthReaders     = require('../../../../src/db/readers/health.js');

// The statement kind, by the clause that only that statement carries. The tip read
// is the one statement whose text differs between the two services (column alias).
function classify(sql) {
    const s = String(sql);
    if (/MAX\(block_index\)/i.test(s) && /block_time <= \?/.test(s)) return 'hcut';
    if (/MAX\(block_index\)/i.test(s)) return 'tip';
    if (/SELECT block_time FROM blocks WHERE block_index = \?/.test(s)) return 'tipTime';
    if (/FROM rollcall_signers/.test(s) && /GROUP BY publisher/.test(s)) return 'publishers';
    if (/FROM rollcall_signers/.test(s)) return 'signers';
    if (/c\.version = 2/.test(s)) return 'chunks';
    if (/a\.batch_crc32 = \?/.test(s)) return 'heads';
    if (/it\.hash = \?/.test(s)) return 'txidRows';
    if (/FROM anchor_actions a/.test(s) && /a\.checkpoint_seq = \?/.test(s)) return 'anchorCandidates';
    if (/FROM prices/.test(s)) return 'prices';
    if (/information_schema\.TABLES/.test(s)) return 'haltTable';
    if (/FROM sync_halt/.test(s)) return 'halt';
    return 'unknown';
}

// Rows for one statement. `throwOn` names a kind that fails like a dropped connection.
function answer(scenario, kind) {
    if (scenario.throwOn === kind) throw new Error('scripted failure on ' + kind);
    switch (kind) {
        case 'tip':      return [{ max_block: scenario.tip, max_index: scenario.tip }];
        case 'tipTime':  return scenario.tipTime === undefined ? [] : [{ block_time: scenario.tipTime }];
        case 'hcut':     return [{ hcut: scenario.hcut === undefined ? null : scenario.hcut }];
        default:         return (scenario[kind] || []).map(r => Object.assign({}, r));
    }
}

// The explorer Database surface the federation methods use, over the script. The
// reader methods are the real ones; only doQuery is scripted.
function explorerDb(scenario, calls, opts) {
    const o = opts || {};
    const db = Object.create(federationReaders);
    db.getMaxBlockIndex     = healthReaders.getMaxBlockIndex;
    db.getReplicaHaltStatus = async () => (o.halted === undefined ? null : o.halted);
    db.pools = o.pools || { TDOGE: { pool: {} }, TBTC: { pool: {} }, RDOGE: { pool: {} }, DOGE: { pool: {} } };
    db.doQuery = async (config, sql, args) => {
        const kind = classify(sql);
        calls.push({ kind, sql, args, coin: config && config.coin });
        return answer(scenario, kind);
    };
    return db;
}

// The indexer's API view over the same script: its real accessor mixins, with the
// indexer's doQuery(sql, args) signature scripted.
function indexerView(scenario, calls, mixins) {
    const view = Object.assign({}, ...mixins);
    view.doQuery = async (sql, args) => {
        const kind = classify(sql);
        calls.push({ kind, sql, args });
        return answer(scenario, kind);
    };
    return view;
}

module.exports = { classify, explorerDb, indexerView };
