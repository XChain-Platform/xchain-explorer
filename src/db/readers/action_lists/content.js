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
 * XChain Explorer - content action list readers
 *
 * Provides one prototype part composed by src/db/readers/action_lists.js.
 *
 ********************************************************************/

'use strict';

const GET_FILES_COUNT_SQL_1 = `SELECT
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
                        WHERE `;

const GET_FILES_QUERY_SQL_1 = `SELECT
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
                        WHERE `;

const GET_FILES_COUNT_SQL_2 = `SELECT
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
                        WHERE `;

const GET_FILES_GATE_COUNT_SQL = `SELECT
                            count(*) as total
                        FROM
                            files m
                            INNER JOIN gated_files        gf ON (gf.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                            LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        WHERE `;

const GET_FILES_QUERY_SQL_2 = `SELECT
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
                        WHERE `;

class ContentReaders {

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
            count = GET_FILES_COUNT_SQL_1 + sql.where.data;
            query = GET_FILES_QUERY_SQL_1 + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        } else {
            count = ((config.data.type=='gate') ? GET_FILES_GATE_COUNT_SQL : GET_FILES_COUNT_SQL_2) + sql.where.data;
            query = GET_FILES_QUERY_SQL_2 + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        }
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
}

module.exports = ContentReaders.prototype;
