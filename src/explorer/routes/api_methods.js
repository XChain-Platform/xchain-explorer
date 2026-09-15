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
 * XChain Explorer - the public JSON API routes
 *
 * The 'api' half of the route table: each public endpoint, the database method
 * it calls, and the search types that endpoint accepts.
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
            // The public JSON API: each endpoint, the database method it calls,
            // and the search types that endpoint accepts.
            'api' : {
                '/{COIN}/api/addresses/{QUERY}/{TYPE}'         : ['getAddresses',        ['block', 'address']],
                '/{COIN}/api/airdrops/{QUERY}/{TYPE}'          : ['getAirdrops',         ['block', 'address', 'token']],
                '/{COIN}/api/batches/{QUERY}/{TYPE}'           : ['getBatches',          ['block', 'address']],
                '/{COIN}/api/broadcasts/{QUERY}/{TYPE}'        : ['getBroadcasts',       ['block', 'address']],
                '/{COIN}/api/callbacks/{QUERY}/{TYPE}'         : ['getCallbacks',        ['block', 'address', 'token']],
                '/{COIN}/api/destroys/{QUERY}/{TYPE}'          : ['getDestroys',         ['block', 'address', 'token']],
                '/{COIN}/api/dividends/{QUERY}/{TYPE}'         : ['getDividends',        ['block', 'address', 'token']],
                '/{COIN}/api/dispensers/{QUERY}/{TYPE}'        : ['getDispensers',       ['block', 'address', 'source', 'destination', 'token', 'oracle']],
                '/{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}' : ['getDispenserCancels', ['block', 'address']],
                '/{COIN}/api/dispenser_closes/{QUERY}/{TYPE}'  : ['getDispenserCloses',  ['block', 'address']],
                '/{COIN}/api/dispenser_expires/{QUERY}/{TYPE}' : ['getDispenserExpires', ['block', 'address']],
                '/{COIN}/api/dispenser_edits/{QUERY}/{TYPE}'   : ['getDispenserEdits',   ['block', 'address']],
                '/{COIN}/api/dispenses/{QUERY}/{TYPE}'         : ['getDispenses',        ['block', 'address', 'source', 'destination', 'token', 'dispenser']],
                '/{COIN}/api/fees/{QUERY}/{TYPE}'              : ['getFees',             ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/files/{QUERY}/{TYPE}'             : ['getFiles',            ['block', 'address', 'token', 'name']],
                '/{COIN}/api/issues/{QUERY}/{TYPE}'            : ['getIssues',           ['block', 'address', 'token']],
                '/{COIN}/api/links/{QUERY}/{TYPE}'             : ['getLinks',            ['block', 'address']],
                '/{COIN}/api/lists/{QUERY}/{TYPE}'             : ['getLists',            ['block', 'address']],
                '/{COIN}/api/messages/{QUERY}/{TYPE}'          : ['getMessages',         ['block', 'address', 'source', 'destination']],
                '/{COIN}/api/mints/{QUERY}/{TYPE}'             : ['getMints',            ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/orders/{QUERY}/{TYPE}'            : ['getOrders',           ['block', 'address', 'token']],
                '/{COIN}/api/order_expires/{QUERY}/{TYPE}'     : ['getOrderExpires',     ['block', 'address']],
                '/{COIN}/api/order_edits/{QUERY}/{TYPE}'       : ['getOrderEdits',       ['block', 'address']],
                '/{COIN}/api/order_cancels/{QUERY}/{TYPE}'     : ['getOrderCancels',     ['block', 'address']],
                '/{COIN}/api/order_matches/{QUERY}/{TYPE}'     : ['getOrderMatches',     ['block']],
                '/{COIN}/api/order_matches'                    : ['getOrderMatches'],
                '/{COIN}/api/coinpays/{QUERY}/{TYPE}'           : ['getCoinpays',          ['block', 'address']],
                '/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}'    : ['getCoinpayExpires',     ['block', 'address']],
                '/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}': ['getCoinpayObligations', ['block', 'address']],
                // Price Endpoints (PRICE v0 validator COIN/FIAT snapshots + v1 user TOKEN/FIAT oracle)
                '/{COIN}/api/prices/{QUERY}/{TYPE}'           : ['getPrices',           ['block', 'address', 'source', 'token']],
                '/{COIN}/api/prices'                          : ['getPrices'],
                '/{COIN}/api/price_snapshots/{QUERY}/{TYPE}'  : ['getPriceSnapshots',    ['pair', 'round', 'status']],
                '/{COIN}/api/price_snapshots'                 : ['getPriceSnapshots'],
                // Controller-bound token / address policy guards (controller-bound-tokens.md): bind/unbind event stream
                '/{COIN}/api/controllers'                     : ['getControllers'],
                // VM / Contract Endpoints
                // 'name' searches the contract identity manifest (meta_name, meta_description)
                // through the contracts table's FULLTEXT index, not by LIKE (spec 2.6).
                '/{COIN}/api/contracts/{QUERY}/{TYPE}'         : ['getContracts',        ['block', 'address', 'source', 'name']],
                '/{COIN}/api/contracts'                        : ['getContracts'],
                '/{COIN}/api/contract/{QUERY}'                 : ['getContract',          'contract'],
                '/{COIN}/api/contract/{QUERY}/state'           : ['getContractState',     'contract'],
                '/{COIN}/api/contract/{QUERY}/state/{TYPE}'    : ['getContractState',     'contract'],
                '/{COIN}/api/contract/{QUERY}/balance'         : ['getContractBalance',   'contract'],
                '/{COIN}/api/contract/{QUERY}/balance/{TYPE}'  : ['getContractBalance',   'contract'],
                '/{COIN}/api/executions/{QUERY}/{TYPE}'        : ['getExecutions',        ['block', 'address', 'contract']],
                '/{COIN}/api/executions'                       : ['getExecutions'],
                '/{COIN}/api/execution/{QUERY}'                : ['getExecution',          'execution'],
                // Contract action emissions, rolled up per CONTRACT across every EXECUTE
                // call against it (contract_emissions joined through contract_executions).
                '/{COIN}/api/emissions/{QUERY}/{TYPE}'         : ['getEmissions',         ['contract', 'execution', 'block']],
                '/{COIN}/api/emissions'                        : ['getEmissions'],
                '/{COIN}/api/deploy_chunks'                    : ['getDeployChunks'],
                '/{COIN}/api/deposits/{QUERY}/{TYPE}'          : ['getDeposits',          ['block', 'address', 'source', 'contract']],
                '/{COIN}/api/withdrawals/{QUERY}/{TYPE}'       : ['getWithdrawals',       ['block', 'address', 'source', 'contract']],
                '/{COIN}/api/stakes/{QUERY}/{TYPE}'            : ['getStakes',            ['block', 'address', 'source']],
                '/{COIN}/api/stakes'                           : ['getStakes'],
                '/{COIN}/api/validators'                       : ['getValidators'],
                // One validator's whole record in a single response, resolved by signing
                // pubkey OR address. A composition, not a filter: the existing list methods
                // have no pubkey type of their own (getValidators/getStakes/getSlashEvents
                // each JOIN a pubkey column but expose only 'address'), so a page built
                // from them alone could not answer by pubkey at all.
                '/{COIN}/api/validator/{QUERY}'                : ['getValidator',         'validator'],
                // The same composition scoped to ONE address, for the address page's
                // staking panel: positions, cooldowns, the COLLECT trail and both slash
                // families, instead of the six separate calls the page would otherwise make.
                '/{COIN}/api/staking/{QUERY}'                  : ['getAddressStaking',    'address'],
                '/{COIN}/api/delegations/{QUERY}/{TYPE}'       : ['getDelegations',       ['block', 'address', 'source']],
                '/{COIN}/api/rewards/{QUERY}/{TYPE}'           : ['getValidatorRewards',  ['address', 'source']],
                // Full-node possession-proof verdicts (NODEPROOF v0, read-only)
                '/{COIN}/api/full_node_verifications/{QUERY}/{TYPE}' : ['getFullNodeVerifications', ['block', 'epoch', 'pubkey', 'address']],
                '/{COIN}/api/full_node_verifications'               : ['getFullNodeVerifications'],
                // Contract-targeted Staking (STAKE v3 / UNSTAKE v1 + slash side-effects)
                '/{COIN}/api/contract_stakes/{QUERY}/{TYPE}'   : ['getContractStakes',    ['block', 'address', 'contract']],
                '/{COIN}/api/contract_stakes'                  : ['getContractStakes'],
                '/{COIN}/api/contract_unstakes/{QUERY}/{TYPE}' : ['getContractUnstakes',  ['block', 'address', 'contract']],
                '/{COIN}/api/contract_unstakes'                : ['getContractUnstakes'],
                '/{COIN}/api/contract_delegations/{QUERY}/{TYPE}' : ['getContractDelegations', ['block', 'address', 'contract']],
                '/{COIN}/api/contract_delegations'             : ['getContractDelegations'],
                // VOTE v3 liquid-democracy delegations. Live-only: a delegation that was
                // later re-pointed or cleared is excluded server-side, never listed as current.
                '/{COIN}/api/vote_delegations/{QUERY}/{TYPE}'  : ['getVoteDelegations',   ['tick', 'delegator', 'delegate', 'block']],
                '/{COIN}/api/vote_delegations'                 : ['getVoteDelegations'],
                '/{COIN}/api/slash_events/{QUERY}/{TYPE}'      : ['getSlashEvents',       ['block', 'address', 'contract']],
                '/{COIN}/api/slash_events'                     : ['getSlashEvents'],
                // Capability staking lifecycle list views (UNSTAKE v0, DELEGATE v2/v3 revoke, COLLECT)
                '/{COIN}/api/unstakes/{QUERY}/{TYPE}'          : ['getUnstakes',          ['block', 'address', 'source']],
                '/{COIN}/api/unstakes'                         : ['getUnstakes'],
                '/{COIN}/api/delegation_revocations/{QUERY}/{TYPE}' : ['getStakeKeyRevocations', ['block', 'address', 'source']],
                '/{COIN}/api/delegation_revocations'           : ['getStakeKeyRevocations'],
                '/{COIN}/api/collects/{QUERY}/{TYPE}'          : ['getCollects',          ['block', 'address', 'source']],
                '/{COIN}/api/collects'                         : ['getCollects'],
                // Capability equivocation slashes (SLASH wire action; capability_slash_events, id-keyed)
                '/{COIN}/api/capability_slash_events/{QUERY}/{TYPE}' : ['getCapabilitySlashEvents', ['block', 'capability', 'pubkey', 'address']],
                '/{COIN}/api/capability_slash_events'          : ['getCapabilitySlashEvents'],
                // User token/fiat oracle publications (PRICE v1; hub-mirrored oracle_prices, id-keyed)
                '/{COIN}/api/oracle_prices/{QUERY}/{TYPE}'     : ['getOraclePrices',      ['token', 'address']],
                '/{COIN}/api/oracle_prices'                    : ['getOraclePrices'],
                // Hub federation + governance state (read from the mandatory co-located hub DB, id-keyed).
                // The validator registry itself is already surfaced on-chain via getValidators; these
                // expose the hub-only capability + governance tables that have no on-chain action.
                '/{COIN}/api/validator_capabilities/{QUERY}/{TYPE}' : ['getValidatorCapabilities', ['capability', 'pubkey']],
                '/{COIN}/api/validator_capabilities'              : ['getValidatorCapabilities'],
                '/{COIN}/api/governance_proposals/{QUERY}/{TYPE}'  : ['getGovernanceProposals',   ['status', 'parameter', 'proposal']],
                '/{COIN}/api/governance_proposals'                : ['getGovernanceProposals'],
                '/{COIN}/api/governance_votes/{QUERY}/{TYPE}'      : ['getGovernanceVotes',       ['proposal', 'voter']],
                '/{COIN}/api/governance_votes'                    : ['getGovernanceVotes'],
                // Cross-chain reorg attestations, scoped to THIS coin's chain on both
                // transports (the hub RPC returns every chain's history unfiltered).
                '/{COIN}/api/reorgs/{QUERY}/{TYPE}'               : ['getReorgs',               ['status', 'block']],
                '/{COIN}/api/reorgs'                              : ['getReorgs'],
                // Federation slash proposals (hub-owned, platform-global: no chain
                // axis, so no per-coin scope). Pending rows are UNADJUDICATED
                // accusations; evidence is served as a hash, never verbatim.
                '/{COIN}/api/slash_proposals/{QUERY}/{TYPE}'      : ['getSlashProposals',       ['status', 'pubkey']],
                '/{COIN}/api/slash_proposals'                     : ['getSlashProposals'],
                // Hub operational state (p2p peers, consensus key/value, config oracle, node
                // telemetry). Hub-local, no on-chain action and no hub RPC surface, so served
                // only from the mandatory co-located hub DB (id-keyed).
                '/{COIN}/api/peers/{QUERY}/{TYPE}'                 : ['getPeers',                ['validator']],
                '/{COIN}/api/peers'                               : ['getPeers'],
                '/{COIN}/api/consensus_state/{QUERY}/{TYPE}'       : ['getConsensusState',       ['key']],
                '/{COIN}/api/consensus_state'                     : ['getConsensusState'],
                '/{COIN}/api/configs/{QUERY}/{TYPE}'               : ['getConfigs',              ['coin', 'module']],
                '/{COIN}/api/configs'                             : ['getConfigs'],
                '/{COIN}/api/telemetry_pings/{QUERY}/{TYPE}'       : ['getTelemetryPings',       ['event', 'install', 'country']],
                '/{COIN}/api/telemetry_pings'                     : ['getTelemetryPings'],
                // Cross-chain coordination mirrors (hub-replicated match + local settlement legs)
                '/{COIN}/api/cross_chain_matches/{QUERY}/{TYPE}'     : ['getCrossChainMatches',     ['match', 'block', 'status']],
                '/{COIN}/api/cross_chain_matches'                    : ['getCrossChainMatches'],
                '/{COIN}/api/cross_chain_settlements/{QUERY}/{TYPE}' : ['getCrossChainSettlements', ['match', 'block']],
                '/{COIN}/api/cross_chain_settlements'                : ['getCrossChainSettlements'],
                // Cross-chain calls (XCALL, VM-emitted, read-only). List by block/contract/status; single-call lifecycle by call_id.
                '/{COIN}/api/xcalls/{QUERY}/{TYPE}'                  : ['getXcalls',               ['block', 'contract', 'status']],
                '/{COIN}/api/xcalls'                                 : ['getXcalls'],
                '/{COIN}/api/xcall/{QUERY}'                          : ['getXcall',                'call_id'],
                // Attestation Endpoints (ATTEST v0 requests + v1 responses from the `attests` table)
                '/{COIN}/api/attestations/{QUERY}/{TYPE}'      : ['getAttestations',      ['block', 'address', 'contract']],
                '/{COIN}/api/attestations'                     : ['getAttestations'],
                // The attestation LIFECYCLE composed across its legs. Deliberately not a
                // route onto getAttestationByActionIndex, which is a positional-arg point
                // read the WS ChangeDetector owns; this reuses it internally instead, so
                // that caller's signature stays untouched.
                '/{COIN}/api/attestation/{QUERY}'              : ['getAttestation',       'attestation'],
                // Per-validator per-provider ATTEST accountability counters (fulfilled /
                // missed / slashed + quality score). Indexer-owned, standalone, id-keyed.
                '/{COIN}/api/attest_validator_stats/{QUERY}/{TYPE}' : ['getAttestValidatorStats', ['pubkey', 'provider']],
                '/{COIN}/api/attest_validator_stats'           : ['getAttestValidatorStats'],
                // VOTE governance endpoints (polls = VOTE v0, votes = v1 ballots, poll results
                // = frozen VOTE v2 tally). Poll id IS the creating action_index.
                '/{COIN}/api/polls/{QUERY}/{TYPE}'            : ['getPolls',            ['block', 'tick', 'status', 'source']],
                '/{COIN}/api/polls'                          : ['getPolls'],
                '/{COIN}/api/poll/{QUERY}'                   : ['getPoll',             'poll'],
                '/{COIN}/api/poll/{QUERY}/results'           : ['getPollResults',      'poll'],
                '/{COIN}/api/votes/{QUERY}/{TYPE}'           : ['getVotes',            ['address', 'poll', 'block']],
                '/{COIN}/api/votes'                          : ['getVotes'],
                // BET endpoints (bet_feeds = format 0 markets, bets = format 2 wagers,
                // oracle = per-address track record). The feed id IS the creating
                // action_index, exactly like a poll id.
                '/{COIN}/api/bet_feeds/{QUERY}/{TYPE}'       : ['getBetFeeds',   ['block', 'address', 'source', 'token', 'status']],
                '/{COIN}/api/bet_feeds'                      : ['getBetFeeds'],
                '/{COIN}/api/bet_feed/{QUERY}'               : ['getBetFeed',     'bet_feed'],
                '/{COIN}/api/bets/{QUERY}/{TYPE}'            : ['getBets',       ['block', 'address', 'feed', 'token', 'status']],
                '/{COIN}/api/bets'                           : ['getBets'],
                '/{COIN}/api/oracle/{QUERY}'                 : ['getOracleStats', 'oracle'],
                // ANCHOR checkpoint list (anchor_actions, read-only)
                '/{COIN}/api/anchors/{QUERY}/{TYPE}'           : ['getAnchors',           ['block', 'chain', 'network', 'status']],
                '/{COIN}/api/anchors'                          : ['getAnchors'],
                // One anchor composed with its chunks, covering checkpoint, publisher
                // election and reward-attestation trail. A composition rather than a
                // routing change: the trail spans the mirror schema, not anchor_actions.
                '/{COIN}/api/anchor/{QUERY}'                   : ['getAnchor',            'anchor'],
                // Single checkpoint by block height, WITHOUT re-verification: the
                // detail page's cheap load path. The signature check lives on the
                // dedicated /api/checkpoint/{BLOCK}/verify express route (registered
                // ahead of the catch-all, so the two never collide) because it runs
                // per-call Ed25519 over the whole qualifying validator set.
                '/{COIN}/api/checkpoint/{QUERY}'               : ['getCheckpoint',       'block'],
                // The rest of the checkpoint/ANCHOR family, all read from the co-located
                // mirror schema: the per-block SPV commitments a checkpoint signs over, the
                // quorum-attested publisher rewards an ANCHOR pays, and the historical
                // electorate those signatures verify against.
                '/{COIN}/api/commitments/{QUERY}/{TYPE}'       : ['getCommitments',      ['block']],
                '/{COIN}/api/commitments'                      : ['getCommitments'],
                '/{COIN}/api/anchor_reward_attestations/{QUERY}/{TYPE}' : ['getAnchorRewardAttestations', ['anchor', 'block', 'pubkey']],
                '/{COIN}/api/anchor_reward_attestations'       : ['getAnchorRewardAttestations'],
                '/{COIN}/api/capability_snapshots/{QUERY}/{TYPE}' : ['getCapabilitySnapshots', ['capability', 'block', 'pubkey']],
                '/{COIN}/api/capability_snapshots'             : ['getCapabilitySnapshots'],
                '/{COIN}/api/sends/{QUERY}/{TYPE}'             : ['getSends',            ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/sleeps/{QUERY}/{TYPE}'            : ['getSleeps',           ['block', 'address', 'token']],
                '/{COIN}/api/swaps/{QUERY}/{TYPE}'             : ['getSwaps',            ['block', 'address', 'token']],
                '/{COIN}/api/swap_edits/{QUERY}/{TYPE}'        : ['getSwapEdits',        ['block', 'address']],
                '/{COIN}/api/swap_expires/{QUERY}/{TYPE}'      : ['getSwapExpires',      ['block', 'address']],
                '/{COIN}/api/swap_cancels/{QUERY}/{TYPE}'      : ['getSwapCancels',      ['block', 'address']],
                '/{COIN}/api/swap_matches/{QUERY}/{TYPE}'      : ['getSwapMatches',      ['block']],
                '/{COIN}/api/swap_matches'                     : ['getSwapMatches'],
                '/{COIN}/api/sweeps/{QUERY}/{TYPE}'            : ['getSweeps',           ['block', 'address', 'source', 'destination']],
                '/{COIN}/api/status'                           : ['getStatus'],
                '/{COIN}/api/actions'                          : ['getActions'],
                '/{COIN}/api/action/{QUERY}'                   : ['getAction',           'action_index'],
                '/{COIN}/api/address/{QUERY}'                  : ['getAddress',          'address'],
                '/{COIN}/api/balances/{QUERY}'                 : ['getBalances',         'address'],
                '/{COIN}/api/block/{QUERY}'                    : ['getBlock',            'block'],
                // Public mirrors of internal /explorer feeds (spec explorer-coverage-completion M1.3-M1.5):
                // list-all forms match as bare 3-segment api routes (infoType undefined), QUERY forms mirror
                // the explorer namespace's shapes so third-party consumers get what the UI gets.
                // List-all only. getBlocks appends no block predicate (the type=='block'
                // filter lives in getHistory's branch), so a {QUERY} form would advertise
                // a filter it silently ignores; single blocks have /{COIN}/api/block/{QUERY}.
                '/{COIN}/api/blocks'                           : ['getBlocks'],
                '/{COIN}/api/search/{QUERY}'                   : ['getSearch'],
                // 'contract' is the fifth search category (spec contract-meta-manifest
                // 2.6): a contract found by a word from its declared name or description.
                '/{COIN}/api/search/{QUERY}/{TYPE}'            : ['getSearch',           ['address', 'broadcast', 'contract', 'token', 'transaction']],
                '/{COIN}/api/projects/{QUERY}/{TYPE}'          : ['getProjectTokens',    ['roster']],
                '/{COIN}/api/credits/{QUERY}/{TYPE}'           : ['getCredits',          ['block', 'address']],
                '/{COIN}/api/debits/{QUERY}/{TYPE}'            : ['getDebits',           ['block', 'address']], 
                '/{COIN}/api/escrows/{QUERY}/{TYPE}'           : ['getEscrows',          ['block', 'address']],
                '/{COIN}/api/history/{QUERY}/{TYPE}'           : ['getHistory',          ['block', 'address', 'token', 'recent']],
                '/{COIN}/api/holders/{QUERY}'                  : ['getHolders',          'token'],
                // The client appends the query TYPE to every feed url it builds, so the
                // token page asked for /holders/{TICK}/token and got a 404 while the
                // holder tab sat empty. A holders query is only ever by token, so the
                // segment is redundant, but registering it is how `search` (just above)
                // already handles the same shape. Client-side special-casing would have
                // to be repeated for every caller instead.
                '/{COIN}/api/holders/{QUERY}/{TYPE}'           : ['getHolders',          'token'],
                '/{COIN}/api/mempool'                          : ['getMempool'],
                '/{COIN}/api/mempool/{QUERY}/{TYPE}'           : ['getMempool',          ['address', 'token']],
                '/{COIN}/api/network'                          : ['getNetwork'],   
                '/{COIN}/api/pubkey/{QUERY}'                   : ['getPublicKey',        'address'],
                // Project registry: current roster of a project tick (protocol/project-registry.md)
                '/{COIN}/api/project/{QUERY}'                  : ['getProject',          'token'],
                // M5.1 collectibles: `tokens` filtered to the indivisible + frozen-ceiling
                // classification. Registered on /api only: the gallery is a card grid,
                // not a DataTables list, so it carries no /explorer feed and owes no
                // getPagingDataResults shaping branch.
                '/{COIN}/api/collectibles'                     : ['getCollectibles'],
                '/{COIN}/api/collectibles/{QUERY}/{TYPE}'      : ['getCollectibles',     ['block', 'address']],
                // M5.2 rich list: ONE token's holder ranking plus its supply stats.
                // Per-token by design; there is no cross-token ranking route, because
                // that query has no indexed driving column (see getRichList's header).
                '/{COIN}/api/rich_list/{QUERY}'                : ['getRichList',         'token'],
                '/{COIN}/api/token/{QUERY}'                    : ['getToken',            'token'],
                '/{COIN}/api/tokens/{QUERY}/{TYPE}'            : ['getTokens',           ['block', 'address', 'token', 'subtoken']],
                '/{COIN}/api/transaction/{QUERY}/{TYPE}'       : ['getTransaction',      ['tx_hash', 'tx_index']],
                // Market Endpoints
                '/{COIN}/api/markets'                                  : ['getMarkets'],
                '/{COIN}/api/markets/{TICK1}'                          : ['getMarkets'],
                '/{COIN}/api/market/{TICK1}/{TICK2}'                   : ['getMarket'],
                '/{COIN}/api/market/{TICK1}/{TICK2}/history'           : ['getMarketHistory'],
                '/{COIN}/api/market/{TICK1}/{TICK2}/history/{ADDRESS}' : ['getMarketHistory'],
                '/{COIN}/api/market/{TICK1}/{TICK2}/orders'            : ['getMarketOrders'],
                '/{COIN}/api/market/{TICK1}/{TICK2}/orders/{ADDRESS}'  : ['getMarketOrders'],
                '/{COIN}/api/market/{TICK1}/{TICK2}/orderbook'         : ['getOrderbook']
            }, 
        }
    }
};

module.exports = AS_DECLARED_IN.setupUrls.urls;
