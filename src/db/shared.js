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
 * XChain Explorer - bindings db/index.js shares with its extracted modules
 *
 * Proposal B splits the Database class across src/db/, and every extracted
 * module exports a PROTOTYPE: anything else hung on that export would be copied
 * onto Database.prototype by mixinReaders and become a method. So a module-level
 * binding that more than one family needs, or that db/index.js must keep exporting,
 * lives here instead of travelling with one family.
 *
 * db/index.js re-exports these under their original names, because that is how every
 * caller already reaches them (XChainExplorer.js's error mapping, the route
 * layer, and the suites via `const { DbQueryError } = Database`).
 *
 ********************************************************************/

'use strict';

// The one field list every compact action summary projects (transaction and
// history rows via getActionSummaryData, BATCH members via projectActionSummary).
// Every field the client's getActionDetails reads must be here, or the summary
// renders blank on one path while the full detail page works; the drift guard
// (test/unit/db.action-summary-field-contract.test.js) pins the two against
// each other, so a new summary branch adds its field here in the same change.
const ACTION_SUMMARY_FIELDS = Object.freeze([
    'coin', 'tick',  'amount', 'source', 'destination', 'type', 'edit', 'expiration', 'allow_list', 'block_list',  // Common fields
    'action_format', 'action_index',                                                                               // Action details
    'fee_preference', 'require_memo', 'dispenser_preference',                                                      // Addresses
    'action_class', 'controller', 'unbind',                                                                        // Addresses (controller bind, v1)
    'message', 'value', 'broadcast_action_index', 'broadcast_fee',                                                 // Broadcasts
    'callback_tick', 'callback_amount',                                                                            // Callbacks
    'dividend_tick',                                                                                               // Dividends
    'name', 'title',                                                                                               // Files
    'coin1', 'coin2', 'coin1_action_index', 'coin2_action_index',                                                  // Links
    'list_action_index',                                                                                           // Lists
    'encryption_method', 'plaintext_message',                                                                      // Messages
    'give_coin', 'get_coin', 'give_tick', 'get_tick', 'give_amount', 'get_amount', 'give_escrow',                  // Orders, Swaps, Dispensers
    'order_action_index',                                                                                          // Order (cancels, edits, expires)
    'swap_action_index',                                                                                           // Swap  (cancels, edits, expires)
    'dispenser_action_index',                                                                                      // Dispesnser (cancels, edits, expires)
    'resume_block',                                                                                                // Sleep
    'balances', 'ownerships', 'orders', 'swaps', 'dispensers',                                                     // Sweeps
    'target_contract_index', 'cooldown_end_block', 'capability',                                                   // Staking (stake, unstake, delegate, slash)
    'contract_index', 'method_name', 'cooldown_blocks', 'chunk_index', 'total_chunks',                             // Contracts (deploy, execute, deposit, withdraw)
    'deployed_contract_index', 'contract_meta_name', 'contract_meta_version',                                      // Contracts: the identity the chain recorded, so history rows can print "Name vX (C:COIN:n)"
    'vote_kind',                                                                                                   // Governance
    'chain', 'network', 'checkpoint_seq', 'anchored_block_index',                                                  // Anchors
    'round_number', 'pair_count', 'fiat', 'batch_first_round', 'batch_last_round', 'round_count'                   // Prices
]);

