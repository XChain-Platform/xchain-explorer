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
 * XChain Explorer - token action list readers
 *
 * Provides one prototype part composed by src/db/readers/action_lists.js.
 *
 ********************************************************************/

'use strict';

const GET_ISSUES_COUNT_SQL = `SELECT
                        count(*) as total
                    FROM
                        issues m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a5 ON (a5.id=a1.action_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    WHERE `;

const GET_ISSUES_QUERY_SQL = `SELECT
                        a5.action,
                        m.action_index,
                        a1.action_format, 
                        t3.tick,
                        m.max_supply,
                        m.max_mint,
                        m.decimals,
                        m.description,
                        m.mint_supply,
                        a3.address as transfer,
                        a4.address as transfer_supply,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.lock_mint_supply,
                        m.lock_max_mint,
                        m.lock_description,
                        m.lock_sleep,
                        m.lock_callback,
                        m.callback_block,
                        t4.tick as callback_tick,
                        m.callback_amount,
                        m.allow_list,
                        m.block_list,
                        m.mint_address_max,
                        m.mint_start_block,
                        m.mint_stop_block,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        issues m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a5 ON (a5.id=a1.action_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    WHERE `;

const GET_TOKENS_COUNT_SQL = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE `;

const GET_TOKENS_QUERY_SQL = `SELECT
                        m.id,
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.max_mint,
                        m.decimals,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.lock_mint_supply,
                        m.lock_max_mint,
                        m.lock_description,
                        m.lock_sleep,
                        m.lock_callback,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE `;

class TokenReaders {    

    async getIssues(config){
        let sql   = config.data.sql;
        let count = GET_ISSUES_COUNT_SQL + sql.where.data;
        let query = GET_ISSUES_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getMints(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        mints m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        mints m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getDestroys(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        destroys m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        destroys m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDividends(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dividends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        t4.tick as dividend_tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dividends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    } 

    async getTokens(config){
        let sql    = config.data.sql;
        let search = config.data.search;
        let type   = config.data.type;
        // Default to no bind args: the list-all WHERE ('m.action_index IS NOT NULL') has
        // no placeholder, so seeding [search] (= [null] with no QUERY/TYPE) prepends a
        // phantom bind that shifts the offset args (m.id < NULL) and returns zero rows.
        // token/subtoken set a LIKE pattern below; list-all stays [].
        let args   = [];
        let order  = 'm.id ' + sql.order;
        if(['token','subtoken'].includes(type)){
            order = 't3.tick ' + sql.order;
            if(type=='token')
                args = ['%' + this.util.escapeLike(config.data.search) + '%'];
            if(type=='subtoken')
                args = [this.util.escapeLike(config.data.search) + '.%'];
        } else if(['block','address'].includes(type)){
            // type=block/address falls into the generic getQueryWhereSql filter
            // (b1.block_index=? / a2.address=?), so the search value (block height or
            // owner address) MUST be bound as the data-WHERE arg. Leaving args=[] left
            // that placeholder unbound (500 "Parameter at position 1 is not set"). Other
            // action methods reach the same arg via the executor's [config.data.search]
            // fallback; getTokens returns an explicit args array, so it must set it here.
            args = [config.data.search];
        }
        let count = GET_TOKENS_COUNT_SQL + sql.where.data;
        let query = GET_TOKENS_QUERY_SQL + sql.where.data + sql.where.offset +`
                    ORDER BY ` + order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Collectibles gallery feed (spec explorer-coverage-completion M5.1). The
    // CLASSIFICATION is the whole product decision here, and it is taken from ISSUE
    // fields rather than from a flag the protocol does not have: a collectible is a
    // token that is INDIVISIBLE (decimals=0) and whose ceiling can no longer move
    // (lock_max_supply=1). Both columns carry their own index on `tokens`, so the
    // filter is served rather than scanned, which is why the pair was chosen over
    // any heuristic on supply size or description text.
    //
    // What this deliberately does NOT do is curate. There is no allowlist, no
    // minimum supply and no "featured" set: the gallery shows every token the two
    // ISSUE fields classify, newest first, and says so on the page. A curated set
    // would be an editorial claim the explorer has no authority to make, and the
    // classification above is checkable by anyone reading the ISSUE.
    //
    // TYPE lanes reuse the generic getQueryWhereSql branches (a2.address for the
    // owner lane, b1.block_index for the issue-block lane), which is why the joins
    // and aliases below match getTokens exactly.
    async getCollectibles(config){
        let sql   = config.data.sql;
        let type  = config.data.type;
        // Same phantom-bind hazard getTokens documents: the list-all WHERE has no
        // placeholder, so only the filtered lanes seed a search arg.
        let args  = ['block','address'].includes(type) ? [config.data.search] : [];
        let from  = `
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)`;
        let count = `SELECT
                        count(*) as total
                    FROM ` + from + `
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.decimals,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.description,
                        a2.address as owner,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        m.action_index
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }
}

module.exports = TokenReaders.prototype;
