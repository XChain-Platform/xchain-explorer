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
 * XChain Explorer - per-action-type list readers
 *
 * The /{COIN}/api/<action> and /{COIN}/explorer/<action> feed queries, one
 * method per action type. Extracted out of db.js because these are the
 * largest single
 * family in db.js and they share nothing with each other but the query
 * pipeline, so they move as a unit and db.js stops growing every time an
 * action type is added.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

class ActionListReaders {
    /******************************************************************
     * XChain API ACTION Endpoints
     * 
     * Endpoints                                     Method Name         Types
     * -----------------------------------------------------------------
     * /{COIN}/api/addresses/{QUERY}/{TYPE}          getAddresses        block, address
     * /{COIN}/api/airdrops/{QUERY}/{TYPE}           getAirdrops         block, address, token
     * /{COIN}/api/batches/{QUERY}/{TYPE}            getBatches          block, address
     * /{COIN}/api/broadcasts/{QUERY}/{TYPE}         getBroadcasts       block, address
     * /{COIN}/api/callbacks/{QUERY}/{TYPE}          getCallbacks        block, address, token
     * /{COIN}/api/destroys/{QUERY}/{TYPE}           getDestroys         block, address, token
     * /{COIN}/api/dispensers/{QUERY}/{TYPE}         getDispensers       block, address, token, source, destination, oracle
     * /{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}  getDispenserCancels block, address
     * /{COIN}/api/dispenser_closes/{QUERY}/{TYPE}   getDispenserCloses  block, address
     * /{COIN}/api/dispenser_expires/{QUERY}/{TYPE}  getDispenserExpires block, address
     * /{COIN}/api/dispenser_edits/{QUERY}/{TYPE}    getDispenserEdits   block, address
     * /{COIN}/api/dispenses/{QUERY}/{TYPE}          getDispenses        block, address, token, source, destination, dispenser
     * /{COIN}/api/fees/{QUERY}/{TYPE}               getFees             block, address, token, source, destination
     * /{COIN}/api/files/{QUERY}/{TYPE}              getFiles            block, address, token
     * /{COIN}/api/issues/{QUERY}/{TYPE}             getIssues           block, address, token
     * /{COIN}/api/links/{QUERY}/{TYPE}              getLinks            block, address
     * /{COIN}/api/lists/{QUERY}/{TYPE}              getLists            block, address
     * /{COIN}/api/messages/{QUERY}/{TYPE}           getMessages         block, address, token, source, destination
     * /{COIN}/api/mints/{QUERY}/{TYPE}              getMints            block, address, token, source, destination
     * /{COIN}/api/orders/{QUERY}/{TYPE}             getOrders           block, address, token
     * /{COIN}/api/order_cancels/{QUERY}/{TYPE}      getOrderCancels     block, address
     * /{COIN}/api/order_edits/{QUERY}/{TYPE}        getOrderEdits       block, address
     * /{COIN}/api/order_expires/{QUERY}/{TYPE}      getOrderExpires     block, address
     * /{COIN}/api/order_matches/{QUERY}/{TYPE}      getOrderMatches     block 
     * /{COIN}/api/sends/{QUERY}/{TYPE}              getSends            block, address, token, source, destination
     * /{COIN}/api/sleeps/{QUERY}/{TYPE}             getSleeps           block, address, token
     * /{COIN}/api/swaps/{QUERY}/{TYPE}              getSwaps            block, address, token
     * /{COIN}/api/swap_cancels/{QUERY}/{TYPE}       getSwapCancels      block, address
     * /{COIN}/api/swap_edits/{QUERY}/{TYPE}         getSwapEdits        block, address
     * /{COIN}/api/swap_expires/{QUERY}/{TYPE}       getSwapExpires      block, address
     * /{COIN}/api/swap_matches/{QUERY}/{TYPE}       getSwapMatches      block 
     * /{COIN}/api/sweeps/{QUERY}/{TYPE}             getSweeps           block, address
     ******************************************************************/

