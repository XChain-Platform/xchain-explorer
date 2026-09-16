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
 * XChain Explorer - the action history feed and its page preload
 *
 * getHistoryData drives the all-activity, per-block, per-address and
 * per-token feeds. The meta, fee and transaction batch loaders and
 * buildActionPreload fetch what a page of those actions needs in one query
 * per leg instead of one per action.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

const actionDetail = require('../../../action-detail');

// Which table the feed reads, and the paging column and FROM clause that go with it.
function historyFeedShape(type){
    // WHICH TABLE THE FEED IS DRIVEN BY, and why it is not always mappings_actions.
    //
    // mappings_actions is an address/tick LOOKUP INDEX, not an action list: the
    // indexer writes it from the addresses/tickers an action touched
    // (xchain-indexer src/chain/mapper.js, fed by util.getAddressesList(), which is only
    // populated by credit/debit bookkeeping). An action that moves no ledger entry
    // - ANCHOR, PRICE, ATTEST, NODEPROOF, ROLLCALL and every future consensus
    // action - therefore has NO row there and is structurally unreachable through
    // it. Driving the unfiltered feed off that table did not merely under-report:
    // on a network whose actions are all consensus actions (a fresh testnet
    // publishing PRICE rounds and ANCHOR checkpoints) it answered an empty
    // "All Activity" list and an empty per-block action list while the actions
    // existed and their own /anchors and /prices pages listed them.
    //
    // So the mapping table is used ONLY where its lookup is what the query needs
    // (type=address / type=token, which filter on m.type_id + m.id); the
    // all-activity and per-block feeds read `actions` directly. `cursor` is the
    // paging column for whichever shape is in play, and getQueryWhereSql anchors
    // its WHERE on the matching alias.
    let mapped    = ['address','token'].includes(type);
    let cursor    = (mapped) ? 'm.action_index' : 'a1.action_index';
    let source    = (mapped)
        ? `mappings_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)`
        : `actions a1`;
    return { cursor, source };
}

// The full-history shortcut: the highest action_index standing in for a COUNT(*).
async function presetHistoryTotal(db, config, q){
    // For full-history (search='null'): pre-set total to the highest action_index to avoid a COUNT(*) scan.
    if(config.data.search=='null'){
        let query = `SELECT
                            action_index
                        FROM
                            actions
                        ORDER BY action_index DESC
                        LIMIT 1`;
        let results = await db.doQuery(config, query);
        if(results && results.length)
            q.total = Number(results[0].action_index);
    }
}

