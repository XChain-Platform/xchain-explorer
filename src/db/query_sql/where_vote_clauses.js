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
 * XChain Explorer - WHERE clauses for the poll, vote and bet lists
 *
 * One part of src/db/query_sql.js: the clause builders for VOTE (polls, their
 * frozen results, ballots and delegations) and BET (feeds and wagers). They are
 * grouped together because they share one shape: an actions/transactions/blocks
 * join whose source IS the participant (a2), a tick join for the wagered or
 * polled token, and a lifecycle status read from the STORED enum rather than
 * recomputed against a clock. Each builder takes the anchor the entry resolved
 * and returns the whole WHERE text for its method.
 *
 * Plain functions, not a class body: nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

function pollsClause(db, config, sql){
    let type = config.data.type;
    // polls (VOTE v0) joins the actions/transactions/blocks chain (b1 via t1) like
    // getAttestations. tick joins index_tickers (pt) on m.tick_id; source is the poll
    // creator (a2 via the action source); status filters the poll lifecycle enum directly.
    if(type=='block')  sql += ' AND b1.block_index=?';
    if(type=='tick')   sql += ' AND pt.tick=?';
    if(type=='status') sql += ' AND m.poll_status=?';
    if(type=='source') sql += ' AND a2.address=?';
    return sql;
}

function pollClause(db, config, sql){
    // single poll keyed by its creating action_index (the poll id)
    sql += ' AND m.action_index=?';
    return sql;
}

function pollResultsClause(db, config, sql){
    // poll_results is keyed by poll_index (the poll's creating action_index); the frozen
    // per-option tally has no actions chain of its own to filter on.
    sql += ' AND m.poll_index=?';
    return sql;
}

function votesClause(db, config, sql){
    let type = config.data.type;
    // votes (VOTE v1 ballots) joins the actions/transactions/blocks chain; the voter IS
    // the source that cast the ballot (a2 via the action source), so address filters on a2.
    if(type=='address') sql += ' AND a2.address=?';
    if(type=='poll')    sql += ' AND m.poll_index=?';
    if(type=='block')   sql += ' AND b1.block_index=?';
    return sql;
}

function voteDelegationsClause(db, config, sql){
    let type = config.data.type;
    // vote_delegations (VOTE v3 liquid democracy) joins the actions/transactions/
    // blocks chain via m.action_index like getContractDelegations. tick resolves
    // through index_tickers (t3) on m.tick_id; delegator/delegate resolve through
    // index_addresses (dgr/dg) on delegator_address_id/delegate_address_id. The
    // latest-active-per-key exclusion lives in getVoteDelegations' own SQL (a
    // correlated MAX), not here: this branch only narrows by the requested TYPE.
    if(type=='tick')      sql += ' AND t3.tick=?';
    if(type=='delegator') sql += ' AND dgr.address=?';
    if(type=='delegate')  sql += ' AND dg.address=?';
    if(type=='block')     sql += ' AND b1.block_index=?';
    return sql;
}

function betFeedsClause(db, config, sql){
    let type = config.data.type;
    // bet_feeds (BET format 0) joins the actions/transactions/blocks chain like
    // getPolls. tick joins index_tickers (pt) on the wager token; source is the
    // oracle that created the feed (a2 via the action source); status filters the
    // STORED feed lifecycle enum through index_statuses (fs), never a clock
    // recomputation. 'address' is an alias of 'source' here because a feed has
    // exactly one participating address of its own (the oracle); bettors are
    // reachable via getBets(feed).
    if(type=='block')   sql += ' AND b1.block_index=?';
    if(type=='token')   sql += ' AND pt.tick=?';
    if(type=='status')  sql += ' AND fs.status=?';
    if(type=='source')  sql += ' AND a2.address=?';
    if(type=='address') sql += ' AND a2.address=?';
    return sql;
}

function betFeedClause(db, config, sql){
    // single market keyed by its creating action_index (the feed id)
    sql += ' AND m.action_index=?';
    return sql;
}

function betsClause(db, config, sql){
    let type = config.data.type;
    // bets (BET format 2 ballots-equivalent) joins the actions/transactions/blocks
    // chain; the bettor IS the source that placed the wager (a2 via the action source).
    // 'feed' filters to one market, matching getVotes' 'poll'.
    if(type=='address') sql += ' AND a2.address=?';
    if(type=='feed')    sql += ' AND m.feed_action_index=?';
    if(type=='token')   sql += ' AND pt.tick=?';
    if(type=='status')  sql += ' AND bs.status=?';
    if(type=='block')   sql += ' AND b1.block_index=?';
    return sql;
}

const VOTE_CLAUSE_BUILDERS = {
    getPolls:           pollsClause,
    getPoll:            pollClause,
    getPollResults:     pollResultsClause,
    getVotes:           votesClause,
    getVoteDelegations: voteDelegationsClause,
    getBetFeeds:        betFeedsClause,
    getBetFeed:         betFeedClause,
    getBets:            betsClause
};

module.exports = { VOTE_CLAUSE_BUILDERS };