     /******************************************************************
     * XChain Explorer Endpoints
     * 
     * Endpoints                                     Method Name             Types
     * -----------------------------------------------------------------
     * /{COIN}/explorer/addresses/{QUERY}/{TYPE}     getAddresses    block, address
     * /{COIN}/explorer/airdrops/{QUERY}/{TYPE}      getAirdrops     block, address, token
     * /{COIN}/explorer/balances/{QUERY}/{TYPE}      getBalances     address
     * /{COIN}/explorer/batches/{QUERY}/{TYPE}       getBatches      block, address
     * /{COIN}/explorer/blocks/{TYPE}                getBlocks       block
     * /{COIN}/explorer/broadcasts/{QUERY}/{TYPE}    getBroadcasts   block, address
     * /{COIN}/explorer/callbacks/{QUERY}/{TYPE}     getCallbacks    block, address, token
     * /{COIN}/explorer/credits/{QUERY}/{TYPE}       getCredits      block, address
     * /{COIN}/explorer/debits/{QUERY}/{TYPE}        getDebits       block, address
     * /{COIN}/explorer/destroys/{QUERY}/{TYPE}      getDestroys     block, address, token
     * /{COIN}/explorer/dispensers/{QUERY}/{TYPE}    getDispensers   block, address, token
     * /{COIN}/explorer/dispenses/{QUERY}/{TYPE}     getDispenses    block, address, token
     * /{COIN}/explorer/escrows/{QUERY}/{TYPE}       getEscrows      block, address
     * /{COIN}/explorer/fees/{QUERY}/{TYPE}          getFees         block, address, token
     * /{COIN}/explorer/files/{QUERY}/{TYPE}         getFiles        block, address, token
     * /{COIN}/explorer/holders/{TYPE}               getHolders      token
     * /{COIN}/explorer/history/{QUERY}/{TYPE}       getHistory      block, address, token, recent
     * /{COIN}/explorer/issues/{QUERY}/{TYPE}        getIssues       block, address, token
     * /{COIN}/explorer/links/{QUERY}/{TYPE}         getLinks        block, address, token
     * /{COIN}/explorer/lists/{QUERY}/{TYPE}         getLists        block, address
     * /{COIN}/explorer/messages/{QUERY}/{TYPE}      getMessages     block, address
     * /{COIN}/explorer/mints/{QUERY}/{TYPE}         getMints        block, address, token
     * /{COIN}/explorer/orders/{QUERY}/{TYPE}        getOrders       block, address, token
     * /{COIN}/explorer/sends/{QUERY}/{TYPE}         getSends        block, address, token
     * /{COIN}/explorer/sleeps/{QUERY}/{TYPE}        getSleeps       block, address, token
     * /{COIN}/explorer/swaps/{QUERY}/{TYPE}         getSwaps        block, address, token
     * /{COIN}/explorer/sweeps/{QUERY}/{TYPE}        getSweeps       block, address
     * /{COIN}/explorer/tokens/{QUERY}/{TYPE}        getTokens       block, address
     ******************************************************************/

