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
 * XChain Explorer - poll, vote, bet and oracle readers
 *
 * Proposal B stage 4: the two prediction surfaces and the oracle they both lean
 * on. VOTE polls with their tallies and votes, BET feeds with their pools,
 * timeline, winning outcome and the wagers against them, and the oracle stats,
 * price records and earned-fee rollups.
 *
 * Polls and bets share a module because they share a failure mode: both carry
 * their lifecycle in a plain status column the indexer rewrites in place rather
 * than as a new action row, so a reader here that caches its answer serves a
 * frozen verdict on a resolved round. MUTABLE_ACTION_FIELDS in ../shared.js is
 * the list that keeps those responses out of the action LRU.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

class PollBetReaders {
    // Resolve the PARENT market for any BET-family action, so a ws lifecycle event can
    // be routed to the `bet_feed:<feed_index>` entity channel. BET is one action name
    // over four formats, so the parent is wherever the action landed:
    //   format 0 (create) -> the feed row itself, whose id IS this action_index
    //   format 2 (place)  -> bets.feed_action_index
    //   formats 1/3 + BET_EXPIRE -> bet_feed_statuses.feed_action_index (the status row
    //   the cancel/resolve/expire wrote). Checked in that order; the first hit wins.
    // Returns null when nothing matches (a rejected BET writes no child row), which the
    // caller treats as non-fatal and emits without a parent index.
    async getBetActionFeedIndex(config, actionIndex) {
        let feed = await this.doQuery(config,
            `SELECT action_index FROM bet_feeds WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (feed && feed.length) return feed[0].action_index;
        let bet = await this.doQuery(config,
            `SELECT feed_action_index FROM bets WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (bet && bet.length && bet[0].feed_action_index != null) return bet[0].feed_action_index;
        let st = await this.doQuery(config,
            `SELECT feed_action_index FROM bet_feed_statuses WHERE action_index=? ORDER BY feed_action_index ASC LIMIT 1`, [actionIndex]);
        if (st && st.length && st[0].feed_action_index != null) return st[0].feed_action_index;
        return null;
    }

    // Feeds whose `closed` deadline latch was stamped above `sinceBlock`, oldest
    // first. This is the ws layer's SECOND cursor and it exists because the latch is
    // the one BET transition with no action row: the end-of-block pass writes
    // bet_feeds.closed_block directly (spec §6), so the ChangeDetector's actions
    // cursor has nothing to see and a subscribed market page never learns that
    // betting closed. closed_block IS the durable record of that write, and
    // it is also what the reorg reset clears, so a rolled-back-then-re-latched feed
    // re-emits naturally.
    // Ordered by closed_block ASC (then action_index) because the caller advances a
    // block-height high-water mark and must be able to stop on a whole-block boundary.
    async getBetFeedsClosedSince(config, sinceBlock, limit) {
        let query = `SELECT
                        m.action_index,
                        m.closed_block,
                        m.deadline,
                        m.expire_at,
                        a2.address as source,
                        pt.tick,
                        fs.status as feed_status
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers   pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE
                        m.closed_block > ?
                    ORDER BY m.closed_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlock, limit]);
        return results || [];
    }

    // List VOTE governance polls (polls table, one row per VOTE v0 create-poll action).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / tick (electorate token) / poll_status / source creator (see the
    // getQueryWhereSql getPolls branch). tick + source resolve through index tables.
    async getPolls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.deposit_amount,
                        m.callback_contract_index,
                        m.callback_method,
                        m.finalized_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Open (not yet finalized) polls governed by one token, soonest close first.
    // Backs getToken's open_polls (the token page's Active Governance card).
    // Capped small because it rides the token point-read; full poll history
    // stays on getPolls (the tick/status-filterable list).
    async getTokenOpenPolls(config, tick){
        let query = `SELECT
                        m.action_index,
                        m.question,
                        m.end_block,
                        m.quorum,
                        m.min_voters,
                        m.weight_mode,
                        m.callback_contract_index,
                        m.callback_method
                    FROM
                        polls m
                        INNER JOIN index_tickers pt ON (pt.id=m.tick_id)
                    WHERE
                        pt.tick=?
                        AND m.poll_status='open'
                    ORDER BY m.end_block ASC
                    LIMIT 25`;
        let rows = await this.doQuery(config, query, [tick]);
        return rows || [];
    }

    // Single VOTE poll by its creating action_index (the poll id). Returns the full
    // poll definition + finalization summary (null fields until VOTE v2 finalizes) as a
    // single object (getXcall pattern), with options/callback_params JSON-parsed. The
    // per-option breakdown lives in poll_results (getPollResults); ballots in votes.
    async getPoll(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.min_vote_balance,
                        m.decide_threshold,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.fail_reason,
                        m.decided_early,
                        m.effective_close_block,
                        m.finalized_action_index,
                        m.resolved_block,
                        m.deposit_amount,
                        dep.address as deposit_address,
                        m.deposit_resolved,
                        m.callback_contract_index,
                        m.callback_method,
                        m.callback_params,
                        m.callback_on,
                        m.gas_escrow,
                        m.callback_delay_blocks,
                        m.callback_execute_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    dep ON (dep.id=m.deposit_address_id)
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // options is a JSON array of option labels; callback_params a JSON array of
            // developer params. Parse both, falling back to the raw string on malformed
            // JSON (mirrors getXcall's params_json / getContract's permissions parse).
            try { row.options = this.util.isNull(row.options) ? [] : JSON.parse(row.options); }
            catch(e){ row.options = row.options; }
            try { row.callback_params = this.util.isNull(row.callback_params) ? null : JSON.parse(row.callback_params); }
            catch(e){ row.callback_params = row.callback_params; }
            data = row;
        }
        return [data];
    }

    // Frozen per-option tally for one poll (poll_results, written by VOTE v2 finalize).
    // Empty until the poll is finalized; ordered by option_index so the caller renders
    // the poll's options in order. No actions chain (keyed by poll_index directly).
    async getPollResults(config){
        let sql   = config.data.sql;
        let count = `SELECT count(*) as total FROM poll_results m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.poll_index,
                        m.option_index,
                        m.total_weight,
                        m.voter_count,
                        m.action_index as finalize_action_index,
                        m.block_index,
                        s1.status
                    FROM
                        poll_results m
                        LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY m.option_index ASC`;
        return [query, null, count];
    }

    // List VOTE ballots (votes table, one row per poll+voter+chosen option). Joins the
    // actions/transactions/blocks chain like getAttestations; the voter IS the source
    // (a2). Filter by voter address / poll / block (see getQueryWhereSql getVotes branch).
    async getVotes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.poll_index,
                        m.choice,
                        m.share,
                        m.memo,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List BET markets (bet_feeds, one row per BET format 0 create-feed action).
    // Joins the actions/transactions/blocks chain like getPolls; the feed id IS the
    // creating action_index. tick joins index_tickers (pt) on m.tick_id (the wager
    // token); source is the oracle that created the feed (a2 via the action source);
    // status filters the stored feed lifecycle enum through index_statuses (fs).
    // feed_status is STORED rather than derived, so the list never recomputes a
    // close from the wall clock (the §5 backdating property E11 pins).
    async getBetFeeds(config){
        let sql   = config.data.sql;
        let from  = `
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // HTTP entry point for one BET market (getPoll pattern: a one-element array
    // whose element is null when there is no such feed). The router's where-builder
    // resolves to `m.action_index IS NOT NULL AND m.action_index=?` for this method
    // (getQueryWhereSql), which is the equality getBetFeedInfo binds directly, so
    // both entry points read the same row through one query body.
    async getBetFeed(config){
        return [await this.getBetFeedInfo(config, config.data.search)];
    }

    // Single BET market by its creating action_index (the feed id), returned as one
    // object with the per-outcome pools, bet counts and the full status timeline
    // attached, or null. DETAILS is returned as the RAW base64 exactly as it landed
    // on the wire plus a decoded `details_json` when it parses; it is never rendered
    // as markup and no URL inside it is ever fetched (§11.1 rendering safety,
    // SSRF-guard stance). Takes the index as an argument rather than off the config
    // so callers holding no router-built config can read it too: the WebSocket
    // bet_feed SNAPSHOT builds `{ coin }` alone. Same shape as getDispenserInfo.
    async getBetFeedInfo(config, actionIndex){
        let data  = null;
        let args  = [actionIndex];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        m.details,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // OUTCOMES is stored as the canonical comma-joined label list. Split it
            // back into an array so the caller renders options in wire order without
            // re-implementing the join rule. Byte-exact uniqueness was enforced at
            // parse, so positions are stable and index-addressable.
            row.outcome_labels = this.util.isNull(row.outcomes) ? [] : String(row.outcomes).split(',');
            // DETAILS rides the wire as base64 and is ATTACKER-CONTROLLED. Decode it
            // for convenience but keep the raw alongside, and fall back to null (never
            // to the raw string) when it is not valid base64 JSON, so a consumer can
            // never mistake un-parsed hostile bytes for a parsed object.
            row.details_json = null;
            if(!this.util.isNull(row.details)){
                try { row.details_json = JSON.parse(Buffer.from(String(row.details), 'base64').toString('utf8')); }
                catch(e){ row.details_json = null; }
            }
            row.pools    = await this.getBetFeedPools(config, row.action_index);
            row.timeline = await this.getBetFeedTimeline(config, row.action_index, row.closed_block);
            // The outcome a finished market resolved to; the feed row itself has none.
            row.winning_outcome = await this.getBetFeedWinningOutcome(config, row.action_index);
            data = row;
        }
        return data;
    }

    // Return the outcome an honoured resolve settled to, else null. Only a valid
    // resolve counts: an invalid row stores the outcome the oracle CLAIMED and settles
    // nothing. Resolve is terminal, so at most one row can apply.
    async getBetFeedWinningOutcome(config, feedIndex){
        let query = `SELECT
                        br.outcome
                    FROM
                        bet_resolves br
                        LEFT JOIN index_statuses bs ON (bs.id=br.status_id)
                    WHERE
                        br.feed_action_index=?
                        AND bs.status='valid'
                    ORDER BY br.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(config, query, [feedIndex]);
        if(!rows || !rows.length || this.util.isNull(rows[0].outcome)) return null;
        return Number(rows[0].outcome);
    }

    // Sum every bet that escrowed; invalid rows escrowed nothing and are the only
    // exclusion. This is a display aggregation, NOT the settlement predicate (which
    // counts open rows alone); no consensus path reads it.
    async getBetFeedPools(config, feedIndex){
        let query = `SELECT
                        m.outcome,
                        count(*) as bet_count,
                        SUM(CAST(m.amount AS DECIMAL(65,18))) as pool
                    FROM
                        bets m
                        LEFT JOIN index_statuses bs ON (bs.id=m.bet_status_id)
                    WHERE
                        m.feed_action_index=?
                        AND bs.status <> 'invalid'
                    GROUP BY m.outcome
                    ORDER BY m.outcome ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        // Trim the 18-place tail a DECIMAL sum leaves on a token with fewer decimals.
        // Display only; no consensus path reads this.
        return rows.map(r => ({ outcome: Number(r.outcome),
                                bet_count: Number(r.bet_count),
                                pool: this.trimAmountTail(r.pool) }));
    }

    // Status timeline for one feed. bet_feed_statuses is action-scoped, so it carries
    // create / resolve / resolved_void / cancel / expire but deliberately NOT the
    // 'closed' latch, which has no causing action (see bet_feed_statuses.sql). The
    // explorer SYNTHESIZES that entry from the bet_feeds.closed_block stamp, which is
    // the latch's durable record, and marks it synthetic so a consumer can tell it
    // apart from an action-backed row.
    //
    // The block comes from `actions.block_index`, NOT from the action's transaction:
    // BET_EXPIRE is emitted by the end-of-block pass and has no transaction at all
    // (tx_index NULL), so routing the block join through `transactions` returns
    // NULL for that one status, and because the synthetic-latch insertion below compares
    // block numbers, that NULL would also mis-order the closed/expired history. The
    // transaction join stays, but only for the tx hash a system action does not have.
    async getBetFeedTimeline(config, feedIndex, closedBlock){
        let query = `SELECT
                        m.action_index,
                        s1.status,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash
                    FROM
                        bet_feed_statuses m
                        LEFT JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE m.feed_action_index=?
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        rows = rows.map(r => Object.assign({}, r, { synthetic: false }));
        if(!this.util.isNull(closedBlock)){
            let closed = { action_index: null, status: 'closed', block_index: closedBlock,
                           timestamp: null, tx_hash: null, synthetic: true };
            let times  = await this.doQuery(config, `SELECT block_time FROM blocks WHERE block_index=? LIMIT 1`, [closedBlock]);
            if(times && times.length) closed.timestamp = times[0].block_time;
            // Order by block, and place the synthetic latch AFTER any action-backed row
            // in the same block: within a block, user txs process before the latch pass.
            let at = rows.findIndex(r => r.block_index > closedBlock);
            if(at === -1) rows.push(closed); else rows.splice(at, 0, closed);
        }
        return rows;
    }

    // List BET wagers (bets table, one row per BET format 2 place-bet action). Joins
    // the actions/transactions/blocks chain; the bettor IS the source (a2). Filter by
    // bettor address / feed / tick / block / bet status (see getQueryWhereSql getBets).
    async getBets(config){
        let sql   = config.data.sql;
        let from  = `
                        bets m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     bs ON (bs.id=m.bet_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.feed_action_index,
                        m.outcome,
                        pt.tick,
                        m.amount,
                        bs.status as bet_status,
                        m.settled_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Oracle track record for one address (§11.1). This IS the v0 reputation system:
    // there is no bonding or staking behind it, and the record is PER-ADDRESS, so an
    // oracle can start fresh at any time. Callers MUST surface that caveat; an empty
    // history means unknown, not safe. "Resolved on time" is deliberately absent: a
    // resolve past expire_at is rejected by format 3, so every resolve is in-window
    // by construction and the distinction would be vacuous.
    async getOracleStats(config){
        let args  = [config.data.search];
        let query = `SELECT
                        fs.status as feed_status,
                        count(*)  as feeds
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE a2.address=?
                    GROUP BY fs.status`;
        let rows  = await this.doQuery(config, query, args) || [];
        let counts = { open: 0, closed: 0, resolved: 0, resolved_void: 0, cancelled: 0, expired: 0 };
        let total  = 0;
        for(const r of rows){
            if(r.feed_status in counts) counts[r.feed_status] = Number(r.feeds);
            total += Number(r.feeds);
        }
        // Active = still able to take or settle bets. Kept explicit rather than
        // derived by the caller so the market list and the oracle page agree.
        let active = counts.open + counts.closed;
        let fees   = await this.getOracleFeesEarned(config, config.data.search);
        let price  = await this.getOraclePriceRecord(config, config.data.search);
        return [{ address: config.data.search, total_feeds: total, active_feeds: active,
                  counts, fees_earned: fees, price,
                  reputation_caveat: 'Per-address record with no bonding; addresses are free to create, so an empty history means unknown, not safe.' }];
    }

    // PRICE v1 half of the per-address oracle track record. A price publisher is an
    // oracle too, but its rounds land in the hub-mirrored oracle_prices table, not
    // bet_feeds, so the stats above are blind to it and the page reported an active
    // publisher as all zeros. Aggregated per published pair (COIN/TICK/FIAT) with
    // the round counts and publish window; the individual rounds are served by
    // getOraclePrices. Returns null (a "cannot know", distinct from the zero-pair
    // record {total_publishes:0, pairs:[]}) when this node has no co-located hub DB:
    // oracle_prices is mirror-only and the betting record must still answer.
    async getOraclePriceRecord(config, address){
        let src = null;
        try {
            src = this.oracleMirrorSource(config, 'oracle_prices');
        } catch(e) {
            return null;
        }
        let rows = await this.doQuery(config,
            `SELECT
                m.coin,
                m.tick,
                m.fiat,
                count(*) as publishes,
                MIN(m.block_time) as first_publish,
                MAX(m.block_time) as last_publish
            FROM
                ${src.table} m
            WHERE
                m.source_address=?
            GROUP BY m.coin, m.tick, m.fiat
            ORDER BY last_publish DESC`, [address]) || [];
        let record = { total_publishes: 0, pairs: [] };
        for(const r of rows){
            // Counts and epoch times can arrive as BigInt; normalize so the JSON is
            // plain numbers (values are far below 2^53).
            let publishes = Number(r.publishes);
            record.total_publishes += publishes;
            record.pairs.push({
                coin: r.coin, tick: r.tick, fiat: r.fiat, publishes,
                first_publish: this.util.isNull(r.first_publish) ? null : Number(r.first_publish),
                last_publish:  this.util.isNull(r.last_publish)  ? null : Number(r.last_publish)
            });
        }
        return record;
    }

    // What an oracle has actually EARNED, per wager token (§11.1's "fees earned").
    //
    // The earning event is one ledger row and only one: settlement credits the feed
    // source a single amount carrying the FEE percent of the pot PLUS the rounding
    // dust (bet.js, §7), and only on the resolve path - a void, a cancel and an
    // expiry all pay the oracle nothing. So the sum is over `credits` rows attached
    // to a BET resolve action.
    //
    // The identity test is what makes it exact, and it is not decoration: a WINNING
    // BETTOR's payout is also a credit inside that same resolve action, so filtering
    // on the credited address alone would report other people's winnings as this
    // address's fee income the moment it ever bet on someone else's market. Requiring
    // the credited address to BE the address that submitted the resolve excludes them,
    // because format 3 is owner-only and format 2 rejects a bet from the feed source,
    // so within one resolve the oracle is credited exactly once and never as a bettor.
    async getOracleFeesEarned(config, address){
        let query = `SELECT
                        tk.tick,
                        count(*) as resolves,
                        SUM(CAST(c.amount AS DECIMAL(65,18))) as amount
                    FROM
                        credits c
                        INNER JOIN bet_resolves    br ON (br.action_index=c.action_index)
                        INNER JOIN actions         a1 ON (a1.action_index=br.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses ra ON (ra.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses ca ON (ca.id=c.address_id)
                        LEFT  JOIN index_tickers   tk ON (tk.id=c.tick_id)
                    WHERE ca.address=? AND ra.address=?
                    GROUP BY tk.tick
                    ORDER BY tk.tick ASC`;
        let rows = await this.doQuery(config, query, [address, address]) || [];
        // DECIMAL(65,18) sums arrive with an 18-place tail whatever the token's own
        // DECIMALS, so trim it here rather than in each renderer. Display only: no
        // consensus path reads this method.
        return rows.map(r => ({ tick: r.tick, resolves: Number(r.resolves),
                                amount: this.trimAmountTail(r.amount) }));
    }

    // Strip the zero tail a DECIMAL sum leaves behind ('0.175000000000000000' ->
    // '0.175'), leaving a whole number bare ('12.000...' -> '12'). Never touches a
    // significant digit, and returns non-numeric input unchanged.
    trimAmountTail(value){
        if(this.util.isNull(value)) return '0';
        let s = String(value);
        if(!/^-?\d+\.\d+$/.test(s)) return s;
        return s.replace(/0+$/, '').replace(/\.$/, '');
    }
}

module.exports = PollBetReaders.prototype;
