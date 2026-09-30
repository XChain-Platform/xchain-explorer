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
 * XChain Explorer - the explorer's own feed routes
 *
 * The 'explorer' half of the route table: the same data the api group serves,
 * shaped for the explorer's own tables and returned in column order.
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

const AS_DECLARED_IN = {
    setupUrls : {
        urls : {
            // The same data as the api group, shaped for the explorer's own
            // tables: paged and returned in the order the columns are drawn.
            'explorer' : {
                '/{COIN}/explorer/actions/{QUERY}/{TYPE}'                   : ['getActions'],
                '/{COIN}/explorer/addresses/{QUERY}/{TYPE}'                 : ['getAddresses',    ['block', 'address']],
                '/{COIN}/explorer/airdrops/{QUERY}/{TYPE}'                  : ['getAirdrops',     ['block', 'address', 'token']],
                '/{COIN}/explorer/balances/{QUERY}/{TYPE}'                  : ['getBalances',     'address'],
                '/{COIN}/explorer/batches/{QUERY}/{TYPE}'                   : ['getBatches',      ['block', 'address']],
                '/{COIN}/explorer/blocks/{QUERY}'                           : ['getBlocks',       'block'],
                '/{COIN}/explorer/broadcasts/{QUERY}/{TYPE}'                : ['getBroadcasts',   ['block', 'address']],
                '/{COIN}/explorer/callbacks/{QUERY}/{TYPE}'                 : ['getCallbacks',    ['block', 'address', 'token']],
                '/{COIN}/explorer/credits/{QUERY}/{TYPE}'                   : ['getCredits',      ['block', 'address']],
                '/{COIN}/explorer/debits/{QUERY}/{TYPE}'                    : ['getDebits',       ['block', 'address']], 
                '/{COIN}/explorer/destroys/{QUERY}/{TYPE}'                  : ['getDestroys',     ['block', 'address', 'token']],
                '/{COIN}/explorer/dispensers/{QUERY}/{TYPE}'                : ['getDispensers',   ['block', 'address', 'token']],
                '/{COIN}/explorer/dispenses/{QUERY}/{TYPE}'                 : ['getDispenses',    ['block', 'address', 'token', 'dispenser']],
                '/{COIN}/explorer/dividends/{QUERY}/{TYPE}'                 : ['getDividends',    ['block', 'address', 'token']], 
                '/{COIN}/explorer/escrows/{QUERY}/{TYPE}'                   : ['getEscrows',      ['block', 'address']],
                '/{COIN}/explorer/fees/{QUERY}/{TYPE}'                      : ['getFees',         ['block', 'address', 'token']],
                '/{COIN}/explorer/files/{QUERY}/{TYPE}'                     : ['getFiles',        ['block', 'address', 'token']],
                '/{COIN}/explorer/holders/{QUERY}'                          : ['getHolders',      'token'],
                // See the /api/holders note above: this is the route the token page's
                // Holders tab actually requests.
                '/{COIN}/explorer/holders/{QUERY}/{TYPE}'                   : ['getHolders',      'token'],
                '/{COIN}/explorer/history/{QUERY}/{TYPE}'                   : ['getHistory',      ['block', 'address', 'token', 'recent']],
                '/{COIN}/explorer/issues/{QUERY}/{TYPE}'                    : ['getIssues',       ['block', 'address', 'token']],
                '/{COIN}/explorer/links/{QUERY}/{TYPE}'                     : ['getLinks',        ['block', 'address', 'token']],
                '/{COIN}/explorer/lists/{QUERY}/{TYPE}'                     : ['getLists',        ['block', 'address']],
                '/{COIN}/explorer/markets/{QUERY}'                          : ['getMarkets',      'tokens'],
                '/{COIN}/explorer/market/{TICK1}/{TICK2}/history'           : ['getMarketHistory'],
                '/{COIN}/explorer/market/{TICK1}/{TICK2}/history/{ADDRESS}' : ['getMarketHistory'],
                '/{COIN}/explorer/messages/{QUERY}/{TYPE}'                  : ['getMessages',     ['block', 'address']],
                '/{COIN}/explorer/mints/{QUERY}/{TYPE}'                     : ['getMints',        ['block', 'address', 'token']],
                '/{COIN}/explorer/order_matches/{QUERY}/{TYPE}'             : ['getOrderMatches', ['block']],
                '/{COIN}/explorer/orders/{QUERY}/{TYPE}'                    : ['getOrders',       ['block', 'address', 'token']],
                '/{COIN}/explorer/projects/{QUERY}/{TYPE}'                  : ['getProjectTokens', ['roster']],
                '/{COIN}/explorer/coinpays/{QUERY}/{TYPE}'                  : ['getCoinpays',     ['block', 'address']],
                '/{COIN}/explorer/coinpays'                                 : ['getCoinpays'],
                '/{COIN}/explorer/coinpay_obligations/{QUERY}/{TYPE}'       : ['getCoinpayObligations', ['block', 'address']],
                '/{COIN}/explorer/coinpay_obligations'                      : ['getCoinpayObligations'],
                // Tier-4 expire/close feeds. These already had /api routes; the /explorer
                // counterpart is what a DataTables page pages over, and each needs a
                // getPagingDataResults row mapping below to go with it. Without the pair the
                // page answers 404 and DataTables renders it as an empty table, not an error.
                '/{COIN}/explorer/order_expires/{QUERY}/{TYPE}'             : ['getOrderExpires',     ['block', 'address']],
                '/{COIN}/explorer/swap_expires/{QUERY}/{TYPE}'              : ['getSwapExpires',      ['block', 'address']],
                '/{COIN}/explorer/dispenser_expires/{QUERY}/{TYPE}'         : ['getDispenserExpires', ['block', 'address']],
                '/{COIN}/explorer/dispenser_closes/{QUERY}/{TYPE}'          : ['getDispenserCloses',  ['block', 'address']],
                '/{COIN}/explorer/coinpay_expires/{QUERY}/{TYPE}'           : ['getCoinpayExpires',   ['block', 'address']],
                // Cancel/edit feeds, the user-written half of the same lifecycles. Same
                // pairing rule as the expires above: the /api route already existed, but a
                // page pages over /explorer, and the feed is only half of it - each of these
                // also needs a getPagingDataResults row mapping below, or the page renders
                // blank cells with no error anywhere.
                '/{COIN}/explorer/order_cancels/{QUERY}/{TYPE}'             : ['getOrderCancels',     ['block', 'address']],
                '/{COIN}/explorer/order_edits/{QUERY}/{TYPE}'               : ['getOrderEdits',       ['block', 'address']],
                '/{COIN}/explorer/swap_cancels/{QUERY}/{TYPE}'              : ['getSwapCancels',      ['block', 'address']],
                '/{COIN}/explorer/swap_edits/{QUERY}/{TYPE}'                : ['getSwapEdits',        ['block', 'address']],
                '/{COIN}/explorer/dispenser_cancels/{QUERY}/{TYPE}'         : ['getDispenserCancels', ['block', 'address']],
                '/{COIN}/explorer/dispenser_edits/{QUERY}/{TYPE}'           : ['getDispenserEdits',   ['block', 'address']],
                // Feeds for the M2 list pages. price_snapshots / contract_delegations
                // already had their /api routes; the /explorer counterpart is what a
                // DataTables page pages over, and it needs a getPagingDataResults row
                // mapping to go with it (the coinpay feeds above shipped without one).
                '/{COIN}/explorer/checkpoints'                              : ['getCheckpoints'],
                '/{COIN}/explorer/price_snapshots/{QUERY}/{TYPE}'           : ['getPriceSnapshots',      ['pair', 'round', 'status']],
                '/{COIN}/explorer/price_snapshots'                          : ['getPriceSnapshots'],
                '/{COIN}/explorer/contract_delegations/{QUERY}/{TYPE}'      : ['getContractDelegations', ['block', 'address', 'contract']],
                '/{COIN}/explorer/contract_delegations'                     : ['getContractDelegations'],
                '/{COIN}/explorer/vote_delegations/{QUERY}/{TYPE}'          : ['getVoteDelegations',     ['tick', 'delegator', 'delegate', 'block']],
                '/{COIN}/explorer/vote_delegations'                         : ['getVoteDelegations'],
                '/{COIN}/explorer/capability_snapshots/{QUERY}/{TYPE}'      : ['getCapabilitySnapshots', ['capability', 'block', 'pubkey']],
                '/{COIN}/explorer/capability_snapshots'                     : ['getCapabilitySnapshots'],
                // Registered ahead of its page: M4.6 renders anchor_reward_attestations,
                // and the datatable-endpoint guard requires the feed to already agree with
                // whatever loadDatatablesData the fragment eventually calls.
                '/{COIN}/explorer/anchor_reward_attestations/{QUERY}/{TYPE}' : ['getAnchorRewardAttestations', ['anchor', 'block', 'pubkey']],
                '/{COIN}/explorer/anchor_reward_attestations'                : ['getAnchorRewardAttestations'],
                // 'name' is what the contracts list page's own search box asks for.
                '/{COIN}/explorer/contracts/{QUERY}/{TYPE}'                  : ['getContracts',    ['block', 'address', 'name']],
                '/{COIN}/explorer/executions/{QUERY}/{TYPE}'                 : ['getExecutions',   ['block', 'address', 'contract']],
                '/{COIN}/explorer/emissions/{QUERY}/{TYPE}'                  : ['getEmissions',    ['contract', 'execution', 'block']],
                '/{COIN}/explorer/emissions'                                 : ['getEmissions'],
                '/{COIN}/explorer/deploy_chunks'                             : ['getDeployChunks'],
                '/{COIN}/explorer/deposits/{QUERY}/{TYPE}'                   : ['getDeposits',     ['block', 'address', 'contract']],
                '/{COIN}/explorer/withdrawals/{QUERY}/{TYPE}'                : ['getWithdrawals',  ['block', 'address', 'contract']],
                '/{COIN}/explorer/stakes/{QUERY}/{TYPE}'                     : ['getStakes',       ['block', 'address']],
                '/{COIN}/explorer/delegations/{QUERY}/{TYPE}'                : ['getDelegations',  ['block', 'address']],
                '/{COIN}/explorer/rewards/{QUERY}/{TYPE}'                    : ['getValidatorRewards', ['address']],
                '/{COIN}/explorer/full_node_verifications/{QUERY}/{TYPE}'    : ['getFullNodeVerifications', ['block', 'epoch', 'pubkey', 'address']],
                '/{COIN}/explorer/validators/{QUERY}/{TYPE}'                 : ['getValidators',   ['block', 'address']],
                '/{COIN}/explorer/contract_stakes/{QUERY}/{TYPE}'           : ['getContractStakes',   ['block', 'address', 'contract']],
                '/{COIN}/explorer/contract_unstakes/{QUERY}/{TYPE}'         : ['getContractUnstakes', ['block', 'address', 'contract']],
                '/{COIN}/explorer/slash_events/{QUERY}/{TYPE}'              : ['getSlashEvents',  ['block', 'address', 'contract']],
                '/{COIN}/explorer/unstakes/{QUERY}/{TYPE}'                  : ['getUnstakes',     ['block', 'address', 'source']],
                '/{COIN}/explorer/delegation_revocations/{QUERY}/{TYPE}'    : ['getStakeKeyRevocations', ['block', 'address', 'source']],
                '/{COIN}/explorer/collects/{QUERY}/{TYPE}'                  : ['getCollects',     ['block', 'address', 'source']],
                '/{COIN}/explorer/capability_slash_events/{QUERY}/{TYPE}'   : ['getCapabilitySlashEvents', ['block', 'capability', 'pubkey', 'address']],
                '/{COIN}/explorer/oracle_prices/{QUERY}/{TYPE}'             : ['getOraclePrices', ['token', 'address']],
                '/{COIN}/explorer/validator_capabilities/{QUERY}/{TYPE}'    : ['getValidatorCapabilities', ['capability', 'pubkey']],
                '/{COIN}/explorer/governance_proposals/{QUERY}/{TYPE}'      : ['getGovernanceProposals',   ['status', 'parameter', 'proposal']],
                '/{COIN}/explorer/governance_votes/{QUERY}/{TYPE}'          : ['getGovernanceVotes',       ['proposal', 'voter']],
                '/{COIN}/explorer/reorgs/{QUERY}/{TYPE}'                    : ['getReorgs',                ['status', 'block']],
                '/{COIN}/explorer/reorgs'                                   : ['getReorgs'],
                '/{COIN}/explorer/slash_proposals/{QUERY}/{TYPE}'           : ['getSlashProposals',        ['status', 'pubkey']],
                '/{COIN}/explorer/slash_proposals'                          : ['getSlashProposals'],
                '/{COIN}/explorer/peers/{QUERY}/{TYPE}'                     : ['getPeers',                 ['validator']],
                '/{COIN}/explorer/consensus_state/{QUERY}/{TYPE}'           : ['getConsensusState',        ['key']],
                '/{COIN}/explorer/configs/{QUERY}/{TYPE}'                   : ['getConfigs',               ['coin', 'module']],
                '/{COIN}/explorer/telemetry_pings/{QUERY}/{TYPE}'           : ['getTelemetryPings',        ['event', 'install', 'country']],
                '/{COIN}/explorer/attestations/{QUERY}/{TYPE}'              : ['getAttestations', ['block', 'address', 'contract']],
                '/{COIN}/explorer/attest_validator_stats/{QUERY}/{TYPE}'    : ['getAttestValidatorStats', ['pubkey', 'provider']],
                '/{COIN}/explorer/attest_validator_stats'                   : ['getAttestValidatorStats'],
                '/{COIN}/explorer/bet_feeds/{QUERY}/{TYPE}'                 : ['getBetFeeds',     ['block', 'address', 'source', 'token', 'status']],
                '/{COIN}/explorer/bets/{QUERY}/{TYPE}'                      : ['getBets',         ['block', 'address', 'feed', 'token', 'status']],
                '/{COIN}/explorer/polls/{QUERY}/{TYPE}'                     : ['getPolls',        ['block', 'tick', 'status', 'source']],
                '/{COIN}/explorer/votes/{QUERY}/{TYPE}'                     : ['getVotes',        ['address', 'poll', 'block']],
                '/{COIN}/explorer/xcalls/{QUERY}/{TYPE}'                    : ['getXcalls',       ['block', 'contract', 'status']],
                '/{COIN}/explorer/xcalls/{QUERY}'                           : ['getXcalls',       'block'],
                '/{COIN}/explorer/anchors/{QUERY}/{TYPE}'                   : ['getAnchors',      ['block', 'chain', 'network', 'status']],
                '/{COIN}/explorer/commitments/{QUERY}/{TYPE}'               : ['getCommitments',  ['block']],
                '/{COIN}/explorer/commitments'                              : ['getCommitments'],
                '/{COIN}/explorer/cross_chain_matches/{QUERY}/{TYPE}'       : ['getCrossChainMatches',     ['match', 'block', 'status']],
                '/{COIN}/explorer/cross_chain_settlements/{QUERY}/{TYPE}'   : ['getCrossChainSettlements', ['match', 'block']],
                '/{COIN}/explorer/prices/{QUERY}/{TYPE}'                    : ['getPrices',       ['block', 'address', 'source', 'token']],
                '/{COIN}/explorer/prices'                                   : ['getPrices'],
                '/{COIN}/explorer/controllers'                              : ['getControllers'],
                '/{COIN}/explorer/sends/{QUERY}/{TYPE}'                     : ['getSends',        ['block', 'address', 'token']],
                '/{COIN}/explorer/search/{QUERY}/{TYPE}'                    : ['getSearch',       ['address', 'broadcast', 'contract', 'token', 'transaction']],
                '/{COIN}/explorer/sleeps/{QUERY}/{TYPE}'                    : ['getSleeps',       ['block', 'address', 'token']],
                '/{COIN}/explorer/swap_matches/{QUERY}/{TYPE}'              : ['getSwapMatches',  ['block']],
                '/{COIN}/explorer/swaps/{QUERY}/{TYPE}'                     : ['getSwaps',        ['block', 'address', 'token']],
                '/{COIN}/explorer/sweeps/{QUERY}/{TYPE}'                    : ['getSweeps',       ['block', 'address']],
                '/{COIN}/explorer/tokens/{QUERY}/{TYPE}'                    : ['getTokens',       ['block', 'address', 'token', 'subtoken']]
            }
        }
    }
};

module.exports = AS_DECLARED_IN.setupUrls.urls;
