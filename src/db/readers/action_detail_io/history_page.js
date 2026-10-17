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
 * XChain Explorer - one page of the action history feed
 *
 * historyPageRows picks the page of action_indexes with only the joins that
 * decide membership, then reads the feed columns for just those rows. The
 * single-statement DISTINCT form stays here as the fallback for a page whose
 * ids repeat. getHistoryData in history.js is the one caller.
 *
 * Plain functions, not a class body: they take the Database as `db` for
 * doQuery, and nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

function historyParentBatchIndexSql(){
    // Parenthood is derived because batches stores no parent column. The scalar
    // lookup preserves one feed row per action, unlike a join that can duplicate it.
    return `(
                            SELECT bpx.action_index
                            FROM actions apx
                            INNER JOIN batches bpx ON (bpx.action_index=apx.action_index)
                            WHERE apx.tx_index=a1.tx_index
                                AND apx.tx_vout=a1.tx_vout
                                AND apx.action_index!=a1.action_index
                            LIMIT 1
                        )`;
}

// SQL OFFSET for an API ?page= request; the explorer transport pages by cursor.
function historyApiOffset(config, sql){
    return (config.type == 'api' && Number(sql.apiOffset) > 0) ? Number(sql.apiOffset) : 0;
}

function offsetSql(apiOffset){
    return (apiOffset > 0) ? ` OFFSET ?` : '';
}

// The page's action_index values in cursor order, read through only the INNER
// joins that decide membership. With no DISTINCT and no per-row decoration the
// ORDER BY ... LIMIT reads one index in order and stops after one page, where the
// single-statement form below sorts every matching row in a temporary table.
// STRAIGHT_JOIN keeps the driving table first: a block filter otherwise lets the
// optimizer start from blocks and sort every action in the block. The blocks
// join stays a join here, so a duplicated blocks row repeats an id the caller
// can see.
function historyPageIdsQuery(sql, cursor, source, where, apiOffset){
    return `SELECT STRAIGHT_JOIN
                        ` + cursor + ` as action_index
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    WHERE ` + where + `
                    ORDER BY ` + cursor + ` ` + sql.order + `
                    LIMIT ` + sql.limit + offsetSql(apiOffset);
}

// The feed rows for a known page of action_indexes: the columns, joins and order
// of the single-statement form, with the parent lookup run once per page row.
function historyPageRowsQuery(sql, size){
    let ph = new Array(size).fill('?').join(',');
    return `SELECT
                        a1.action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        ` + historyParentBatchIndexSql() + ` as parent_batch_action_index
                    FROM
                        actions a1
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE a1.action_index IN (` + ph + `)
                    ORDER BY a1.action_index ` + sql.order;
}

// The single-statement feed query. DISTINCT collapses the copies a duplicated
// mapping row or blocks row would add; it runs only for a page whose ids leg
// came back with a repeated id.
function historyPageQuery(sql, cursor, source, where, apiOffset){
    return `SELECT
                        DISTINCT(` + cursor + `) as action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        ` + historyParentBatchIndexSql() + ` as parent_batch_action_index
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY ` + cursor + ` ` + sql.order + `
                    LIMIT ` + sql.limit + offsetSql(apiOffset);
}

function historyRows(results){
    let history = [];
    if(results && results.length){
        for(let row of results)
            history.push(row);
    }
    return history;
}

// One page of the feed, rows in cursor order. The ids leg picks the page and the
// rows leg decorates it. When every id is distinct the ids are exactly the first
// page of distinct rows, so both legs together return what the DISTINCT statement
// returns; a repeated id falls back to that statement for the page.
async function historyPageRows(db, config, sql, cursor, source, where, args){
    let apiOffset = historyApiOffset(config, sql);
    let pageArgs  = (apiOffset > 0) ? [...args, apiOffset] : args;
    let idRows = await db.doQuery(config, historyPageIdsQuery(sql, cursor, source, where, apiOffset), pageArgs);
    let ids    = (idRows || []).map((row) => Number(row.action_index));
    if(!ids.length)
        return [];
    if(new Set(ids.map(String)).size != ids.length)
        return historyRows(await db.doQuery(config, historyPageQuery(sql, cursor, source, where, apiOffset), pageArgs));
    return historyRows(await db.doQuery(config, historyPageRowsQuery(sql, ids.length), ids));
}

module.exports = { historyPageRows };