    async getAddresses(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        addresses m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        m.fee_preference,
                        m.require_memo,
                        m.dispenser_preference,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        addresses m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getAirdrops(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        airdrops m
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
                        m.list_action_index,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        airdrops m
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

    async getBatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        batches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        batches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBroadcasts(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        broadcasts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.message,
                        m.value,
                        m.fee,
                        m.broadcast_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        broadcasts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCallbacks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        callbacks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        t4.tick as callback_tick,
                        m.callback_amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        callbacks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
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

    // TODO: update this SQL to pull all fields once dispensers are implemented in indexer
    async getDispensers(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as address,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_escrow,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        a5.address as oracle_address,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=m.oracle_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getDispenserCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserCloses(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_closes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as dispenser_address,
                        c1.coin as give_coin,
                        t2.tick as give_tick,
                        d1.give_amount,
                        c2.coin as get_coin,
                        t3.tick as get_tick,
                        d1.get_amount,
                        f1.code as fiat,
                        d1.fiat_amount,
                        a5.address as oracle_address,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status,
                        -- WHY the dispenser closed ('empty' after an auto-drain, 'cancelled'
                        -- after the DISPENSER_CLOSE_DELAY elapses on a cancel). Without it the
                        -- two closes are indistinguishable on the wire: every other column of a
                        -- drained close and a cancelled one is identical, so a reader cannot tell
                        -- a dispenser that ran dry from one its owner withdrew. Joined on the
                        -- CLOSE's own action_index, not on the dispenser's latest status, because
                        -- dispenser_close.js writes exactly one dispenser_statuses row keyed that
                        -- way (createDispenserStatus(data['ACTION_INDEX'], ...)) - so this is a
                        -- point read of the reason THIS close recorded, immune to any later row.
                        s2.status as close_reason
                    FROM
                        dispenser_closes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN dispenser_statuses ds ON (ds.action_index=m.action_index)
                        LEFT  JOIN index_statuses     s2 ON (s2.id=ds.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=d1.get_tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        m.give_escrow,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        dispenser_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenses(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // get_amount here is dispenses.get_amount (a fill), not dispensers.get_amount
        // (a price). When one payment fills several dispensers behind the same
        // address in a batch, each fill's get_amount is its share of the payment
        // rather than the whole payment restated per row (mainnet not yet armed;
        // testnet/regtest already this way) - do not "fix" this label back to the
        // whole-payment reading, see protocol/actions/dispenser.md "One Payment,
        // Several Dispensers".
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenses m
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        m.dispenser_action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as destination,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        dispenses m
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
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

    async getFees(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        fees m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id) 
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        a1.action_format, 
                        a4.action,
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        m.method,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m.gas_cost,
                        m.gas_price,
                        m.xchain_amount,
                        m.payment_mode,
                        m.native_coin_amount,
                        m.native_coin,
                        m.oracle_round,
                        m.fee_preference,
                        m.fee_version
                    FROM
                        fees m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id) 
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }  

    async getFiles(config){
        let sql   = config.data.sql;
        let count = null;
        let query = null;
        // type=='name' (M1.7) falls into the else branch below like
        // block/address/list-all: it queries the base `files` table directly, not
        // the interned mappings_files/tick join `type=='token'` uses. The actual
        // `m.name=?` predicate is added by getQueryWhereSql (the shared WHERE
        // builder every getXxx method routes through); nothing here needs to branch
        // on it. Same column set as every other mode, gated-file columns included
        // (gate_ticker/gate_min_amount/encryption_method/key_hash), so a by-name
        // lookup discloses nothing block/address/list-all don't already return.
        if(config.data.type=='token'){
            count = `SELECT
                            count(*) as total
                        FROM
                            mappings_files m
                            INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            LEFT  JOIN index_tickers      t4 on (t4.id=m.id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        WHERE ` + sql.where.data;
            query = `SELECT
                            a3.action,
                            f1.action_index,
                            a1.action_format,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a2.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status,
                            gf.gate_ticker,
                            gf.gate_min_amount,
                            gf.encryption_method,
                            gf.key_hash
                        FROM
                            mappings_files m
                            INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            LEFT  JOIN index_tickers      t4 on (t4.id=m.id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                            LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
                        WHERE ` + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        } else {
            count = `SELECT
                            count(*) as total
                        FROM
                            files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                            LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        WHERE ` + sql.where.data;
            query = `SELECT
                            a3.action,
                            m.action_index,
                            a1.action_format,
                            m.name,
                            m.title,
                            t3.type as type,
                            a2.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status,
                            gf.gate_ticker,
                            gf.gate_min_amount,
                            gf.encryption_method,
                            gf.key_hash
                        FROM
                            files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                            LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                            LEFT  JOIN gated_files        gf ON (gf.action_index=m.action_index)
                        WHERE ` + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        }
        return [query, null, count];
    }    

    async getIssues(config){
        let sql   = config.data.sql;
        let count = `SELECT
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
                    WHERE ` + sql.where.data;
        let query = `SELECT
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
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getLinks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        links m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as coin1,
                        m.coin1_action_index,
                        c2.coin as coin2,
                        m.coin2_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        links m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }    

    async getLists(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        lists m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.type,
                        m.edit,
                        m.list_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        lists m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getMessages(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        messages m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        m.encryption_method,
                        m.encryption_key,
                        m.encrypted_message,
                        m.plaintext_message,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        m.coin
                    FROM
                        messages m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
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

    async getOrders(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address and both sides of an order for a specific token
        if(['address','token'].includes(config.data.type))
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        m.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        m.payout_legs,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getOrderCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        order_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        order_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.order_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        order_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.order_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderMatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        m.give_action_index,
                        m.give_amount,
                        c2.coin as get_coin,
                        m.get_action_index,
                        m.get_amount,
                        m.settlement_type,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        order_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpays(config){
        // coin_amount/vout here are the settlement record's, not the obligation's
        // (coinpay_obligations.coin_amount is the amount OWED). When one
        // transaction pays more than one obligation, each row's coin_amount/vout
        // name the specific output that paid THAT obligation, not the
        // transaction's first output (mainnet not yet armed; testnet/regtest
        // already this way) - do not "fix" this back to a single shared output.
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpays m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        m.obligation_action_index,
                        m.coin_amount,
                        m.txid,
                        m.vout,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        s1.status
                    FROM
                        coinpays m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpayExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpay_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        m.obligation_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        coinpay_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpayObligations(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpay_obligations m
                        INNER JOIN index_addresses    a1 ON (a1.id=m.payer_address_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.payee_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        INNER JOIN coinpay_statuses   s1 ON (s1.coinpay_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s3.action_index) FROM coinpay_statuses s3 WHERE s3.coinpay_action_index=m.action_index
                        ) AND ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        c1.coin,
                        m.coin_amount,
                        m.expiration,
                        m.block_index,
                        s2.status as coinpay_status
                    FROM
                        coinpay_obligations m
                        INNER JOIN index_addresses    a1 ON (a1.id=m.payer_address_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.payee_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        INNER JOIN coinpay_statuses   s1 ON (s1.coinpay_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s3.action_index) FROM coinpay_statuses s3 WHERE s3.coinpay_action_index=m.action_index
                        ) AND ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getSends(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        sends m
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
                        sends m
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

    async getSleeps(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        sleeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.type,
                        a2.address as source,
                        t3.tick,
                        m.resume_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        sleeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    } 

    async getSwaps(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address and both sides of swap for a specific token
        if(['address','token'].includes(config.data.type))
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        swaps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        m.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        m.payout_legs,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status,
                        ss_ist.status as swap_status
                    FROM
                        swaps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN swap_statuses      ss ON (ss.swap_action_index=m.action_index
                            AND ss.action_index=(SELECT MAX(ss2.action_index) FROM swap_statuses ss2 WHERE ss2.swap_action_index=m.action_index))
                        LEFT  JOIN index_statuses     ss_ist ON (ss_ist.id=ss.status_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getSwapCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        swap_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        swap_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN swaps              s2 ON (s2.action_index=m.swap_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.swap_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        swap_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN swaps              s2 ON (s2.action_index=m.swap_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.swap_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapMatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as give_coin,
                        m.give_action_index,
                        c2.coin as get_coin,
                        m.get_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        swap_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
         return [query, null, count];
    }

    async getSweeps(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        sweeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as destination,
                        m.balances,
                        m.ownerships,
                        m.orders,
                        m.swaps,
                        m.dispensers,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        sweeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
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
        let count = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
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
                    WHERE ` + sql.where.data + sql.where.offset +`
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

module.exports = ActionListReaders.prototype;
