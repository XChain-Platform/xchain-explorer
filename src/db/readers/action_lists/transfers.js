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
 * XChain Explorer - transfer action list readers
 *
 * Provides one prototype part composed by src/db/readers/action_lists.js.
 *
 ********************************************************************/

'use strict';

const { feeRows } = require('../../../action-detail/contracts.js');

class TransferReaders {
    // A contract-emitted SEND has no broadcast transaction behind it: the injected
    // EXECUTE that ran it carries no TX_INDEX (xchain-indexer actions/xexec.js), and
    // execute/index.js propagates that absence into every action the run emits, so the
    // `actions` row lands with tx_index NULL while block_index is NOT NULL. Joining
    // blocks THROUGH an INNER-joined transaction therefore did not degrade such a
    // row, it deleted it from the feed AND from its total, silently, and the /sends
    // route is what the SDK's x402 layer reads to confirm a payment. Blocks joins
    // off a1.block_index (INNER, always present) and transactions degrades to LEFT,
    // which is the shape the tx-less action feed and getUnstakes already use.
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
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
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
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
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
     * /{COIN}/api/files/{QUERY}/{TYPE}              getFiles            block, address, token, name, gate
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
}

async function getFees(config){
    let sql  = config.data.sql;
    let rows = feeRows();
    let joins = `
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(m.source_id, a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
    let count = `SELECT
                        count(*) as total
                    FROM
                        ` + rows + ` m` + joins + `
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
                        ` + rows + ` m` + joins + `
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
    return [query, null, count];
}

Object.defineProperty(require('./coinpay.js'), 'getFees', {
    value: getFees,
    writable: true,
    configurable: true
});

module.exports = TransferReaders.prototype;
