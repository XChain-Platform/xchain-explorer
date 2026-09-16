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
 * XChain Explorer - the static mount list and the page routes
 *
 * The 'static' and 'html' halves of the route table: the directories served
 * straight off disk, and every page URL with the HTML content file behind it.
 *
 * The entries keep the column they had as members of the `let urls = {...}`
 * literal inside setupUrls(), and the two keys they are wrapped in are named
 * after the two scopes that used to supply that depth. The leading form of these
 * lines is read by tools outside this file: the platform route parser both explorer
 * sweeps share scopes its page parse to the page table by the column its key sits in
 * and closes it at the brace in that column, bin/explorer-identity.js hashes what it
 * saw, and the list-page suites match that shape out of the source text. Re-indenting
 * the table would change what every one of them sees while changing nothing at all
 * at runtime.
 *
 ********************************************************************/

'use strict';

const staticMounts = require('../../http/static_mounts.js');   // the one file-serving mount list, shared with api.js's limiter skip

const AS_DECLARED_IN = {
    setupUrls : {
        urls : {
            // Directories served straight off disk, the raw file and no processing.

            // Mount list lives in src/http/static_mounts.js, which is also what the rate
            // limiter and concurrency gate read to decide what to exempt: one list, so
            // a directory added here can never be silently limited (or, worse, a
            // limiter exemption granted to something that is not served from disk).
            'static' : staticMounts.STATIC_DIRECTORIES,

            // Each page URL and the HTML content file served for it.
            'html' : {
                // Top level pages
                '/'                           : 'home.html',
                '/about'                      : 'about.html',
                '/api'                        : 'api.html',
                '/privacy'                    : 'privacy.html',
                '/search'                     : 'search.html',
                '/terms'                      : 'terms.html',
                '/404'                        : '404.html',
                '/coin-unavailable'           : 'coin_unavailable.html', 
                // Actions
                '/{COIN}/actions'             : 'actions.html',
                '/{COIN}/addresses'           : 'addresses.html',
                '/{COIN}/airdrops'            : 'airdrops.html',
                '/{COIN}/batches'             : 'batches.html',
                '/{COIN}/broadcasts'          : 'broadcasts.html',
                '/{COIN}/callbacks'           : 'callbacks.html',
                '/{COIN}/destroys'            : 'destroys.html',
                '/{COIN}/dividends'           : 'dividends.html',
                '/{COIN}/dispensers'          : 'dispensers.html',
                '/{COIN}/dispenses'           : 'dispenses.html',
                // Dispenser terminal states: a DISPENSER_EXPIRE is the protocol retiring a
                // dispenser at its expiration height, a DISPENSER_CLOSE is the owner doing
                // it deliberately. Both return the remaining escrow, so the list carries the
                // closed dispenser's give/get terms rather than just the pointer.
                '/{COIN}/dispenser_expires'   : 'dispenser_expires.html',
                '/{COIN}/dispenser_closes'    : 'dispenser_closes.html',
                // The two USER-written amendments to a live dispenser: a DISPENSER_CANCEL
                // withdraws it, a DISPENSER_EDIT changes its escrow, expiration or lists.
                // An edit only carries the fields it changed, so a null column means "this
                // edit left that setting alone", not "the setting is empty".
                '/{COIN}/dispenser_cancels'   : 'dispenser_cancels.html',
                '/{COIN}/dispenser_edits'     : 'dispenser_edits.html',
                '/{COIN}/fees'                : 'fees.html',
                '/{COIN}/files'               : 'files.html',
                '/{COIN}/history'             : 'history.html',
                '/{COIN}/issues'              : 'issues.html',
                '/{COIN}/links'               : 'links.html',
                '/{COIN}/lists'               : 'lists.html',
                '/{COIN}/markets'             : 'markets.html',
                '/{COIN}/messages'            : 'messages.html',
                '/{COIN}/mints'               : 'mints.html',
                '/{COIN}/orders'              : 'orders.html',
                '/{COIN}/order_matches'       : 'order_matches.html',
                // An ORDER_EXPIRE / SWAP_EXPIRE is written by the protocol, not by a user
                // transaction: it is how an unfilled order or swap leaves the book, and the
                // row points back at the order/swap it retired.
                '/{COIN}/order_expires'       : 'order_expires.html',
                '/{COIN}/swap_expires'        : 'swap_expires.html',
                // The user-written counterparts: an ORDER_CANCEL / SWAP_CANCEL pulls the
                // record off the book, an ORDER_EDIT / SWAP_EDIT amends it in place. The
                // edit lists lead with what the edit CHANGED (expiration, allow/block list),
                // because the amended terms are the only reason the row exists.
                '/{COIN}/order_cancels'       : 'order_cancels.html',
                '/{COIN}/order_edits'         : 'order_edits.html',
                '/{COIN}/swap_cancels'        : 'swap_cancels.html',
                '/{COIN}/swap_edits'          : 'swap_edits.html',
                '/{COIN}/contracts'            : 'contracts.html',
                '/{COIN}/contract/{QUERY}'    : 'contract.html',
                '/{COIN}/executions'          : 'executions.html',
                '/{COIN}/deploy_chunks'       : 'deploy_chunks.html',
                '/{COIN}/execution/{QUERY}'   : 'execution.html',
                '/{COIN}/deposits'            : 'deposits.html',
                '/{COIN}/withdrawals'         : 'withdrawals.html',
                '/{COIN}/validators'          : 'validators.html',
                // One validator's whole record, resolvable by signing pubkey OR by address.
                '/{COIN}/validator/{QUERY}'   : 'validator.html',
                '/{COIN}/stakes'              : 'stakes.html',
                '/{COIN}/contract_stakes'     : 'contract_stakes.html',
                '/{COIN}/prices'              : 'prices.html',
                '/{COIN}/controllers'         : 'controllers.html',
                '/{COIN}/contract_unstakes'   : 'contract_unstakes.html',
                // M5 composed product views. Each of the three is a VIEW over data that
                // already had an API, not a new data source: the gallery classifies
                // `tokens` by its ISSUE fields, the rich list ranks `balances` for one
                // tick, and the governance page puts two DELIBERATELY SEPARATE systems
                // (indexer token polls, hub network-parameter proposals) side by side
                // without merging them.
                '/{COIN}/collectibles'        : 'collectibles.html',
                '/{COIN}/rich_list/{QUERY}'   : 'rich_list.html',
                '/{COIN}/governance'          : 'governance.html',
                '/{COIN}/anchors'             : 'anchors.html',
                // An anchor carries TWO heights and both are correct: block_index is the
                // CHECKPOINTED height, which is what the commitments join keys off, while
                // the ANCHOR transaction itself landed at a later height. The page labels
                // both, because hunting one by the other reads as "not yet anchored".
                '/{COIN}/anchor/{QUERY}'      : 'anchor.html',
                // Quorum-signed state checkpoints: the list is the light-client
                // surface, the detail view renders one checkpoint's roots + signers
                // and puts the CPU-bound re-verification behind a click (the
                // /api/checkpoint/{BLOCK}/verify route, not this page's own load).
                '/{COIN}/checkpoints'         : 'checkpoints.html',
                '/{COIN}/checkpoint/{QUERY}'  : 'checkpoint.html',
                '/{COIN}/price_snapshots'     : 'price_snapshots.html',
                // The historical electorate behind those checkpoints: which signing keys
                // carried which stake weight for a capability at each snapshot block.
                '/{COIN}/capability_snapshots' : 'capability_snapshots.html',
                '/{COIN}/contract_delegations' : 'contract_delegations.html',
                '/{COIN}/vote_delegations'    : 'vote_delegations.html',
                '/{COIN}/attest_validator_stats' : 'attest_validator_stats.html',
                '/{COIN}/reorgs'              : 'reorgs.html',
                '/{COIN}/slash_proposals'     : 'slash_proposals.html',
                // COINPAY: `coinpays` are the settlement records, `coinpay_obligations`
                // the who-owes-what-native-coin view an ORDER_MATCH creates.
                '/{COIN}/coinpays'            : 'coinpays.html',
                '/{COIN}/coinpay_obligations' : 'coinpay_obligations.html',
                // The obligation that was never paid: a COINPAY_EXPIRE closes it out at its
                // expiration. It carries no source address of its own (the protocol writes
                // it), so the list shows the obligation it retired in that column instead.
                '/{COIN}/coinpay_expires'     : 'coinpay_expires.html',
                '/{COIN}/cross_chain_matches' : 'cross_chain_matches.html',
                '/{COIN}/cross_chain_settlements' : 'cross_chain_settlements.html',
                '/{COIN}/rewards'             : 'rewards.html',
                '/{COIN}/delegations'         : 'delegations.html',
                '/{COIN}/full_node_verifications' : 'full_node_verifications.html',
                '/{COIN}/unstakes'            : 'unstakes.html',
                '/{COIN}/delegation_revocations' : 'delegation_revocations.html',
                '/{COIN}/collects'            : 'collects.html',
                '/{COIN}/slash_events'        : 'slash_events.html',
                '/{COIN}/capability_slash_events' : 'capability_slash_events.html',
                '/{COIN}/oracle_prices'       : 'oracle_prices.html',
                '/{COIN}/validator_capabilities' : 'validator_capabilities.html',
                '/{COIN}/governance_proposals' : 'governance_proposals.html',
                '/{COIN}/governance_votes'    : 'governance_votes.html',
                '/{COIN}/peers'              : 'peers.html',
                '/{COIN}/consensus_state'    : 'consensus_state.html',
                '/{COIN}/configs'            : 'configs.html',
                '/{COIN}/telemetry_pings'    : 'telemetry_pings.html',
                '/{COIN}/attestations'        : 'attestations.html',
                // The attestation lifecycle across rows (v0 request, v1 response and its
                // signatures, v2 expiry, relay legs), which the per-action view cannot show
                // because each leg is its own action.
                '/{COIN}/attestation/{QUERY}' : 'attestation.html',
                '/{COIN}/bet_feeds'           : 'bet_feeds.html',
                '/{COIN}/bets'                : 'bets.html',
                '/{COIN}/bet_feed/{QUERY}'    : 'bet_feed.html',
                '/{COIN}/oracle/{QUERY}'      : 'oracle.html',
                '/{COIN}/polls'               : 'polls.html',
                '/{COIN}/poll/{QUERY}'        : 'poll.html',
                '/{COIN}/votes'               : 'votes.html',
                '/{COIN}/xcalls'              : 'xcalls.html',
                // Keyed by call_id, but declared {QUERY} like every other detail route so
                // the detail-route/allowlist guard can see it.
                '/{COIN}/xcall/{QUERY}'       : 'xcall.html',
                '/{COIN}/sends'               : 'sends.html',
                '/{COIN}/sleeps'              : 'sleeps.html',
                '/{COIN}/swaps'               : 'swaps.html',
                '/{COIN}/swap_matches'        : 'swap_matches.html',
                '/{COIN}/sweeps'              : 'sweeps.html',
                '/{COIN}'                     : 'coin_home.html',
                '/{COIN}/blocks'              : 'blocks.html',
                '/{COIN}/search'              : 'search.html',
                '/{COIN}/tokens'              : 'tokens.html',
                '/{COIN}/terms'               : 'terms.html',
                '/{COIN}/mempool'             : 'mempool.html',
                // Detail pages, each showing one specific record
                '/{COIN}/address/{QUERY}'     : 'address.html',
                '/{COIN}/action/{QUERY}'      : 'action.html',
                '/{COIN}/block/{QUERY}'       : 'block.html',
                '/{COIN}/dispenser/{QUERY}'   : 'dispenser.html',
                '/{COIN}/market/{QUERY}'      : 'market.html',
                '/{COIN}/token/{QUERY}'       : 'token.html',
                '/{COIN}/transaction/{QUERY}' : 'transaction.html'

            },
        }
    }
};

module.exports = AS_DECLARED_IN.setupUrls.urls;
