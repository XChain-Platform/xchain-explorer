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
 * XChain Explorer - dispenser and order batch readers
 *
 * The batched escrow and lifecycle status for many dispensers, and the
 * batched mirror of getOrderInfo for a page of orders.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// Add every valid DISPENSER_EDIT top-up to the escrow each dispenser still holds.
async function addDispenserRefills(db, config, map, ph, idxs){
    // Refills: every valid DISPENSER_EDIT that topped GIVE_ESCROW up.
    let query = `SELECT
                    m.dispenser_action_index,
                    m.give_escrow
                FROM
                    dispenser_edits m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
    let rows = await db.doQuery(config, query, [...idxs, 'valid']);
    for(let row of (rows || [])){
        let entry = map[String(row.dispenser_action_index)];
        if(entry && !db.util.isNull(row.give_escrow))
            entry.escrow_remaining = db.util.bcadd(entry.escrow_remaining, row.give_escrow, 64);
    }
}

// Subtract every valid DISPENSE this dispenser has already paid out.
async function subtractDispenserPayouts(db, config, map, ph, idxs){
    // Payouts: every valid DISPENSE this dispenser served.
    let query = `SELECT
                    m.dispenser_action_index,
                    m.give_amount
                FROM
                    dispenses m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
    let rows = await db.doQuery(config, query, [...idxs, 'valid']);
    for(let row of (rows || [])){
        let entry = map[String(row.dispenser_action_index)];
        if(entry && !db.util.isNull(row.give_amount))
            entry.escrow_remaining = db.util.bcsub(entry.escrow_remaining, row.give_amount, 64);
    }
}

// The order rows themselves, each joined to its latest status transition, keyed
// into the map by action_index with the BIGINT columns narrowed to Numbers.
async function orderInfoBatchRows(db, config, orderMap, placeholders, action_indexes){
    let query = `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s4.action_index)
                            FROM order_statuses s4
                            WHERE s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index IN (` + placeholders + `)`;
    let results = await db.doQuery(config, query, [...action_indexes]);
    if(results && results.length > 0){
        for(let row of results){
            row.action_index = Number(row.action_index);
            row.block_index  = Number(row.block_index);
            row.block_time   = Number(row.block_time);
            row.allow_list   = Number(row.allow_list);
            row.block_list   = Number(row.block_list);
            orderMap[row.action_index] = row;
        }
    }
}

// Apply every valid ORDER_EDIT to the orders already in the map.
async function applyOrderEditsBatch(db, config, orderMap, placeholders, action_indexes){
    let editQuery = `SELECT
                            o.order_action_index,
                            o.expiration,
                            o.allow_list,
                            o.block_list
                        FROM
                            order_edits o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.order_action_index IN (` + placeholders + `) AND
                            s.status=?
                        ORDER BY o.action_index ASC`;
    let editResults = await db.doQuery(config, editQuery, [...action_indexes, 'valid']);
    if(editResults && editResults.length > 0){
        for(let row of editResults){
            let idx = Number(row.order_action_index);
            if(orderMap[idx]){
                if(!db.util.isNull(row.expiration) && db.util.isNumeric(row.expiration)) orderMap[idx].expiration = Number(row.expiration);
                if(!db.util.isNull(row.allow_list) && db.util.isNumeric(row.allow_list)) orderMap[idx].allow_list = Number(row.allow_list);
                if(!db.util.isNull(row.block_list) && db.util.isNumeric(row.block_list)) orderMap[idx].block_list = Number(row.block_list);
            }
        }
    }
}

// The opening give/get amounts each order was created with, before matches.
async function orderOpeningAmounts(db, config, placeholders, action_indexes){
    let amtQuery = `SELECT
                            o.action_index,
                            o.give_amount,
                            o.get_amount
                        FROM
                            orders o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.action_index IN (` + placeholders + `) AND
                            s.status=?`;
    let amtResults = await db.doQuery(config, amtQuery, [...action_indexes, 'valid']);
    let remainingMap = {};
    if(amtResults && amtResults.length > 0){
        for(let row of amtResults){
            let idx = Number(row.action_index);
            remainingMap[idx] = { give_remaining: row.give_amount, get_remaining: row.get_amount };
        }
    }
    return remainingMap;
}

// Subtract what every valid match has already taken off each side.
async function subtractOrderMatches(db, config, remainingMap, action_indexes){
    let matchPlaceholders = action_indexes.map(() => '?').join(',');
    let matchQuery = `SELECT
                            m.give_action_index,
                            m.get_action_index,
                            m.give_amount,
                            m.get_amount
                        FROM
                            order_matches m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            (m.give_action_index IN (` + matchPlaceholders + `) OR m.get_action_index IN (` + matchPlaceholders + `)) AND
                            s.status=?
                        ORDER BY m.action_index ASC`;
    let matchResults = await db.doQuery(config, matchQuery, [...action_indexes, ...action_indexes, 'valid']);
    if(matchResults && matchResults.length > 0){
        for(let row of matchResults){
            for(let idx of action_indexes){
                if(row.give_action_index == idx || row.get_action_index == idx){
                    if(remainingMap[idx]){
                        let give_amount = (row.get_action_index == idx) ? row.give_amount : row.get_amount;
                        let get_amount  = (row.get_action_index == idx) ? row.get_amount  : row.give_amount;
                        remainingMap[idx].give_remaining = db.util.bcsub(remainingMap[idx].give_remaining, give_amount);
                        remainingMap[idx].get_remaining  = db.util.bcsub(remainingMap[idx].get_remaining,  get_amount);
                    }
                }
            }
        }
    }
}

