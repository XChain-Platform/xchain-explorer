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
 * SQL statements for the validator-produced action-detail handlers
 * (src/action-detail/consensus.js): ANCHOR, ATTEST, NODEPROOF, PRICE, ROLLCALL.
 ********************************************************************/

'use strict';

// Read one ANCHOR row for the detail page; the column rationale sits on the ANCHOR handler.
const ANCHOR_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.section_index,
                    m.version,
                    m.chain,
                    m.network,
                    b1.block_index,
                    m.block_index as anchored_block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.match_batch_seq,
                    m.match_count,
                    m.batch_crc32,
                    m.total_chunks,
                    m.chunk_index,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    m.block_index_doge,
                    m.publisher,
                    m.publisher_attestations,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    anchor_actions m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                ORDER BY m.section_index ASC
                LIMIT 1`;

// A v0 ANCHOR is a BUNDLE: anchor_actions is keyed (action_index, section_index),
// one row per checkpointed chain, each with its own chain, block_index,
// checkpoint_seq, roots and signature list. The bundle-level fields (version,
// network, publisher, publisher_attestations, status, txid, DOGE block) are
// denormalized identically onto every row, so the ORDER BY above pins the header
// to section 0 instead of whatever the join plan returns first, and this query
// reads the sections the header cannot speak for. Same shape as db.getAnchor,
// which the /anchor page renders from. Archive rows (v1/v2) and every retired
// per-chain version stay at section_index 0, so they come back as one section.
const ANCHOR_SECTIONS = `SELECT
                    m.section_index,
                    m.chain,
                    m.block_index,
                    m.block_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.state_root,
                    m.block_merkle_root,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE
                    m.action_index=?
                ORDER BY m.section_index ASC`;

// Read one ATTEST row, every version's columns included (see the ATTEST handler).
const ATTEST_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    m.version,
                    m.request_id,
                    m.provider_id,
                    m.contract_index,
                    fp.address as fee_payer,
                    m.callback_method,
                    m.redundancy,
                    m.deadline_block,
                    m.gas_escrow,
                    m.fee_amount,
                    ft.tick as fee_tick,
                    m.request_status,
                    m.response_hash,
                    m.response_status,
                    m.response_payload,
                    m.meta,
                    m.validator_signatures,
                    m.callback_execute_action_index,
                    m.batch_window_start,
                    m.batch_window_end,
                    m.batch_row_count,
                    m.batch_btc_block_height,
                    m.batch_crc32,
                    m.batch_total_chunks,
                    m.batch_chunk_index,
                    m.payload,
                    m.callback_params_json,
                    a3.address as source,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    attests m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                    LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// Read the verdict-level NODEPROOF fields from any one full_node_verifications row.
const NODEPROOF_DETAIL = `SELECT
                    a4.action,
                    a1.action_format,
                    m.action_index,
                    m.challenge_id,
                    m.epoch_height,
                    m.target_height,
                    a2.address as source,
                    m.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    full_node_verifications m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// List every validator this NODEPROOF verdict recorded as PASS, in insertion order.
const NODEPROOF_VERIFICATIONS = `SELECT
                    m.signing_pubkey_id,
                    pk.pubkey as signing_pubkey,
                    m.source_id,
                    a3.address as staking_source,
                    m.passed,
                    m.block_index
             FROM full_node_verifications m
                LEFT JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT JOIN index_addresses a3 ON (a3.id=m.source_id)
             WHERE m.action_index=?
             ORDER BY m.id ASC`;

// Read one PRICE row with both the single-round and the batch columns.
const PRICE_DETAIL = `SELECT
                    a4.action,
                    m.action_index,
                    a1.action_format,
                    m.version,
                    a2.address as source,
                    m.round_number,
                    m.round_timestamp,
                    m.pair_count,
                    m.pairs_json,
                    m.sig_count,
                    m.sigs_json,
                    m.batch_first_round,
                    m.batch_last_round,
                    m.round_count,
                    m.rounds_json,
                    c1.coin,
                    t3.tick,
                    f1.code as fiat,
                    m.value,
                    m.fee as oracle_fee,
                    m.validation_status,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m1.memo,
                    s1.status
                FROM
                    prices m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                    LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                    LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                    LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// LEFT JOIN on transactions rather than INNER: a detail page should render
// what the row holds even when no transaction joins. A ROLLCALL eviction
// (action_format 3) has no broadcast transaction behind it, so its action row
// carries tx_index NULL and an INNER join it can never satisfy drops it. This is
// the tx-less-safe shape getUnstakes (src/db/readers/staking_governance.js) and
// getAttestations (src/db.js) use: blocks joins off a block_index that is set on
// both paths, and transactions stays optional.
const ROLLCALL_DETAIL = `SELECT
                    a4.action,
                    a1.action_format,
                    m.action_index,
                    m.epoch_height,
                    m.ledger_hash,
                    m.publisher,
                    a2.address as source,
                    m.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    m.gates
                FROM
                    rollcall_signers m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// List the signers this ROLLCALL action carried, ordered by pubkey (the table has no id column).
const ROLLCALL_SIGNERS = `SELECT
                    m.pubkey,
                    m.sig,
                    m.block_index
             FROM rollcall_signers m
             WHERE m.action_index=?
             ORDER BY m.pubkey ASC`;

module.exports = {
    ANCHOR_DETAIL,
    ANCHOR_SECTIONS,
    ATTEST_DETAIL,
    NODEPROOF_DETAIL,
    NODEPROOF_VERIFICATIONS,
    PRICE_DETAIL,
    ROLLCALL_DETAIL,
    ROLLCALL_SIGNERS
};
