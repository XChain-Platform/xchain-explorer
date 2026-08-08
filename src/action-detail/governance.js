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
 * Detail handlers for the governance and betting actions: VOTE (poll / ballot /
 * delegation) and BET (feed / place / cancel / resolve).
 ********************************************************************/

'use strict';

const BET = {
    // BET action. One action name over four formats, each owning its own row:
    // 0 create-feed -> bet_feeds, 2 place-bet -> bets, 1 cancel -> bet_cancels,
    // 3 resolve -> bet_resolves. The cancel/resolve tables carry the leg's PARSE
    // status and are written whatever it is , which is what makes a
    // chain-REJECTED cancel or resolve reportable: those legs used to write only
    // a bet_feed_statuses row and only when valid, so this query returned a NULL
    // status and the SDK could not tell a rejection from a success. Their
    // feed_action_index is kept in its OWN alias, never coalesced onto the bets
    // column, because post-processing disambiguates the shapes off that column.
    // Mirrors the VOTE multi-table + row-less-format handling above.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    -- feed definition (format 0)
                    f.label,
                    f.outcomes,
                    -- Alias the oracle cut: getActionData overwrites the reserved fee slot (#3932)
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
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
        return { query, query2, query3 };
    },
    // BET: disambiguate the four formats and shape each. A create owns a bet_feeds
    // row (label present); a place owns a bets row (feed_action_index present);
    // cancel (1) and resolve (3) own NO row of their own, so resolve their parent
    // feed through the bet_feed_statuses row they wrote, the same row-less
    // de-blanking VOTE v2 needs. bet_kind tells the client which shape it received.
    async afterMain({ db, config, action_index }, data) {
        let fmt = db.util.isNull(data['action_format']) ? null : Number(data['action_format']);
        if(!db.util.isNull(data['label']) || fmt === 0){
            data['bet_kind'] = 'feed';
            data['feed_ref'] = data['action_index'];
            // OUTCOMES is the canonical comma-joined label list; split for display.
            data['outcome_labels'] = db.util.isNull(data['outcomes']) ? [] : String(data['outcomes']).split(',');
            // DETAILS is attacker-controlled base64 JSON. Decode for convenience but
            // keep the raw, and fall back to null (never the raw string) so a caller
            // cannot mistake un-parsed hostile bytes for a parsed object. It is
            // rendered strictly as data and no URL inside it is ever fetched.
            data['details_json'] = null;
            if(!db.util.isNull(data['details'])){
                try { data['details_json'] = JSON.parse(Buffer.from(String(data['details']), 'base64').toString('utf8')); }
                catch(_){ data['details_json'] = null; }
            }
        } else if(!db.util.isNull(data['feed_action_index'])){
            data['bet_kind'] = 'bet';
            data['feed_ref'] = data['feed_action_index'];
        } else {
            // Format 1 (cancel) / 3 (resolve). The leg's own row (bet_cancels /
            // bet_resolves) names the feed it targeted and is present whatever the
            // parse status, so it is the fallback that makes a REJECTED leg point
            // at its feed. The bet_feed_statuses row is preferred when it exists
            // because it additionally carries the status the leg drove the feed to,
            // but it is written only on the valid path.
            data['bet_kind'] = (fmt === 1) ? 'cancel' : (fmt === 3 ? 'resolve' : 'unknown');
            let legRef = db.util.isNull(data['cancel_feed_ref']) ? data['resolve_feed_ref'] : data['cancel_feed_ref'];
            if(!db.util.isNull(legRef))
                data['feed_ref'] = legRef;
            let srow = await db.doQuery(config,
                `SELECT fst.feed_action_index, s.status AS feed_status
                   FROM bet_feed_statuses fst
                   LEFT JOIN index_statuses s ON (s.id=fst.status_id)
                  WHERE fst.action_index=? LIMIT 1`,
                [action_index]);
            if(srow && srow.length){
                data['feed_ref']    = srow[0].feed_action_index;
                data['feed_status'] = srow[0].feed_status;
            }
        }
        // The cancel/resolve feed refs are plumbing for the branch above; the
        // payload exposes one `feed_ref` for every shape.
        delete data['cancel_feed_ref']; delete data['resolve_feed_ref'];
        // Strip the columns belonging to the OTHER shape so the payload never
        // carries a half-populated sibling (a null `amount` on a create reads
        // like a zero-stake bet).
        if(data['bet_kind'] !== 'bet'){
            delete data['outcome']; delete data['amount'];
            delete data['settled_block']; delete data['bet_status'];
        }
        if(data['bet_kind'] !== 'feed'){
            delete data['label']; delete data['outcomes']; delete data['bet_fee'];
            delete data['deadline']; delete data['refund_window']; delete data['expire_at'];
            delete data['min_amount']; delete data['allow_list']; delete data['block_list'];
            delete data['details']; delete data['closed_block']; delete data['terminal_block'];
        }
    },
};