// The COUNT leg, over the same source and WHERE the row query below pages.
async function historyTotalCount(db, config, cursor, source, where, args){
    let total = 0;
    // Get total number of matching records for this type of action and add to grand total
    let count = `SELECT
                        count(DISTINCT(` + cursor + `)) as count
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
    let results = await db.doQuery(config, count, args);
    if(results && results.length)
        // bcadd returns a decimal STRING (mathjs bignumber formatting), which is
        // what put a quoted total on the history envelope; a row count is a plain
        // integer far below 2^53, so narrow it here.
        total = Number(db.util.bcadd(total, results[0].count, 0));
    return total;
}

// One page of the feed, rows in cursor order.
async function historyPageRows(db, config, sql, cursor, source, where, args){
    // parent_batch_action_index (spec explorer-coverage-completion M1.6):
    // the indexer stores no parent column (batches is (action_index, status_id);
    // every sub-command is its own root action), so parenthood is DERIVED here.
    // A parent and its children share (tx_index, tx_vout) on `actions`; the parent
    // is whichever of those rows also has an `actions.action_index` present in
    // `batches`. This MUST stay a correlated scalar subquery in the select list,
    // never a FROM-clause join: the outer query is SELECT DISTINCT over the whole
    // row, and a join that multi-matches (one BATCH parent joined against N
    // children sharing its tx_vout) would re-materialize duplicate action_index
    // rows past the DISTINCT. A subquery returns exactly one scalar per outer row
    // and does not change row cardinality, so DISTINCT still collapses correctly.
    // `apx.action_index!=a1.action_index` is what makes the parent BATCH row's own
    // value NULL (it would otherwise find itself); every non-batch row also comes
    // back NULL because no sibling row in `batches` exists at all. EXPLAIN shape:
    // apx is looked up via actions' own PK/unique index on action_index bounded by
    // the outer row's tx_index/tx_vout (actions carries a plain index on tx_index,
    // narrowing the scan to the handful of rows sharing one tx output), then
    // filtered through batches' UNIQUE KEY on action_index (an eq_ref, not a scan);
    // the whole subquery runs once per returned row, so cost scales with page size
    // (sql.limit), not table size.
    let history = [];
    let query = `SELECT
                        DISTINCT(` + cursor + `) as action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        (
                            SELECT bpx.action_index
                            FROM actions apx
                            INNER JOIN batches bpx ON (bpx.action_index=apx.action_index)
                            WHERE apx.tx_index=a1.tx_index
                                AND apx.tx_vout=a1.tx_vout
                                AND apx.action_index!=a1.action_index
                            LIMIT 1
                        ) as parent_batch_action_index
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY ` + cursor + ` ` + sql.order + `
                    LIMIT ` + sql.limit;
    let results = await db.doQuery(config, query, args);
    if(results && results.length){
        for(let row of results)
            history.push(row);
    }
    return history;
}

class ActionHistoryReaders {
    // Supports search types: 'block', 'address', 'token', 'recent'.
    async getHistoryData(config){
        let sql       = config.data.sql;
        let type      = config.data.type;
        let q         = config.data.query;
        let offset    = (config.data.offset) ? config.data.offset : false;
        let action    = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start     = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? offset.start : false;
        let limit     = sql.limit;
        let total     = 0;
        let id        = 0;
        let history   = [];
        let args      = [];
        let where     = sql.where.data;
        let { cursor, source } = historyFeedShape(type);
        if(type=='address')
            id = await this.getAddressId(config, config.data.search);
        if(type=='token')
            id = await this.getTickId(config, config.data.search);
        await presetHistoryTotal(this, config, q);
        // Seed bind args to match the WHERE built by getQueryWhereSql: address/token add
        // 'm.id=?' (the resolved id), block adds 'b1.block_index=?'. type=recent (the
        // homepage default) and null add no placeholder, so any seed here is a phantom that
        // shifts the offset 'action_index < ?' bind (binding 0 -> 'action_index < 0' -> no rows).
        args = (type=='block') ? [config.data.search]
             : (['address','token'].includes(type) ? [id] : []);
        // Skip COUNT query when total is passed on the querystring (speeds up explorer pagination).
        // Number() because a querystring value arrives as a string and `total` is the
        // shared list-envelope field, which every other list route emits as a JSON
        // integer (see the count branch of the generic list path); history was the one
        // route handing consumers a string for it.
        if(q && q.total){
            total = Number(q.total);
        } else {
            total = await historyTotalCount(this, config, cursor, source, where, args);
        }
        if(action && start){
            if(action=='prev'){
                where += ' AND ' + cursor + ' > ?';
                args.push(start);
            } else {
                where += ' AND ' + cursor + ' < ?';
                args.push(start);
            }
        }
        if(total)
            history = await historyPageRows(this, config, sql, cursor, source, where, args);
        // Get summary data for actions
        let data = await this.getActionSummaryData(config, history);
        return [data, total];
    }

    // Action type + owning transaction hash for a SET of action_indexes.
    // Mirrors getActionType's join and adds the transactions / index_transactions hop
    // getTransactionData keys on, so one query gives a page both the type it dispatches
    // the handler on and the tx_hash it prefetches transactions by.
    // Returns a Map of action_index -> { type, tx_hash }; an index with no row is absent,
    // which the caller reads the same way getActionType reads a row-less result (null).
    async getActionMetaBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph  = action_indexes.map(() => '?').join(',');
        let sql = `SELECT
                        a1.action_index,
                        a2.action,
                        t2.hash as tx_hash
                    FROM
                        actions a1
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        a1.action_index IN (${ph})`;
        let results = await this.doQuery(config, sql, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row.action_index);
            // First row wins, matching getActionType's unqualified results[0].
            if(map.has(key)) continue;
            map.set(key, {
                type:    (row.action === undefined)  ? null : row.action,
                tx_hash: (row.tx_hash === undefined) ? null : row.tx_hash
            });
        }
        return map;
    }

    // Batched getActionFeeData. Same SELECT list, same order, same joins;
    // action_index rides along last and is deleted, so a surviving row is key-for-key
    // what the single-index query returns. Returns a Map of action_index -> fee row.
    async getActionFeeDataBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph    = action_indexes.map(() => '?').join(',');
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version,
                        f1.action_index as _group_index
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE
                        f1.action_index IN (${ph})`;
        let results = await this.doQuery(config, query, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row._group_index);
            delete row._group_index;
            // First row wins, matching getActionFeeData's unqualified results[0].
            if(!map.has(key)) map.set(key, row);
        }
        return map;
    }

    // Batched getTransactionData, keyed by tx_hash rather than action_index
    // because that is what the single-hash query takes. Every REQUESTED hash gets an
    // entry (null when the row is absent), so a caller can treat map.has() as authority
    // and only fall back for a hash the page never prefetched.
    async getTransactionDataBatch(config, hashes){
        let map = new Map();
        if(!hashes || !hashes.length) return map;
        let distinct = [...new Set(hashes.map((h) => String(h)))];
        let ph       = distinct.map(() => '?').join(',');
        let query = `SELECT
                        t1.tx_index,
                        t1.block_index,
                        t2.hash,
                        t1.fee,
                        t1.data
                    FROM
                        transactions t1
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        t2.hash IN (${ph})`;
        let results = await this.doQuery(config, query, distinct);
        for(let row of (results || [])){
            let key = String(row.hash);
            if(!map.has(key)) map.set(key, row);
        }
        for(let h of distinct)
            if(!map.has(h)) map.set(h, null);
        return map;
    }

    // Build the page-level preload getActionData reads its shared legs from.
    // Six queries for the whole page in place of six per action: one meta query for type
    // and tx_hash, up to three ledger-effect queries, one fee query, one transaction
    // query. The effect prefetch is narrowed by each index's handler `effects` flags,
    // the SAME flags attachLedgerEffects gates on, so the prefetched set and the consumed
    // set are equal by construction and a page of non-ledger actions queries none of them.
    // Per-handler detail queries are deliberately untouched: they differ per action type
    // and batching them is the high-risk half of this change.
    async buildActionPreload(config, action_indexes){
        let idxs = (action_indexes || []).map((i) => Number(i));
        if(!idxs.length) return null;
        let preload = {
            indexes:  new Set(idxs),
            types:    new Map(),
            fees:     new Map(),
            txs:      new Map(),
            emitted:  new Map(),
            effects:  null
        };
        let meta          = await this.getActionMetaBatch(config, idxs);
        let effectIndexes = { credits: [], debits: [], escrows: [] };
        let typed         = [];
        let hashes        = [];
        for(let idx of idxs){
            let row = meta.get(idx) || { type: null, tx_hash: null };
            preload.types.set(idx, row.type);
            // An untyped index short-circuits in getActionData before any shared leg
            // runs, so it contributes nothing to the effect / fee / tx prefetch sets.
            if(this.util.isNull(row.type)) continue;
            typed.push(idx);
            let flags = actionDetail.getHandler(row.type).effects || {};
            for(let key of ['credits', 'debits', 'escrows'])
                if(flags[key] !== false) effectIndexes[key].push(idx);
            if(!this.util.isNull(row.tx_hash)) hashes.push(String(row.tx_hash));
        }
        preload.effects = await actionDetail.prefetchLedgerEffects(this, config, effectIndexes);
        let fees = await this.getActionFeeDataBatch(config, typed);
        // Absence in the fee query means "no fee row", which is the null the single-index
        // path returns; record it explicitly so has() is authoritative for typed indexes.
        for(let idx of typed)
            preload.fees.set(idx, fees.has(idx) ? fees.get(idx) : null);
        preload.txs = await this.getTransactionDataBatch(config, hashes);
        // Emission provenance is a shared leg like the fee and tx legs: identical in shape
        // for every action, so it runs ONCE over the page instead of once per action.
        // Asking per-action put the page's per-index query count back above the ceiling
        // action-preload-parity guards.
        preload.emitted = await this.getEmissionProvenanceBatch(config, typed);
        return preload;
    }
}

module.exports = ActionHistoryReaders.prototype;
