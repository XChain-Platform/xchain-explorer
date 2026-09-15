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
 * XChain Explorer - the page-boundary queries behind explorer paging
 *
 * One part of src/db/query_sql.js: the reads getQueryOffsets makes to find
 * where a page starts and stops. Three steps, in the order the entry runs them:
 * the filter the boundary queries carry (the same predicate the list itself
 * filters on, resolved to interned ids), the first/last boundary query that
 * opens a jump-to-newest or jump-to-oldest page, and the stop query that decides
 * whether there is another page after this one.
 *
 * The SQL text is the load-bearing part of this file: every statement below is
 * byte-identical to the one the single-file builder emitted, indentation of the
 * template literals included, because these statements are pinned.
 *
 * Plain functions, not a class body: they take the Database as `db` (for
 * doQuery and this.util) and nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

// WHICH TABLE getHistory's PAGE BOUNDARY is computed over. This must agree with
// getHistoryData's own choice, because the number resolved here is the cursor
// that query then pages on: if the boundary is computed over a narrower set than
// the list, `action=first` resolves to the newest MAPPED action and the list
// silently starts BELOW everything above it. That is exactly what happened -
// the first page of All Activity opened at the newest ledger-moving action and
// hid every consensus action newer than it, while the row count said they were
// there. Only the address/token feeds page over mappings_actions (their filter
// is a lookup INTO it); everything else pages over `actions`.
function historyCursor(method, type){
    let historyMapped = (method=='getHistory' && ['address','token'].includes(type));
    let hCursor = (historyMapped) ? 'm.action_index' : 'a1.action_index';
    let hSource = (historyMapped)
        ? `mappings_actions m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)`
        : `actions a1`;
    return { hCursor, hSource };
}

// Does this listing page over BLOCKS rather than over actions? `blocks` is the one
// table in the allowlist above whose rows are not actions - it carries no
// action_index at all - so the generic boundary query below, which joins
// `actions a1 ON (a1.action_index=m.action_index)`, cannot run against it.
//
// Keyed on the TABLE being paged, never on `type`. `type` names the FILTER axis, not
// the thing being listed: a SENDS list filtered by block is still a list of actions.
// Keying on `type=='block'` got both wrong at once. The blocks LIST page passes no
// type at all, so it fell through to the generic query and answered 500 DB_ERROR on
// every coin and every network - `Unknown column 'm.action_index'` - which is what a
// reader saw as a frozen page. Meanwhile a sends-by-block list, which DOES pass
// type=='block', took the block-index arithmetic below against an offset that the
// boundary query had returned as an action_index.
//
// Both sites must agree, because the second interprets the number the first returns.
function pagesOverBlocks(table){
    return (table === 'blocks');
}

// The filter every boundary query below carries, resolved from the request's
// search term to the interned id the tables actually store.
async function boundaryWhere(db, config){
    let method = config.data.method;
    let type   = config.data.type;
    let where     = '';
    let whereArgs = [];
    let sql = false;
    let id  = false;
    if(['address','oracle','token','block'].includes(type)){
        if(type=='address' || type=='oracle')
            sql = `SELECT id FROM index_addresses WHERE address=? LIMIT 1`;
        if(type=='token')
            sql = `SELECT id FROM index_tickers WHERE tick=? LIMIT 1`;
        if(sql){
            let rows = await db.doQuery(config, sql, [config.data.search]);
            if(rows.length>0)
                id = Number(rows[0].id);
        }
        if(type=='address'){
            ({ where, whereArgs } = addressBoundaryWhere(method, id));
        } else if(type=='oracle'){
            // Paging boundary for the getDispensers oracle lane. The boundary
            // query joins only m/a1/b1/t1, so filter on the dispenser row's own
            // column rather than the a5 address join the row query uses.
            where = ` AND m.oracle_address_id=?`;
            whereArgs.push(id);
        } else if(type=='block' && !db.util.isNull(config.data.search)){
            where = ` AND b1.block_index=?`;
            whereArgs.push(db.util.sanitizeInt(config.data.search));
        } else if(type=='token'){
            ({ where, whereArgs } = tokenBoundaryWhere(method, id));
        }
    }
    return { where, whereArgs };
}

// The address lane: which column holds the address depends on what the method lists.
function addressBoundaryWhere(method, id){
    let where     = '';
    let whereArgs = [];
    if(['getMessages','getMints','getSends','getSweeps'].includes(method)){
        where = ` AND (COALESCE(a1.source_id, t1.source_id)=? OR m.destination_id=?)`;
        whereArgs.push(id, id);
    } else if(['getTokens'].includes(method)){
        where = ` AND m.owner_id=?`;
        whereArgs.push(id);
    } else if(method=='getCoinpayObligations'){
        where = ` AND (m.payer_address_id=? OR m.payee_address_id=?)`;
        whereArgs.push(id, id);
    } else if(['getCredits','getDebits','getEscrows'].includes(method)){
        where = ` AND m.address_id=?`;
        whereArgs.push(id);
    } else if(['getHistory'].includes(method)){
        where = ` AND m.type_id=2 AND m.id=?`;
        whereArgs.push(id);
    } else {
        // Paging boundaries must filter on the same source the row query joins on
        // (the ACTION's own source, falling back to the transaction's), or an
        // emitted action pages differently from how it lists. Every boundary query
        // below joins `actions a1`, so the alias is always in scope here.
        where = ` AND COALESCE(a1.source_id, t1.source_id)=?`;
        whereArgs.push(id);
    }
    return { where, whereArgs };
}

