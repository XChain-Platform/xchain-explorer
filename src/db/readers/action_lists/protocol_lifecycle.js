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
 *
 * XChain Explorer - consensus and lifecycle action list readers
 *
 ********************************************************************/

'use strict';

const { DbInputError } = require('../../shared.js');

// Report whether the request's route code (BTC, TDOGE, ...) is on the given base chain
// The indexer writes ROLLCALL publications only on DOGE and epoch closes only on BTC,
// so each list refuses the other chains (400) rather than answer an empty page.
async function onChain(db, config, chain){
    let resolved = await db.resolveCoinNetwork(config);
    return Boolean(resolved) && resolved.coin === chain;
}

function betLegQuery(config, table, fields){
    let sql = config.data.sql;
    let from = `${table} m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN bet_feeds          f  ON (f.action_index=m.feed_action_index)
                    LEFT  JOIN index_tickers      pt ON (pt.id=f.tick_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
    let count = `SELECT count(*) as total FROM ${from} WHERE ${sql.where.data}`;
    let query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format,
                    a2.address as source,
                    m.feed_action_index,
                    f.label,
                    pt.tick,
                    ${fields}
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM ${from}
                WHERE ${sql.where.data}${sql.where.offset}
                ORDER BY m.action_index ${sql.order}
                LIMIT ${sql.limit}`;
    return [query, null, count];
}

class ProtocolLifecycleReaders {
    // ROLLCALL publications, DOGE only: one row per action from rollcall_signers.
    // The epoch-close verdict lives on BTC and is served by getRollcallCloses.
    async getRollcalls(config){
        // Refuse a non-DOGE coin: rollcall_signers is empty there by construction
        if(!(await onChain(this, config, 'DOGE')))
            throw new DbInputError('rollcalls is DOGE-only; BTC epoch closes are at /{COIN}/api/rollcall_closes', 'ROLLCALLS_DOGE_ONLY');
        let sql = config.data.sql;
        let from = `rollcall_signers m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(DISTINCT m.action_index) as total FROM ${from} WHERE ${sql.where.data}`;
        let query = `SELECT
                    MIN(a4.action) as action,
                    m.action_index,
                    MIN(a1.action_format) as action_format,
                    MIN(a2.address) as source,
                    m.epoch_height,
                    MIN(m.ledger_hash) as ledger_hash,
                    MIN(m.publisher) as publisher,
                    COUNT(*) as signer_count,
                    MIN(m.block_index) as block_index,
                    MIN(b1.block_time) as timestamp,
                    MIN(t2.hash) as tx_hash,
                    MIN(t1.tx_index) as tx_index
                FROM ${from}
                WHERE ${sql.where.data}${sql.where.offset}
                GROUP BY m.action_index, m.epoch_height
                ORDER BY m.action_index ${sql.order}
                LIMIT ${sql.limit}`;
        return [query, null, count];
    }

    // ROLLCALL epoch closes, BTC only: one row per epoch from rollcalls, with its
    // absence, eviction and gate-signer counts counted live from their own tables.
    // Never selects responsible_set_json, which pins K-streak membership and stays internal.
    async getRollcallCloses(config){
        // Refuse a non-BTC coin: only the BTC indexer closes ROLLCALL epochs
        if(!(await onChain(this, config, 'BTC')))
            throw new DbInputError('rollcall_closes is BTC-only; DOGE ROLLCALL publications are at /{COIN}/api/rollcalls', 'ROLLCALL_CLOSES_BTC_ONLY');
        let sql = config.data.sql;
        let from = `rollcalls m
                    LEFT  JOIN blocks             b1 ON (b1.block_index=m.close_block)`;
        let count = `SELECT count(*) as total FROM rollcalls m WHERE ${sql.where.data}`;
        let query = `SELECT
                    m.epoch_height,
                    m.snapshot_block,
                    m.close_block,
                    m.rolled,
                    (SELECT COUNT(*) FROM rollcall_absences ra WHERE ra.epoch_height=m.epoch_height) as absence_count,
                    (SELECT COUNT(*) FROM rollcall_absences ra WHERE ra.epoch_height=m.epoch_height AND ra.evicted=1) as evicted_count,
                    (SELECT COUNT(*) FROM rollcall_gates rg WHERE rg.epoch_height=m.epoch_height) as gate_signer_count,
                    b1.block_time as timestamp
                FROM ${from}
                WHERE ${sql.where.data}${sql.where.offset}
                ORDER BY m.epoch_height ${sql.order}
                LIMIT ${sql.limit}`;
        return [query, null, count];
    }