class OrderBatchReaders {
    /**
     * Live escrow for one or more dispensers.
     *
     * The ONLY dispenser-escrow derivation in this service. A dispenser holds no
     * escrow column: what is left is the valid create row's GIVE_ESCROW, plus the
     * top-up every valid DISPENSER_EDIT added, minus what every valid DISPENSE
     * paid out. That is consensus-sensitive arithmetic (the indexer's
     * getDispenserAmountRemaining is its mirror, down to the 64-digit precision
     * and the valid-status filters), so both explorer read lanes - the per-action
     * detail path and the getDispensers list path - call this instead of each
     * rolling its own SQL, and the two can never disagree about how full a
     * dispenser is.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) ->
     *                   { give_escrow, escrow_remaining } (both decimal strings,
     *                   give_escrow null for an ownership dispenser, which escrows
     *                   no amount at all)
     */
    async getDispenserEscrowBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        // action_index is a BIGINT that reaches callers as either a Number or a
        // String depending on the driver path, so key on String and de-dupe: a
        // list page can repeat an index and must not bind it twice.
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Opening balance: the create row's escrow. Filtered to valid rows the
        // same way the indexer filters it - an invalid DISPENSER escrows nothing.
        let query = `SELECT
                        d.action_index,
                        d.give_escrow
                    FROM
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE
                        d.action_index IN (` + ph + `) AND
                        s.status=?`;
        let rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let escrow = this.util.isNull(row.give_escrow) ? null : row.give_escrow;
            map[String(row.action_index)] = { give_escrow: escrow, escrow_remaining: escrow };
        }
        await addDispenserRefills(this, config, map, ph, idxs);
        await subtractDispenserPayouts(this, config, map, ph, idxs);
        for(let key of Object.keys(map)){
            map[key].give_escrow      = this.amountString(map[key].give_escrow);
            map[key].escrow_remaining = this.amountString(map[key].escrow_remaining);
        }
        return map;
    }

    /**
     * Latest lifecycle status for one or more dispensers.
     *
     * The dispensers table's own status column is the CREATE action's validity
     * and never moves; the lifecycle (open / cancelling / cancelled / complete /
     * expired) lives in dispenser_statuses, one row per transition, newest row
     * current. The per-action detail path already resolves it via a
     * MAX(action_index) subquery; this is the batched mirror for the
     * getDispensers list lane, so a listing can tell an open dispenser from a
     * cancelled one without a detail fetch per row.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) -> status string;
     *                   a dispenser with no status row (an invalid create
     *                   writes none) is simply absent from the map
     */
    async getDispenserCurrentStatusBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Ordered oldest->newest so the plain overwrite below leaves the newest
        // transition per dispenser in the map - the same "latest row wins" rule
        // as the detail path's MAX(action_index) subquery, without a correlated
        // subquery per listed row.
        let query = `SELECT
                        m.dispenser_action_index,
                        m.action_index,
                        s.status
                    FROM
                        dispenser_statuses m
                        INNER JOIN index_statuses s ON (s.id=m.status_id)
                    WHERE
                        m.dispenser_action_index IN (` + ph + `)
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, idxs);
        for(let row of (rows || []))
            map[String(row.dispenser_action_index)] = row.status;
        return map;
    }

    /******************************************************************
     * Batch query methods (eliminate N+1 patterns)
     *****************************************************************/

    async getOrderInfoBatch(config, action_indexes){
        if(!action_indexes || action_indexes.length === 0) return {};
        let orderMap = {};
        let placeholders = action_indexes.map(() => '?').join(',');

        await orderInfoBatchRows(this, config, orderMap, placeholders, action_indexes);

        await applyOrderEditsBatch(this, config, orderMap, placeholders, action_indexes);

        let remainingMap = await orderOpeningAmounts(this, config, placeholders, action_indexes);

        await subtractOrderMatches(this, config, remainingMap, action_indexes);

        for(let idx of action_indexes){
            let order = orderMap[idx];
            if(order){
                order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
                order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
                if(remainingMap[idx]){
                    order.give_remaining = remainingMap[idx].give_remaining;
                    order.get_remaining  = remainingMap[idx].get_remaining;
                }
                orderMap[idx] = this.util.ksort(order);
            }
        }
        return orderMap;
    }
}

module.exports = OrderBatchReaders.prototype;