// The token lane: an order/swap pages over either side of the pair, a dispenser
// over the token it gives out, history and files over the mapping row.
function tokenBoundaryWhere(method, id){
    let where     = '';
    let whereArgs = [];
    if(['getOrders','getSwaps'].includes(method)){
        where = ` AND (m.get_tick_id=? OR m.give_tick_id=?)`;
        whereArgs.push(id, id);
    } else if(['getDispensers','getDispenses'].includes(method)){
        where = ` AND m.get_tick_id=?`;
        whereArgs.push(id);
    } else if(['getHistory','getFiles'].includes(method)){
        where = ` AND m.type_id=1 AND m.id=?`;
        whereArgs.push(id);
    } else {
        where = ` AND m.tick_id=?`;
        whereArgs.push(id);
    }
    return { where, whereArgs };
}

// The jump-to-newest (`first`) and jump-to-oldest (`last`) boundary: read the
// edge row of the filtered list and return the cursor the page opens at.
async function firstLastOffset(db, config, ctx, offset1, offset){
    let action = ctx.action;
    let order  = 'DESC';
    let limit  = 1;
    if(action=='first')
        order = 'DESC';
    if(action=='last'){
        order = 'ASC';
        limit = db.util.bcadd(ctx.length,1);
    }
    let sql  = firstLastSql(ctx, order, limit);
    let rows = await db.doQuery(config, sql, ctx.whereArgs.length ? ctx.whereArgs : undefined);
    if(rows.length>0){
        for(let row of rows){
            offset1 = Number(row.offset_index);
            // Increase/Decrease offset by 1 so latest results are returned
            if(action=='first')
                offset1++;
            if(action=='last')
                offset--;
        }
    }
    return offset1;
}

// The statement firstLastOffset runs, per shape of the thing being listed.
function firstLastSql(ctx, order, limit){
    let { method, type, table, where, hCursor, hSource } = ctx;
    if(ctx.pagesOverBlocks)
        return firstLastBlocksSql(where, order, limit);
    if(method=='getTokens')
        return firstLastTokensSql(where, order, limit);
    if(method=='getHistory')
        return firstLastHistorySql(hCursor, hSource, where, order, limit);
    if(method=='getFiles' && type=='token')
        return firstLastFilesSql(where, order, limit);
    return firstLastActionsSql(table, where, order, limit);
}

function firstLastBlocksSql(where, order, limit){
    return `SELECT
                            b1.block_index as offset_index
                        FROM
                            blocks b1
                        WHERE
                            b1.block_index IS NOT NULL
                            ` + where + `
                        ORDER BY b1.block_index ` + order + `
                        LIMIT ` + limit;
}

function firstLastTokensSql(where, order, limit){
    return `SELECT
                            m.id as offset_index
                        FROM
                            tokens m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.id ` + order + `
                        LIMIT ` + limit;
}

function firstLastHistorySql(hCursor, hSource, where, order, limit){
    return `SELECT
                            ` + hCursor + ` as offset_index
                        FROM
                            ` + hSource + `
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            ` + hCursor + ` IS NOT NULL
                            ` + where + `
                        ORDER BY ` + hCursor + ` ` + order + `
                        LIMIT ` + limit;
}

function firstLastFilesSql(where, order, limit){
    return `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
}

function firstLastActionsSql(table, where, order, limit){
    return `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
}

// The stop marker: read one row PAST the page and, only when a full page plus
// that row came back, report the cursor the next page would stop at.
async function stopOffset(db, config, ctx, offset1){
    let offset2 = false;
    let action  = ctx.action;
    let method  = ctx.method;
    let where   = ctx.where;
    let limit   = db.util.bcadd(ctx.length,1);
    let order   = 'DESC';
    let stopWhereArgs = [...ctx.whereArgs];
    if(action && offset1){
        // getHistory's unmapped feeds have no `m` alias to cursor on, so the
        // stop predicate names whichever column this method's own query below
        // selects (hCursor for history, m.action_index for everything else).
        let stopCursor = (method=='getHistory') ? ctx.hCursor : 'm.action_index';
        if(action=='prev'){
            where += ' AND ' + stopCursor + ' > ?';
            stopWhereArgs.push(offset1);
        } else {
            where += ' AND ' + stopCursor + ' < ?';
            stopWhereArgs.push(offset1);
        }
    }
    let sql  = stopSql(ctx, where, order, limit);
    let rows = await db.doQuery(config, sql, stopWhereArgs.length ? stopWhereArgs : undefined);
    // Only set the stop offset when we have more data to show
    if(rows.length>0 && rows.length == limit){
        for(let row of rows)
            offset2 = Number(row.offset_index);
    }
    return offset2;
}

// The statement stopOffset runs. It carries the cursor predicate appended above,
// which is why it takes `where` rather than reading ctx.where.
function stopSql(ctx, where, order, limit){
    let { method, type, table, hCursor, hSource } = ctx;
    if(method=='getHistory'){
        // Same join shape as getHistoryData and as the first/last boundary
        // above: blocks INNER-joined on the ACTION's own block_index and
        // transactions LEFT-joined. Reaching blocks through an INNER-joined
        // transactions instead would drop every chain-generated action that
        // has no transaction row, so the stop marker would describe a
        // shorter list than the one being paged.
        return `SELECT
                            ` + hCursor + ` as offset_index
                        FROM
                            ` + hSource + `
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            ` + hCursor + ` IS NOT NULL
                            ` + where + `
                        ORDER BY ` + hCursor + ` ` + order + `
                        LIMIT ` + limit;
    } else if(method=='getFiles' && type=='token'){
        return `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
    }
    return `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
}

module.exports = { historyCursor, pagesOverBlocks, boundaryWhere, addressBoundaryWhere,
    tokenBoundaryWhere, firstLastOffset, firstLastSql, stopOffset, stopSql };