// Lifecycle fields whose value the indexer writes AFTER the action confirmed.
// A getActionData response carrying any of them is NOT immutable and must never
// enter the action LRU, which has no TTL and reorg-only invalidation
// (isCacheableAction, and the header comment on
// test/unit/db.action-state-cache.test.js for the family's first two members).
//
// The `state` block that guard already refuses is the same defect wearing the
// one shape DISPENSER / ORDER / SWAP / LIST happen to share. These types carry
// their mutable state as PLAIN COLUMNS instead, so they slipped past it:
//
//   request_status      ATTEST v0 request: pending -> completed, and pending ->
//                       expired, the latter written by an ATTEST v2 that persists
//                       NO ROW of its own (it only flips this column and stamps
//                       resolved_block). Also XCALL's request row, pending ->
//                       completed / expired. Measured on regtest: after an
//                       expiry, /api/action/{idx} kept reporting `pending` while
//                       /api/attestations reported `expired` for the same action.
//   response_status     ATTEST response leg.
//   result_status       XCALL execution outcome, null until the call executes.
//   resolved_block      XCALL and VOTE poll, null until the round resolves.
//   poll_status         VOTE poll: open -> passed / failed, with its tallies.
//   feed_status         BET feed: open -> closed -> resolved / expired.
//   bet_status          BET wager, and settled_block with it.
//   settled_block       BET wager, null until the feed resolves.
//   deactivation_block  DELEGATE: null until a later revoke deactivates the row.
//
// Matched by PRESENCE, not by value. Null is exactly the pending state these
// fields hold at the moment a detail page is most likely to be asked for, so a
// value test would cache the very reads that go stale (resolved_block is null
// while the request is live and non-null forever after). Anything selecting one
// of these columns is a lifecycle response, and recomputing one is cheaper than
// serving a frozen answer for the life of the process.
const MUTABLE_ACTION_FIELDS = Object.freeze([
    'request_status', 'response_status', 'result_status', 'resolved_block',   // ATTEST, XCALL
    'poll_status',                                                            // VOTE
    'feed_status', 'bet_status', 'settled_block',                             // BET
    'deactivation_block'                                                      // DELEGATE
]);

// Raised by doQuery when the underlying query genuinely FAILED (connection
// unavailable after retries, or the DB rejected the statement), as opposed to
// succeeding with an empty result set. The request layer maps it to a 5xx so a
// transient DB outage reads as an outage, not as "no data" (M-4): before this,
// doQuery swallowed the error into `false` and callers rendered it as an empty
// result (e.g. an address showing a zero balance during an outage).
class DbQueryError extends Error {
    constructor(message, cause){
        super(message);
        this.name = 'DbQueryError';
        this.code = 'DB_ERROR';
        if(cause) this.cause = cause;
    }
}

// Raised by a reader when the CALLER's own parameter is malformed, as opposed to
// the query failing (DbQueryError above). The distinction matters because MariaDB
// silently coerces a non-numeric string to 0 in a numeric comparison, so a reader
// that binds a path segment straight into `WHERE <int column>=?` answers 200 with
// a real, entirely wrong record instead of erroring (/api/block/zzz returned
// block 0). Refusing in the reader protects every caller, not only the HTTP
// route; the request layer maps it to a 4xx carrying `code`, never the 5xx
// DbQueryError gets, because nothing is wrong with the service.
class DbInputError extends Error {
    constructor(message, code){
        super(message);
        this.name = 'DbInputError';
        this.code = code || 'INVALID_PARAMETER';
    }
}

// A stale coin is SERVED, not refused. The indexed rows are a true record of
// the chain up to the tip this instance holds; what a stale tip means is that
// newer blocks exist somewhere that are not here yet. Refusing the read turned
// every indexer stall into a whole-coin blackout that presented, through the
// explorer and every wallet the SDK drives from it, as the network being down,
// with years of history sitting unread in the database behind a 503. So the
// data routes answer normally and carry a freshness marker instead (headers on
// every data response, a `freshness` body field while the coin is stale, and
// `stale` on /status), and the consumer that knows whether it is reading or
// spending decides what a stale tip means for it. The old refusal is kept
// behind this opt-in for a deployment that would rather go dark than serve a
// tip it cannot vouch for; it mirrors MIRROR_LAG_FAIL_CLOSED for the hub mirror.
// configInfo is passed rather than reached through a require: this is a plain
// function with no `this`, and config.js is the one place allowed to read
// process.env, so the caller (always a Database method) hands over the config
// object it already holds.
function staleFailClosed(configInfo) {
    return configInfo.env.EXPLORER_STALE_FAIL_CLOSED === '1';
}

module.exports = { ACTION_SUMMARY_FIELDS, MUTABLE_ACTION_FIELDS, DbQueryError, DbInputError, staleFailClosed };
