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
 * SQL text for the detail handlers of the governance and betting actions:
 * VOTE, BET and BET_EXPIRE. Each constant is one whole statement that
 * src/action-detail/governance.js hands to action_detail_io.js or runs
 * itself; the action-detail golden pins every one.
 ********************************************************************/

'use strict';

// Read one BET across the feed, wager, cancel and resolve tables.
const BET_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    -- feed definition (format 0)
                    f.label,
                    f.outcomes,
                    -- Alias the oracle cut: getActionData overwrites the reserved fee slot
                    f.fee as bet_fee,
                    f.deadline,
                    f.refund_window,
                    f.expire_at,
                    f.min_amount,
                    f.allow_list,
                    f.block_list,
                    f.details,
                    f.closed_block,
                    f.terminal_block,
                    ffs.status as feed_status,
                    -- placed wager (format 2)
                    bt.feed_action_index,
                    bt.outcome,
                    bt.amount,
                    bt.settled_block,
                    bbs.status as bet_status,
                    -- cancel (format 1) / resolve (format 3) legs
                    bc.feed_action_index as cancel_feed_ref,
                    br.feed_action_index as resolve_feed_ref,
                    -- Aliased: the bare outcome name is the wager's column above, which shape disambiguation reads
                    br.outcome as resolve_outcome,
                    COALESCE(ft.tick, bt2.tick) as tick,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    COALESCE(fs.status, bs.status, bcs.status, brs.status) as status
                FROM
                    actions a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN bet_feeds          f  ON (f.action_index=a1.action_index)
                    LEFT  JOIN index_tickers      ft ON (ft.id=f.tick_id)
                    LEFT  JOIN index_statuses     fs ON (fs.id=f.status_id)
                    LEFT  JOIN index_statuses     ffs ON (ffs.id=f.feed_status_id)
                    LEFT  JOIN bets               bt ON (bt.action_index=a1.action_index)
                    LEFT  JOIN index_tickers      bt2 ON (bt2.id=bt.tick_id)
                    LEFT  JOIN index_statuses     bs ON (bs.id=bt.status_id)
                    LEFT  JOIN index_statuses     bbs ON (bbs.id=bt.bet_status_id)
                    LEFT  JOIN bet_cancels        bc ON (bc.action_index=a1.action_index)
                    LEFT  JOIN index_statuses     bcs ON (bcs.id=bc.status_id)
                    LEFT  JOIN bet_resolves       br ON (br.action_index=a1.action_index)
                    LEFT  JOIN index_statuses     brs ON (brs.id=br.status_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

// Find the feed a cancel or resolve leg drove, and the status it left the feed in.
const BET_LEG_FEED_STATUS = `SELECT fst.feed_action_index, s.status AS feed_status
                   FROM bet_feed_statuses fst
                   LEFT JOIN index_statuses s ON (s.id=fst.status_id)
                  WHERE fst.action_index=? LIMIT 1`;

// Read one BET_EXPIRE with the terms of the feed it expired.
const BET_EXPIRE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    m.feed_action_index,
                    f.label,
                    f.outcomes,
                    ft.tick,
                    f.deadline,
                    f.refund_window,
                    f.expire_at,
                    f.terminal_block,
                    b1.block_index,
                    b1.block_time as timestamp,
                    s1.status as feed_status
                FROM
                    bet_feed_statuses m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN bet_feeds          f  ON (f.action_index=m.feed_action_index)
                    LEFT  JOIN index_tickers      ft ON (ft.id=f.tick_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// Refund tally. Every bet the pass refunded got a bet_statuses row keyed by
// this same action_index; join the stake back off bets so the panel can
// state how many bettors were made whole and for how much.
const BET_EXPIRE_REFUNDS = `SELECT
                    m.bet_action_index,
                    bt.amount
                FROM
                    bet_statuses m
                    LEFT  JOIN bets               bt ON (bt.action_index=m.bet_action_index)
                WHERE
                    m.action_index=?
                ORDER BY
                    m.bet_action_index ASC`;

// Read one VOTE across the poll and vote delegation tables.
const VOTE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    -- poll definition (VOTE v0)
                    pt.tick,
                    p.tick_id,
                    p.end_block,
                    p.options,
                    p.max_selections,
                    p.tally_mode,
                    p.weight_mode,
                    p.quorum,
                    p.min_voters,
                    p.min_vote_balance,
                    p.decide_threshold,
                    p.question,
                    p.poll_status,
                    p.winning_option,
                    p.total_weight,
                    p.total_voters,
                    p.quorum_met,
                    p.min_voters_met,
                    p.fail_reason,
                    p.decided_early,
                    p.effective_close_block,
                    p.finalized_action_index,
                    p.resolved_block,
                    p.deposit_amount,
                    dep.address as deposit_address,
                    p.deposit_resolved,
                    p.callback_contract_index,
                    p.callback_method,
                    p.callback_params,
                    p.callback_on,
                    p.gas_escrow,
                    -- PC-42: the finalize -> callback timelock. The indexer has always
                    -- stored it; without it here no consumer can read whether a
                    -- binding poll defers its callback, so the wallet could emit a
                    -- reaction window it was then unable to show back.
                    p.callback_delay_blocks,
                    p.callback_execute_action_index,
                    -- delegation (VOTE v3)
                    vd.tick_id as delegation_tick_id,
                    dt.tick as delegation_tick,
                    dgr.address as delegator,
                    dg.address as delegate_to,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    COALESCE(ps.status, vds.status) as status
                FROM
                    actions a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN polls              p   ON (p.action_index=a1.action_index)
                    LEFT  JOIN index_tickers      pt  ON (pt.id=p.tick_id)
                    LEFT  JOIN index_addresses    dep ON (dep.id=p.deposit_address_id)
                    LEFT  JOIN index_statuses     ps  ON (ps.id=p.status_id)
                    LEFT  JOIN vote_delegations   vd  ON (vd.action_index=a1.action_index)
                    LEFT  JOIN index_tickers      dt  ON (dt.id=vd.tick_id)
                    LEFT  JOIN index_addresses    dgr ON (dgr.id=vd.delegator_address_id)
                    LEFT  JOIN index_addresses    dg  ON (dg.id=vd.delegate_address_id)
                    LEFT  JOIN index_statuses     vds ON (vds.id=vd.status_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

// Find the poll a VOTE v2 finalization closed.
const VOTE_FINALIZED_POLL = `SELECT action_index AS poll_ref, poll_status, winning_option, options
                   FROM polls WHERE finalized_action_index=? LIMIT 1`;

// List the options one ballot chose, in choice order.
const VOTE_BALLOT_CHOICES = `SELECT poll_index, choice, share, memo FROM votes WHERE action_index=? ORDER BY choice ASC`;

// Read the common status stored on a ballot's choice rows.
const VOTE_BALLOT_STATUS = `SELECT COALESCE(s1.status, 'valid') AS status
                FROM
                    votes v
                    LEFT JOIN index_statuses s1 ON (s1.id=v.status_id)
                WHERE
                    v.action_index=?
                LIMIT 1`;

module.exports = {
    BET_DETAIL,
    BET_LEG_FEED_STATUS,
    BET_EXPIRE_DETAIL,
    BET_EXPIRE_REFUNDS,
    VOTE_DETAIL,
    VOTE_FINALIZED_POLL,
    VOTE_BALLOT_CHOICES,
    VOTE_BALLOT_STATUS
};