const VOTE = {
    // VOTE action. One action_index lands in exactly one of three tables: v0 -> polls
    // (poll definition), v1 -> votes (ballot; one row per chosen option), v3 ->
    // vote_delegations (standing per-token delegation). LEFT JOIN the two single-row
    // tables here (polls, vote_delegations); the multi-row ballot is fetched below.
    // vote_kind (set in post-processing) tells the client which shape it received.
    // Mirrors the STAKE multi-table shape (single query, COALESCE'd status).
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
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
        return { query, query2, query3 };
    },
    // VOTE: disambiguate the three sub-types and shape each. A v0 poll has a
    // poll_status; a v3 delegation has a delegator; anything else is a v1 ballot,
    // whose choices share this action_index across multiple votes rows (fetched here).
    async afterMain({ db, config, action_index }, data) {
        if(!db.util.isNull(data['poll_status'])){
            data['vote_kind'] = 'poll';
            // options is a JSON array of labels; callback_params a JSON array of dev params.
            if(data['options']){
                try { data['options'] = JSON.parse(data['options']); }
                catch(_) { console.warn('getActionData: VOTE options parse failed for action_index=' + action_index + ':', _); data['options'] = []; }
            } else {
                data['options'] = [];
            }
            if(data['callback_params']){
                try { data['callback_params'] = JSON.parse(data['callback_params']); }
                catch(_) { console.warn('getActionData: VOTE callback_params parse failed for action_index=' + action_index + ':', _); }
            }
        } else if(!db.util.isNull(data['delegator'])){
            data['vote_kind'] = 'delegation';
        } else if(!db.util.isNull(data['action_format']) && Number(data['action_format'])==2){
            // VOTE v2 (poll finalization) is system-synthesized and writes NO
            // row of its own in polls/votes/vote_delegations keyed by its own
            // action_index (it flips the v0 poll's summary and writes poll_results).
            // The three row-shape probes above all miss it, so without this it fell
            // into the ballot else-branch and the action page badged it a blank
            // 'ballot'. Resolve the finalized poll by this action's index and tag it
            // 'finalize' (mirrors the row-less ATTEST v2 / XCALL v1 de-blanking).
            data['vote_kind'] = 'finalize';
            let prow = await db.doQuery(config,
                `SELECT action_index AS poll_ref, poll_status, winning_option, options
                   FROM polls WHERE finalized_action_index=? LIMIT 1`,
                [action_index]);
            if(prow && prow.length){
                data['poll_ref']       = prow[0].poll_ref;
                data['poll_status']    = prow[0].poll_status;
                data['winning_option'] = prow[0].winning_option;
                if(prow[0].options){
                    try { data['options'] = JSON.parse(prow[0].options); }
                    catch(_) { console.warn('getActionData: VOTE finalize options parse failed for action_index=' + action_index + ':', _); data['options'] = []; }
                }
            }
        } else {
            data['vote_kind'] = 'ballot';
            // A ballot's chosen options share this action_index; gather them in order.
            let rows = await db.doQuery(config,
                `SELECT poll_index, choice, share, memo FROM votes WHERE action_index=? ORDER BY choice ASC`,
                [action_index]);
            if(rows && rows.length){
                data['poll_ref'] = rows[0].poll_index;
                data['memo']     = rows[0].memo;
                data['ballot']   = rows.map(r => ({ choice: r.choice, share: r.share }));
            } else {
                data['ballot'] = [];
            }
        }
    },
};

module.exports = {
    BET,
    VOTE
};
