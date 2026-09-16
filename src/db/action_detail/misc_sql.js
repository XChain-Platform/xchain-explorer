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
 * SQL text for the structural and non-ledger action-detail handlers in
 * src/action-detail/misc.js. Each constant is one whole statement, named for
 * the handler and the query slot it fills; action_detail_io runs it.
 ********************************************************************/

'use strict';

// Rooted at `actions`, with the preferences row LEFT joined, because that row is OPTIONAL: an
// ADDRESS format 1 (controller bind) is not a preferences edit and older chains carry no
// `addresses` row for one at all. The INNER JOIN this replaces matched nothing for a v1, so the
// whole endpoint degraded to the de-blank baseline and served a bind with no status and no
// verdict, the same failure shape as an earlier memo-join regression.
const ADDRESS_QUERY = `SELECT
                    a3.action,
                    a2.action_format,
                    a2.action_index,
                    a4.address as source,
                    a1.fee_preference,
                    a1.require_memo,
                    a1.dispenser_preference,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    actions a2
                    INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN addresses          a1 ON (a1.action_index=a2.action_index)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=COALESCE(a2.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    a2.action_index=?
                LIMIT 1`;

// What a format 1 actually did lives in address_controllers, never in the preferences row. The
// lookup is keyed by this action_index, so it answers nothing for any other format and the
// shaping hook simply never fires. A REFUSED bind has no row here by design (the log is what
// consensus enforces); its verdict is the `status` above.
const ADDRESS_QUERY2 = `SELECT
                    c1.action_class,
                    c1.contract_index,
                    c1.is_unbind,
                    c1.cooldown_blocks,
                    c1.cooldown_end_block
                FROM
                    address_controllers c1
                WHERE
                    c1.action_index=?
                LIMIT 1`;

const BATCH_QUERY = `SELECT
                    a3.action,
                    a2.action_format,
                    b1.action_index,
                    a4.address as source,
                    b2.block_index,
                    b2.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    batches b1
                    INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                    INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                    LEFT  JOIN index_addresses    a4 ON (a4.id=COALESCE(a2.source_id, t1.source_id))
                    LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    b1.action_index=?
                LIMIT 1`;

const BATCH_QUERY2 = `SELECT
                    a1.action_index
                FROM
                    actions a1
                WHERE
                    a1.action_index!=? AND 
                    a1.tx_index=?
                ORDER BY 
                    a1.action_index ASC`;

const BROADCAST_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    b1.action_index,
                    b1.message,
                    b1.value,
                    b1.fee as broadcast_fee,
                    b1.broadcast_action_index,
                    a3.address as source,
                    b2.block_index,
                    b2.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    broadcasts b1
                    INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    b1.action_index=?
                LIMIT 1`;

const CALLBACK_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    c1.action_index,
                    a3.address as source,
                    t3.tick,
                    t4.tick as callback_tick,
                    c1.callback_amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    callbacks c1
                    INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                    LEFT  JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                WHERE 
                    c1.action_index=?
                LIMIT 1`;

const FILE_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    f1.action_index,
                    f1.name,
                    f1.title,
                    t3.type as type,
                    a3.address as source,
                    gf.gate_ticker,
                    gf.gate_min_amount,
                    gf.encryption_method,
                    gf.key_hash,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    files f1
                    INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
                WHERE
                    f1.action_index=?
                LIMIT 1`;

const MESSAGE_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    m1.action_index,
                    a3.address as source,
                    a4.address as destination,
                    m1.encryption_method,
                    m1.encryption_key,
                    m1.encrypted_message,
                    m1.plaintext_message,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status,
                    m1.coin
                FROM
                    messages m1
                    INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE 
                    m1.action_index=?
                LIMIT 1`;

const SLEEP_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    s1.action_index,
                    s1.type,
                    a3.address as source,
                    t3.tick,
                    s1.resume_block,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m2.memo,
                    s2.status
                FROM
                    sleeps s1
                    INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                    LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                WHERE 
                    s1.action_index=?
                LIMIT 1`;

const LIST_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    l1.action_index,
                    l1.type,
                    l1.edit,
                    l1.list_action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    lists l1
                    INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    l1.action_index=?
                LIMIT 1`;

// List
const LIST_QUERY2 = `SELECT
                    a1.address,
                    t1.tick
                FROM
                    list_items l1
                    LEFT JOIN index_addresses a1 ON (a1.id=l1.item_id)
                    LEFT JOIN index_tickers   t1 ON (t1.id=l1.item_id)
                WHERE
                    l1.action_index=?`;

// List edits: each item this action changed on the list, with its own status
const LIST_QUERY3 = `SELECT
                    a1.address,
                    t1.tick,
                    s1.status
                FROM
                    list_edits l1
                    LEFT  JOIN index_statuses  s1 ON (s1.id=l1.status_id)
                    LEFT JOIN  index_addresses a1 ON (a1.id=l1.item_id)
                    LEFT JOIN  index_tickers   t1 ON (t1.id=l1.item_id)
                WHERE 
                    l1.action_index=?`;

const UNKNOWN_QUERY = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    'invalid' as status,
                    t1.tx_index
                FROM
                    actions                       a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                WHERE 
                    a1.action_index=?
                LIMIT 1`;

module.exports = {
    ADDRESS_QUERY,
    ADDRESS_QUERY2,
    BATCH_QUERY,
    BATCH_QUERY2,
    BROADCAST_QUERY,
    CALLBACK_QUERY,
    FILE_QUERY,
    MESSAGE_QUERY,
    SLEEP_QUERY,
    LIST_QUERY,
    LIST_QUERY2,
    LIST_QUERY3,
    UNKNOWN_QUERY
};
