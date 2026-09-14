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
 * delegation), BET (feed / place / cancel / resolve) and the system BET_EXPIRE
 * that refunds an unresolved feed.
 ********************************************************************/

'use strict';

// One logger for the whole service, cached at require time per the
// observability contract: getLogger() returns a lazy singleton that resolves to
// the real shipper once the entry point installs it.
const { getLogger } = require('../observability');
const log = getLogger();
const sql = require('../db/action_detail/governance_sql.js');

const BET = {
    // BET action. One action name over four formats, each owning its own row:
    // 0 create-feed -> bet_feeds, 2 place-bet -> bets, 1 cancel -> bet_cancels,
    // 3 resolve -> bet_resolves. The cancel/resolve tables carry the leg's PARSE
    // status and are written whatever it is, which is what makes a
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
        query = sql.BET_DETAIL;
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
                sql.BET_LEG_FEED_STATUS,
                [action_index]);
            if(srow && srow.length){
                data['feed_ref']    = srow[0].feed_action_index;
                data['feed_status'] = srow[0].feed_status;
            }
        }
        // The cancel/resolve feed refs are plumbing for the branch above; the
        // payload exposes one `feed_ref` for every shape.
        delete data['cancel_feed_ref']; delete data['resolve_feed_ref'];
        // The DECLARED outcome belongs to the resolve shape alone. Keep it there and
        // nowhere else: a null one on a create/wager/cancel reads like a resolve that
        // named no result, which is not a state a resolve can be in.
        if(data['bet_kind'] !== 'resolve')
            delete data['resolve_outcome'];
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

const BET_EXPIRE = {
    // BET_EXPIRE action. System-injected by the end-of-block expiry pass when a
    // feed passes expire_at unresolved, so it is transactionless (block joins off
    // actions.block_index, never through transactions) and owns NO table of its
    // own. The link exists anyway: the pass writes one bet_feed_statuses row keyed
    // by this minted action_index carrying the feed it expired plus the status it
    // drove it to, which is what this drives off - the COINPAY_EXPIRE shape with
    // the parent joined through bet_feeds for its market terms.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.BET_EXPIRE_DETAIL;
        // The refund tally comes back as query2; afterQuery2 below counts the
        // refunded bets and sums their stakes, and afterMain seeds the zero
        // for a feed that expired with no bet left to refund.
        query2 = sql.BET_EXPIRE_REFUNDS;
        return { query, query2, query3 };
    },
    // A feed that expired with no open bets left is the normal empty case, and
    // afterQuery2 does not run when the tally query returns nothing, so seed the
    // zero here rather than letting the renderer read undefined as "unknown".
    async afterMain(ctx, data) {
        data['refund_count']  = 0;
        data['refund_amount'] = '0';
        // Derive validity: BET_EXPIRE owns no table with a status_id and `actions`
        // has no status column, so nothing stores it. The indexer mints this action
        // only past its idempotence guard, so the row exists iff the pass committed.
        data['status'] = 'valid';
    },
    // Sum in bignumber space at the indexer's own precision (bet_expire.js negates
    // the escrow with bcsub(..., 64)); a float sum of VARCHAR stakes would round a
    // large pot in the last places. Emit a FIXED-notation string at the widest
    // decimal place any stake used, never the raw bignumber: that object is not
    // structured-cloneable, and getActionData clones every cacheable payload, so
    // returning it would throw on the way into the LRU. Its toString also flips to
    // exponent notation past 1e21, which no amount field may render.
    async afterQuery2({ db }, data, results) {
        data['refund_count'] = results.length;
        let total  = '0';
        let places = 0;
        for(let row of results){
            if(db.util.isNull(row.amount)) continue;
            let raw = String(row.amount);
            let dot = raw.indexOf('.');
            if(dot !== -1) places = Math.max(places, raw.length - dot - 1);
            total = db.util.bcadd(total, raw, 64);
        }
        data['refund_amount'] = db.util.bcformat(total, places);
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
        query = sql.VOTE_DETAIL;
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
                catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'VOTE', field: 'options', action_index, err: _.message }); data['options'] = []; }
            } else {
                data['options'] = [];
            }
            if(data['callback_params']){
                try { data['callback_params'] = JSON.parse(data['callback_params']); }
                catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'VOTE', field: 'callback_params', action_index, err: _.message }); }
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
                sql.VOTE_FINALIZED_POLL,
                [action_index]);
            if(prow && prow.length){
                data['poll_ref']       = prow[0].poll_ref;
                data['poll_status']    = prow[0].poll_status;
                data['winning_option'] = prow[0].winning_option;
                if(prow[0].options){
                    try { data['options'] = JSON.parse(prow[0].options); }
                    catch(_) { log.warn('ACTION_DETAIL_JSON_PARSE_FAILED', { action: 'VOTE', field: 'finalize options', action_index, err: _.message }); data['options'] = []; }
                }
            }
        } else {
            data['vote_kind'] = 'ballot';
            // A ballot's chosen options share this action_index; gather them in order.
            let rows = await db.doQuery(config,
                sql.VOTE_BALLOT_CHOICES,
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
    BET_EXPIRE,
    VOTE
};