    async getXexecs(config){
        let sql = config.data.sql;
        let from = `cross_chain_call_executions m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ${from} WHERE ${sql.where.data}`;
        let query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format,
                    m.call_id,
                    m.execute_action_index,
                    m.result_status,
                    m.return_payload_b64,
                    m.gas_used,
                    m.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM ${from}
                WHERE ${sql.where.data}${sql.where.offset}
                ORDER BY m.action_index ${sql.order}
                LIMIT ${sql.limit}`;
        return [query, null, count];
    }

    async getBetExpires(config){
        let sql = config.data.sql;
        let from = `bet_feed_statuses m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN bet_feeds          f  ON (f.action_index=m.feed_action_index)
                    LEFT  JOIN index_tickers      pt ON (pt.id=f.tick_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let where = `${sql.where.data} AND a4.action='BET_EXPIRE'`;
        let count = `SELECT count(*) as total FROM ${from} WHERE ${where}`;
        let query = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format,
                    a2.address as source,
                    m.feed_action_index,
                    f.label,
                    pt.tick,
                    s1.status as feed_status,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM ${from}
                WHERE ${where}${sql.where.offset}
                ORDER BY m.action_index ${sql.order}
                LIMIT ${sql.limit}`;
        return [query, null, count];
    }

    async getBetCancels(config){
        return betLegQuery(config, 'bet_cancels', '');
    }

    async getBetEdits(config){
        return betLegQuery(config, 'bet_edits', 'm.allow_list, m.block_list,');
    }

    async getBetResolves(config){
        return betLegQuery(config, 'bet_resolves', 'm.outcome,');
    }

    async getXbridges(config){
        let sql = config.data.sql;
        let from = `actions m
                    INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=m.tx_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(m.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=m.action_id)
                    LEFT  JOIN xbridges           x  ON (x.action_index=m.action_index)
                    LEFT  JOIN index_tickers      xt ON (xt.id=x.tick_id)
                    LEFT  JOIN index_addresses    xd ON (xd.id=x.dest_address_id)
                    LEFT  JOIN index_memos        mm ON (mm.id=x.memo_id)
                    LEFT  JOIN index_statuses     xs ON (xs.id=x.status_id)
                    LEFT  JOIN bridge_settlements bs ON (bs.action_index=m.action_index)`;
        let where = `${sql.where.data} AND a4.action='XBRIDGE' AND (x.action_index IS NOT NULL OR bs.action_index IS NOT NULL)`;
        let count = `SELECT count(*) as total FROM ${from} WHERE ${where}`;
        let query = `SELECT
                    a4.action,
                    m.action_index,
                    m.action_format,
                    a2.address as source,
                    CASE WHEN x.action_index IS NOT NULL THEN 'user' ELSE 'settlement' END as leg_kind,
                    x.version,
                    COALESCE(xt.tick, bs.tick) as tick,
                    COALESCE(x.dest_chain, bs.dest_chain) as dest_chain,
                    COALESCE(xd.address, bs.dest_address) as dest_address,
                    x.amount,
                    x.decimals,
                    x.min_depth,
                    bs.transfer_id,
                    bs.kind as settlement_kind,
                    bs.src_chain,
                    bs.src_action_index,
                    mm.memo,
                    xs.status,
                    m.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM ${from}
                WHERE ${where}${sql.where.offset}
                ORDER BY m.action_index ${sql.order}
                LIMIT ${sql.limit}`;
        let args = null;
        if(config.data.type=='address') args = [config.data.search, config.data.search, config.data.search];
        if(config.data.type=='token') args = [config.data.search, config.data.search];
        return [query, args, count];
    }
}

module.exports = ProtocolLifecycleReaders.prototype;
