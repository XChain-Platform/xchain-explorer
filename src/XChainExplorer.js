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
 * XChain Explorer - Explorer Class
 * 
 * This file handles starting the explorer, decoding requests, and returning data
 *
 ********************************************************************/

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const dns            = require('dns');
const net            = require('net');
const axios          = require('axios');
const util           = require('./utility.js');
const ssrfGuard      = require('./ssrf-guard.js');
const database       = require('./db.js');
const IconDownloader = require('./IconDownloader.js');
const HubOperationalCache = require('./HubOperationalCache.js');
const HubMirrorSyncManager = require('./HubMirrorSyncManager.js');
const IndexerConnector = require('./XChainIndexerConnector.js');
const eq               = require('./equivocation_header.js');
const swq              = require('./stake_weighted_quorum.js');
const ckpt             = require('./checkpoint_commitment_activation.js');
const ProofServer      = require('./proofServer.js');
const rateLimit        = require('express-rate-limit');
const vmQuery          = require('./vm-query.js');

let slowRequests = 0;

// Lightweight rolling latency reservoir: last 256 request times (ms). The
// window is a power-of-two so the modulo reduces to a bitmask on any engine
// that optimises it. Capped at 256 to keep memory and sort cost negligible
// even at high request rates; large enough for a meaningful p95 reading.
const LATENCY_WINDOW = 256;
const latencyBuf = new Array(LATENCY_WINDOW).fill(0);
let latencyIdx   = 0;   // Next slot to write (circular)
let requestCount = 0;   // Total requests ever served (never resets)

class XChainExplorer {

    constructor(app, configInfo){

        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        this.app = app;

        this.configInfo  = configInfo;

        this.util = new util(this.configInfo);

        this.db   = new database(this);

        // SPV light-client proof server (Phase 3): builds read-only Merkle proofs
        // a client verifies locally against a quorum-signed checkpoint's state_root.
        this.proofServer = new ProofServer(this.db);

        this.urls = this.setupUrls();

        this.headers = {};

        this.response = {
            head: null, // Placeholder for any custom headers
            html: null, // Placeholder for any HTML content
            json: null, // Placeholder for any JSON content
            time: null, // Placeholder for process request timer
            code: 200   // Placeholder for HTTP response code (Default to status OK response)
        };
    }

    async init(){
        await this.db.init()
        // Hub operational-state reads (validator capabilities, governance) over
        // JSON-RPC with a short TTL cache. Disabled (null connector) when no hub
        // endpoint is configured; db.js then falls back to the legacy co-located
        // hub schema read.
        this.hubOperational = new HubOperationalCache(this);
        // Self-synced hub-DB mirror (#4138 decoupling): populates the local
        // checkpoint schema from the hub's snapshot+subscribe feed for every
        // coin/network whose database.checkpoint block sets self_sync. No-op
        // when no self_sync flags are configured.
        this.hubMirrorSync = new HubMirrorSyncManager(this);
        try {
            await this.hubMirrorSync.start();
        } catch (e){
            console.error('hub-mirror sync failed to start:', e && e.stack ? e.stack : e);
        }
        // Optional: in-process icon downloader. Opt-in via configInfo.iconDownload.enabled.
        // Requires sql/icons.sql installed in each indexer DB and ImageMagick `convert` on PATH.
        this.iconDownloader = new IconDownloader(this);
        try {
            await this.iconDownloader.start();
        } catch (e){
            console.error('icon-downloader failed to start:', e && e.stack ? e.stack : e);
        }
    }

    setupUrls(){

        let urls = {

            'static' : [
                'css',
                'fonts',
                'charts',
                'images',
                'json',
                'js'
            ],

            'html' : {
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
                '/{COIN}/contracts'            : 'contracts.html',
                '/{COIN}/contract/{QUERY}'    : 'contract.html',
                '/{COIN}/executions'          : 'executions.html',
                '/{COIN}/deploy_chunks'       : 'deploy_chunks.html',
                '/{COIN}/execution/{QUERY}'   : 'execution.html',
                '/{COIN}/deposits'            : 'deposits.html',
                '/{COIN}/withdrawals'         : 'withdrawals.html',
                '/{COIN}/validators'          : 'validators.html',
                '/{COIN}/stakes'              : 'stakes.html',
                '/{COIN}/contract_stakes'     : 'contract_stakes.html',
                '/{COIN}/prices'              : 'prices.html',
                '/{COIN}/controllers'         : 'controllers.html',
                '/{COIN}/contract_unstakes'   : 'contract_unstakes.html',
                '/{COIN}/anchors'             : 'anchors.html',
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
                '/{COIN}/attestations'        : 'attestations.html',
                '/{COIN}/polls'               : 'polls.html',
                '/{COIN}/votes'               : 'votes.html',
                '/{COIN}/xcalls'              : 'xcalls.html',
                '/{COIN}/sends'               : 'sends.html',
                '/{COIN}/sleeps'              : 'sleeps.html',
                '/{COIN}/swaps'               : 'swaps.html',
                '/{COIN}/swap_matches'        : 'swaps.html',
                '/{COIN}/sweeps'              : 'sweeps.html',
                '/{COIN}'                     : 'coin_home.html',
                '/{COIN}/blocks'              : 'blocks.html',
                '/{COIN}/markets'             : 'markets.html',
                '/{COIN}/search'              : 'search.html',
                '/{COIN}/tokens'              : 'tokens.html',
                '/{COIN}/terms'               : 'terms.html',
                '/{COIN}/mempool'             : 'mempool.html',
                '/{COIN}/address/{QUERY}'     : 'address.html',
                '/{COIN}/action/{QUERY}'      : 'action.html',
                '/{COIN}/block/{QUERY}'       : 'block.html',
                '/{COIN}/dispenser/{QUERY}'   : 'dispenser.html',
                '/{COIN}/market/{QUERY}'      : 'market.html',
                '/{COIN}/token/{QUERY}'       : 'token.html',
                '/{COIN}/transaction/{QUERY}' : 'transaction.html'

            },

            'api' : {
                '/{COIN}/api/addresses/{QUERY}/{TYPE}'         : ['getAddresses',        ['block', 'address']],
                '/{COIN}/api/airdrops/{QUERY}/{TYPE}'          : ['getAirdrops',         ['block', 'address', 'token']],
                '/{COIN}/api/batches/{QUERY}/{TYPE}'           : ['getBatches',          ['block', 'address']],
                '/{COIN}/api/broadcasts/{QUERY}/{TYPE}'        : ['getBroadcasts',       ['block', 'address']],
                '/{COIN}/api/callbacks/{QUERY}/{TYPE}'         : ['getCallbacks',        ['block', 'address', 'token']],
                '/{COIN}/api/destroys/{QUERY}/{TYPE}'          : ['getDestroys',         ['block', 'address', 'token']],
                '/{COIN}/api/dividends/{QUERY}/{TYPE}'         : ['getDividends',        ['block', 'address', 'token']],
                '/{COIN}/api/dispensers/{QUERY}/{TYPE}'        : ['getDispensers',       ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}' : ['getDispenserCancels', ['block', 'address']],
                '/{COIN}/api/dispenser_closes/{QUERY}/{TYPE}'  : ['getDispenserCloses',  ['block', 'address']],
                '/{COIN}/api/dispenser_expires/{QUERY}/{TYPE}' : ['getDispenserExpires', ['block', 'address']],
                '/{COIN}/api/dispenser_edits/{QUERY}/{TYPE}'   : ['getDispenserEdits',   ['block', 'address']],
                '/{COIN}/api/dispenses/{QUERY}/{TYPE}'         : ['getDispenses',        ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/fees/{QUERY}/{TYPE}'              : ['getFees',             ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/files/{QUERY}/{TYPE}'             : ['getFiles',            ['block', 'address', 'token']],
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
                // Controller-bound token / address policy guards (Controller_Bound_Tokens.md): bind/unbind event stream
                '/{COIN}/api/controllers'                     : ['getControllers'],
                // VM / Contract Endpoints
                '/{COIN}/api/contracts/{QUERY}/{TYPE}'         : ['getContracts',        ['block', 'address', 'source']],
                '/{COIN}/api/contracts'                        : ['getContracts'],
                '/{COIN}/api/contract/{QUERY}'                 : ['getContract',          'contract'],
                '/{COIN}/api/contract/{QUERY}/state'           : ['getContractState',     'contract'],
                '/{COIN}/api/contract/{QUERY}/state/{TYPE}'    : ['getContractState',     'contract'],
                '/{COIN}/api/contract/{QUERY}/balance'         : ['getContractBalance',   'contract'],
                '/{COIN}/api/contract/{QUERY}/balance/{TYPE}'  : ['getContractBalance',   'contract'],
                '/{COIN}/api/executions/{QUERY}/{TYPE}'        : ['getExecutions',        ['block', 'address', 'contract']],
                '/{COIN}/api/executions'                       : ['getExecutions'],
                '/{COIN}/api/execution/{QUERY}'                : ['getExecution',          'execution'],
                '/{COIN}/api/deploy_chunks'                    : ['getDeployChunks'],
                '/{COIN}/api/deposits/{QUERY}/{TYPE}'          : ['getDeposits',          ['block', 'address', 'source', 'contract']],
                '/{COIN}/api/withdrawals/{QUERY}/{TYPE}'       : ['getWithdrawals',       ['block', 'address', 'source', 'contract']],
                '/{COIN}/api/stakes/{QUERY}/{TYPE}'            : ['getStakes',            ['block', 'address', 'source']],
                '/{COIN}/api/stakes'                           : ['getStakes'],
                '/{COIN}/api/validators'                       : ['getValidators'],
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
                // VOTE governance endpoints (polls = VOTE v0, votes = v1 ballots, poll results
                // = frozen VOTE v2 tally). Poll id IS the creating action_index.
                '/{COIN}/api/polls/{QUERY}/{TYPE}'            : ['getPolls',            ['block', 'tick', 'status', 'source']],
                '/{COIN}/api/polls'                          : ['getPolls'],
                '/{COIN}/api/poll/{QUERY}'                   : ['getPoll',             'poll'],
                '/{COIN}/api/poll/{QUERY}/results'           : ['getPollResults',      'poll'],
                '/{COIN}/api/votes/{QUERY}/{TYPE}'           : ['getVotes',            ['address', 'poll', 'block']],
                // ANCHOR checkpoint list (anchor_actions, read-only)
                '/{COIN}/api/anchors/{QUERY}/{TYPE}'           : ['getAnchors',           ['block', 'chain', 'network', 'status']],
                '/{COIN}/api/anchors'                          : ['getAnchors'],
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
                '/{COIN}/api/credits/{QUERY}/{TYPE}'           : ['getCredits',          ['block', 'address']],
                '/{COIN}/api/debits/{QUERY}/{TYPE}'            : ['getDebits',           ['block', 'address']], 
                '/{COIN}/api/escrows/{QUERY}/{TYPE}'           : ['getEscrows',          ['block', 'address']],
                '/{COIN}/api/history/{QUERY}/{TYPE}'           : ['getHistory',          ['block', 'address', 'token', 'recent']],
                '/{COIN}/api/holders/{QUERY}'                  : ['getHolders',          'token'],
                '/{COIN}/api/mempool/{QUERY}/{TYPE}'           : ['getMempool',          ['address', 'token']],
                '/{COIN}/api/network'                          : ['getNetwork'],   
                '/{COIN}/api/pubkey/{QUERY}'                   : ['getPublicKey',        'address'],
                // Project registry: current roster of a project tick (protocol/Project_Registry.md)
                '/{COIN}/api/project/{QUERY}'                  : ['getProject',          'token'],
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

            'explorer' : {
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
                '/{COIN}/explorer/dispenses/{QUERY}/{TYPE}'                 : ['getDispenses',    ['block', 'address', 'token']],
                '/{COIN}/explorer/dividends/{QUERY}/{TYPE}'                 : ['getDividends',    ['block', 'address', 'token']], 
                '/{COIN}/explorer/escrows/{QUERY}/{TYPE}'                   : ['getEscrows',      ['block', 'address']],
                '/{COIN}/explorer/fees/{QUERY}/{TYPE}'                      : ['getFees',         ['block', 'address', 'token']],
                '/{COIN}/explorer/files/{QUERY}/{TYPE}'                     : ['getFiles',        ['block', 'address', 'token']],
                '/{COIN}/explorer/holders/{QUERY}'                          : ['getHolders',      'token'],
                '/{COIN}/explorer/history/{QUERY}/{TYPE}'                   : ['getHistory',      ['block', 'address', 'token', 'recent']],
                '/{COIN}/explorer/issues/{QUERY}/{TYPE}'                    : ['getIssues',       ['block', 'address', 'token']],
                '/{COIN}/explorer/links/{QUERY}/{TYPE}'                     : ['getLinks',        ['block', 'address', 'token']],
                '/{COIN}/explorer/lists/{QUERY}/{TYPE}'                     : ['getLists',        ['block', 'address']],
                '/{COIN}/explorer/markets/{QUERY}'                          : ['getMarkets',      'tokens'],
                '/{COIN}/explorer/market/{TICK1}/{TICK2}/history'           : ['getMarketHistory'],
                '/{COIN}/explorer/market/{TICK1}/{TICK2}/history/{ADDRESS}' : ['getMarketHistory'],
                '/{COIN}/explorer/messages/{QUERY}/{TYPE}'                  : ['getMessages',     ['block', 'address']],
                '/{COIN}/explorer/mints/{QUERY}/{TYPE}'                     : ['getMints',        ['block', 'address', 'token']],
                '/{COIN}/explorer/orders/{QUERY}/{TYPE}'                    : ['getOrders',       ['block', 'address', 'token']],
                '/{COIN}/explorer/projects/{QUERY}/{TYPE}'                  : ['getProjectTokens', ['roster']],
                '/{COIN}/explorer/coinpays/{QUERY}/{TYPE}'                  : ['getCoinpays',     ['block', 'address']],
                '/{COIN}/explorer/coinpay_obligations/{QUERY}/{TYPE}'       : ['getCoinpayObligations', ['block', 'address']],
                '/{COIN}/explorer/contracts/{QUERY}/{TYPE}'                  : ['getContracts',    ['block', 'address']],
                '/{COIN}/explorer/executions/{QUERY}/{TYPE}'                 : ['getExecutions',   ['block', 'address', 'contract']],
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
                '/{COIN}/explorer/attestations/{QUERY}/{TYPE}'              : ['getAttestations', ['block', 'address', 'contract']],
                '/{COIN}/explorer/polls/{QUERY}/{TYPE}'                     : ['getPolls',        ['block', 'tick', 'status', 'source']],
                '/{COIN}/explorer/votes/{QUERY}/{TYPE}'                     : ['getVotes',        ['address', 'poll', 'block']],
                '/{COIN}/explorer/xcalls/{QUERY}/{TYPE}'                    : ['getXcalls',       ['block', 'contract', 'status']],
                '/{COIN}/explorer/xcalls/{QUERY}'                           : ['getXcalls',       'block'],
                '/{COIN}/explorer/anchors/{QUERY}/{TYPE}'                   : ['getAnchors',      ['block', 'chain', 'network', 'status']],
                '/{COIN}/explorer/cross_chain_matches/{QUERY}/{TYPE}'       : ['getCrossChainMatches',     ['match', 'block', 'status']],
                '/{COIN}/explorer/cross_chain_settlements/{QUERY}/{TYPE}'   : ['getCrossChainSettlements', ['match', 'block']],
                '/{COIN}/explorer/prices/{QUERY}/{TYPE}'                    : ['getPrices',       ['block', 'address', 'source', 'token']],
                '/{COIN}/explorer/prices'                                   : ['getPrices'],
                '/{COIN}/explorer/controllers'                              : ['getControllers'],
                '/{COIN}/explorer/sends/{QUERY}/{TYPE}'                     : ['getSends',        ['block', 'address', 'token']],
                '/{COIN}/explorer/search/{QUERY}/{TYPE}'                    : ['getSearch',       ['address', 'broadcast', 'token', 'transaction']],
                '/{COIN}/explorer/sleeps/{QUERY}/{TYPE}'                    : ['getSleeps',       ['block', 'address', 'token']],
                '/{COIN}/explorer/swaps/{QUERY}/{TYPE}'                     : ['getSwaps',        ['block', 'address', 'token']],
                '/{COIN}/explorer/sweeps/{QUERY}/{TYPE}'                    : ['getSweeps',       ['block', 'address']],
                '/{COIN}/explorer/tokens/{QUERY}/{TYPE}'                    : ['getTokens',       ['block', 'address', 'token', 'subtoken']]
            }
        };

        this.app.use('/icon', (req, res) => { this.processIconRequest(req, res); });
        this.app.use('/relay', (req, res) => { this.processRelayRequest(req, res); });

        // Machine-readable API spec (OpenAPI 3.1). Regenerated by docs/openapi.build.js;
        // test/unit/openapi-coverage.test.js keeps it in lockstep with the urls tables above.
        this.app.get('/openapi.json', (req, res) => {
            if(!this.openapiSpec)
                this.openapiSpec = fs.readFileSync(path.join(__dirname, '../docs/openapi.json'));
            res.set('Cache-Control', 'public, max-age=3600');
            res.type('application/json').send(this.openapiSpec);
        });

        for(let directory of urls['static'])
            this.app.use('/' + directory, express.static(path.join(__dirname, 'content', directory)))

        // Raw bytes for a FILE action. Gated files return their ciphertext as
        // application/octet-stream (holders decrypt client-side; see
        // xchain-documentation/protocol/TOKEN_GATED_CONTENT.md); non-gated files
        // return the stored bytes from the colocated decoder DB, served inline
        // only for safe media MIME types (this is how TIS `data_ref` entries
        // resolve for NFT display; see protocol/NFT_Standard.md).
        // Registered before the wildcard so the express route matcher hits this first.
        this.app.get('/:coin/api/file/:actionIndex/raw', (req, res) => { this.processFileRawRequest(req, res); });

        // Native-coin fee pre-flight + schedule. Thin proxies to the colocated indexer's
        // read-only feequote/feeschedule JSON-RPC, so the authoritative fee + oracle-price logic
        // stays single-sourced there. Registered before the wildcard so the matcher hits these
        // first. See xchain-documentation/concepts/GAS.md (client pre-validation).
        this.app.get('/:coin/api/feequote',    (req, res) => { this.processFeeQuoteRequest(req, res); });
        this.app.get('/:coin/api/feeschedule', (req, res) => { this.processFeeScheduleRequest(req, res); });

        // Quorum-signed state checkpoints (the light-client verification surface).
        // /checkpoints lists the latest signed checkpoints for the coin's chain;
        // /checkpoint/:blockIndex/verify re-verifies the 2f+1 oracle_publish
        // signatures server-side AND returns everything a client needs to verify
        // independently (canonical string, sigs, qualifying validator set).
        // Spec: xchain-documentation/protocol/actions/ANCHOR.md
        this.app.get('/:coin/api/checkpoints', (req, res) => { this.processCheckpointsRequest(req, res); });
        this.app.get('/:coin/api/checkpoint/:blockIndex/verify', (req, res) => { this.processCheckpointVerifyRequest(req, res); });
        // Self-synced hub-mirror observability (#4138 decoupling): bootstrap +
        // watermark-lag state per coin, {enabled:false} in externally-maintained mode.
        this.app.get('/:coin/api/hub-mirror/status', (req, res) => { this.processHubMirrorStatusRequest(req, res); });

        // SPV light-client proof endpoints (Phase 3, spec §8.1). Read-only; a client
        // recomputes the proof locally and binds it to a quorum-signed checkpoint's
        // committed state_root (never trusting this server's word). The balance proof
        // + checkpoint range are live; action / validator-set / contract-state are
        // reserved (501) pending their design dependencies (see the handlers).
        // Merkle-proof recompute is CPU-bound per request (hashes every leaf in
        // the target block), so cap it per-IP well below the platform-wide
        // 500rpm default, mirroring the VM-call limiter's design.
        const actionProofLimiter = rateLimit({
            windowMs:        60 * 1000,
            limit:           parseInt(process.env.EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM, 10) || 60,
            standardHeaders: true,
            legacyHeaders:   false,
            message:         { error: 'Too many proof requests', code: 'RATE_LIMITED' }
        });
        this.app.get('/:coin/api/proof/balance/:address/:tick', (req, res) => { this.processBalanceProofRequest(req, res); });
        this.app.get('/:coin/api/checkpoints/range', (req, res) => { this.processCheckpointsRangeRequest(req, res); });
        this.app.get('/:coin/api/proof/action/:actionIndex', actionProofLimiter, (req, res) => { this.processActionProofRequest(req, res); });
        this.app.get('/:coin/api/proof/validator-set', (req, res) => { this.processValidatorSetProofRequest(req, res); });
        this.app.get('/:coin/api/proof/contract-state/:contractIndex/:key', (req, res) => { this.processContractStateProofRequest(req, res); });

        // Read-only contract simulation (the platform's eth_call): runs a
        // method in a sandboxed xchain-vm against current state and discards
        // all effects. Default-off (EXPLORER_VM_QUERY_ENABLED) and rate-limited
        // far below the global cap because every call burns real CPU in the VM
        // subprocess.
        const vmQueryLimiter = rateLimit({
            windowMs:        60 * 1000,
            limit:           parseInt(process.env.EXPLORER_VM_QUERY_RATE_LIMIT_RPM, 10) || 20,
            standardHeaders: true,
            legacyHeaders:   false,
            message:         { error: 'Too many simulation requests', code: 'RATE_LIMITED' }
        });
        this.app.post('/:coin/api/contract/:contractIndex/call', vmQueryLimiter, (req, res) => { this.processContractCallRequest(req, res); });

        // Catch-all. Express 5 / path-to-regexp v8 rejects a bare '*' at startup.
        // The wildcard must be braced ('/{*path}') to also match the bare root '/':
        // unbraced '/*path' requires at least one trailing segment, so '/' fell through
        // to the JSON-RPC router and returned a -32600 error instead of the coin index.
        this.app.get('/{*path}', (req, res) => { this.processRequest(req, res).catch(err => this._sendUnhandled(err, req, res)); });

        return urls;
    }

    // Last-resort handler for a rejected processRequest promise. The catch-all
    // route handler is fire-and-forget, so without this a throw anywhere in
    // processRequest OUTSIDE its narrow db.getData try/catch (e.g. a hostile
    // ?total= reaching bcsub, or a jsonStringify throw at the send sink) would
    // surface as an unhandled rejection and terminate the process (Node default
    // --unhandled-rejections=throw), a single-request DoS. Degrade to a 500
    // instead. Kept minimal so it cannot itself throw.
    _sendUnhandled(err, req, res){
        try {
            console.error('processRequest unhandled error for', req && req.path, '-', (err && err.message) ? err.message : err);
            if(res && !res.headersSent)
                res.status(500).type('json').send('{"error":"An unexpected error occurred while serving this request.","code":"INTERNAL_ERROR"}');
        } catch(_){ /* nothing more we can safely do */ }
    }

    async processRequest(req, res){
        let config = await this.configInfo.getConfig()

        let response = structuredClone(this.response);

        let debugTimer = this.util.startTimer();

        let total = null;
        let data  = null;
        // Set when a data read genuinely FAILED (db.js now throws a DbQueryError
        // on outage/rejected query instead of swallowing it into an empty set,
        // M-4). Suppresses the empty-result assembly and the NOT_FOUND fallback
        // so the response stays a 5xx rather than a misleading empty 200 / 404.
        let dbError = false;

        let cfg = {
            coin: null, // COIN type (BTC, LTC, DOGE)
            type: null, // Request type (html, api, explorer)
            file: null, // File content to return
            data: {
                method: null, // Method to run to get data
                search: null, // Search to pass to method
                type:   null, // Search type to pass to method
                path:   req.path,  // Request URL path
                query:  req.query, // Request Query string parameters
                // SQL query specific information
                sql: {
                    order:  null, // Sort order (ASC, DESC)
                    limit:  null, // Record Limit (LIMIT X)
                    where: {
                        data:       '', // Where data SQL
                        offset:     '', // Where offset SQL
                        offsetArgs: []  // Parameterized offset args
                    }
                },
                // Offset used by explorer for paging (action: first/last/next/prev)
                offset: {
                    action: null, // Action (first, last, next, prev)
                    start:  null, // start value (action_index, etc)
                    stop:   null, // stop value (action_index, etc)
                }
            },
        };

        let urlPath = String(req.path).substring(1).replace(/\/$/,'').split('/');

        urlPath.forEach(function(value, idx){
            if(String(value).toLowerCase()=='null')
                urlPath[idx] = null;
        });

        let coin = String(urlPath[0]).toUpperCase();
        if(!this.util.isNull(config['COIN_SUPPORTED'][coin]))
            cfg.coin = coin;

        let type = String(urlPath[1]).toLowerCase();
        cfg.type = (['api','explorer'].includes(type) && urlPath.length>2) ? type : 'html';

        let requestPath = req.path;

        // validDataRequest is false when the coin is supported but not yet configured in this instance
        let validDataRequest = (!this.util.isNull(config['COIN_SUPPORTED'][coin]) && !this.util.isNull(config['COIN_AVAILABLE'][coin])) ? true : false;

        // Force /{COIN}/api/status valid so we always return explorer config for that coin
        if(String(urlPath[1]).toLowerCase()=='api' && String(urlPath[2]).toLowerCase()=='status')
            validDataRequest = true;

        // If the COIN is supported but not available, return the 'COIN Unavailable' page
        if(!this.util.isNull(config['COIN_SUPPORTED'][coin]) && this.util.isNull(config['COIN_AVAILABLE'][coin]))
            requestPath = '/coin-unavailable';

        // Set type / file / info config info using url matching
        for(const url in this.urls[cfg.type]){
            let parts      = String(url).substring(1).split('/');
            let match      = false;
            let info       = this.urls[cfg.type][url];
            let searchType = false;

            if(cfg.type=='html'){
                if(String(requestPath).toLowerCase()==String(url).toLowerCase())
                    match = true;
                if(parts.length==1 && urlPath.length==1 && parts[0]=='{COIN}' && !this.util.isNull(cfg.coin))
                    match = true;
                if(parts.length > 1 && parts[1]==String(urlPath[1]).toLowerCase())
                    match = true;
            }

            if(!match && !this.util.isNull(parts[2]) && parts[2].includes('market') && String(urlPath[2]).toLowerCase().includes('market')){
                if(!this.util.isNull(urlPath[3]))
                    searchType = 'token';
                if(String(urlPath[2]).toLowerCase()=='markets'){
                    match = true;
                } else if(String(urlPath[2]).toLowerCase()=='market'){
                    if(!this.util.isNull(parts[3]) && !this.util.isNull(parts[4]) && !this.util.isNull(urlPath[3]) && !this.util.isNull(urlPath[4])){
                        if(this.util.isNull(parts[5])){
                            if(this.util.isNull(urlPath[5]))
                                match = true;
                        } else {
                            if(parts[5]==String(urlPath[5]).toLowerCase())
                                match = true;

                        }
                    }
                }
                if(match){
                    cfg.data.search2 = urlPath[4];
                    cfg.data.search3 = urlPath[6];
                }
            // Handle action matches. Require the route's segment count to match the
            // request path so a shorter route can't swallow a deeper one, e.g.
            // /contract/{QUERY} must NOT match /contract/{QUERY}/state (which would
            // otherwise make the /state and /state/{TYPE} routes unreachable).
            // The 5th-segment literal must also match when the route declares one
            // (e.g. .../state vs .../balance); without this, two same-length routes
            // sharing parts[1]/parts[2] are indistinguishable and the first-defined
            // one wins, shadowing the other (the /balance route was unreachable).
            } else if(!match && parts.length==urlPath.length && parts[1]==String(urlPath[1]).toLowerCase() &&
                parts[2]==String(urlPath[2]).toLowerCase() &&
                (this.util.isNull(parts[4]) || String(parts[4]).startsWith('{') || String(parts[4]).toLowerCase()==String(urlPath[4]).toLowerCase())){
                if(cfg.type=='explorer' && urlPath.length==3)
                    match = true;
                if(!match){
                    let infoType = typeof info[1];
                    let search = String(urlPath[4]).toLowerCase();
                    if(infoType=='string')
                        searchType = info[1];
                    if(infoType=='object' && info[1].includes(search))
                        searchType = search;
                    if(searchType || infoType=='undefined')
                        match = true;
                }
            }

            // List-all explorer requests (the home-page tabs) carry no QUERY/TYPE, so the
            // request path is exactly 3 segments (/{COIN}/explorer/{ACTION}) while the route
            // declares optional {QUERY}/{TYPE} placeholders and is longer. The length-equality
            // gate above rejects that pairing, so match it here: action segment lines up and
            // every remaining route segment is a placeholder. Limited to 3-segment paths, so it
            // can't swallow a deeper route (the shadowing case the length check guards against).
            if(!match && cfg.type=='explorer' && urlPath.length==3 &&
                parts[1]==String(urlPath[1]).toLowerCase() &&
                parts[2]==String(urlPath[2]).toLowerCase() &&
                parts.slice(3).every(p => String(p).startsWith('{'))){
                match = true;
            }

            if(match){
                if(cfg.type=='html')
                    cfg.file = info;
                if(['api','explorer'].includes(cfg.type)){
                    cfg.data.method = info[0];
                    cfg.data.search = urlPath[3];
                    cfg.data.type   = searchType;
                    if(cfg.type=='explorer'){
                        let q      = (req.query) ? req.query : false;
                        let offset = (q && !this.util.isNull(q.offset)) ? q.offset : false;
                        let action = (q && !this.util.isNull(q.action)) ? q.action : false;
                        cfg.data.offset.start  = offset;
                        cfg.data.offset.action = action;
                    }
                }
                break;
            }
        }

        if(!this.util.isNull(cfg.data.method) && validDataRequest){
            // Short token/subtoken search terms force a leading-% LIKE filesort over the
            // whole tokens table (no B-tree path) on every unauthenticated request. Return
            // an empty result before touching the DB, mirroring getSearch's SEARCH_MIN_LENGTH
            // guard.
            const TOKEN_SEARCH_MIN_LENGTH = 3;
            // Cross-chain match rows come from the checkpoint mirror; when a
            // SELF-SYNCED mirror has never bootstrapped, refuse to serve (an
            // empty mirror must read as an outage, not an empty ledger), and
            // otherwise annotate lag. Same gate as the checkpoint routes.
            let mirrorGate = (cfg.data.method === 'getCrossChainMatches') ? this._mirrorGate(cfg.coin) : null;
            if(mirrorGate && mirrorGate.blocked){
                data  = [];
                total = 0;
            } else if(cfg.data.method === 'getTokens' &&
               ['token','subtoken'].includes(cfg.data.type) &&
               String(cfg.data.search || '').trim().length < TOKEN_SEARCH_MIN_LENGTH){
                data  = [];
                total = 0;
            } else {
                try {
                    [data, total] = await this.db.getData(cfg);
                } catch(e){
                    // A read that genuinely failed (DB outage / rejected query)
                    // throws (db.js DbQueryError, M-4); answer 5xx instead of a
                    // misleading empty 200. A successful empty SELECT does not
                    // throw and still returns 200 with total:0.
                    console.error('processRequest: data query failed for', req.path, '-', (e && e.message ? e.message : e));
                    dbError       = true;
                    response.code = 500;
                    response.json = { error: 'A database error occurred while serving this request.', code: 'DB_ERROR' };
                }
            }

            if(!dbError){
            let json = {};

            if(this.util.isNumeric(total)){
                if(cfg.type=='api'){
                    json.total = total;

                    // Hoist shared fields out of the data array to avoid repeating identical values per row.
                    // Guard against empty data (e.g. unknown tick): data[0] is undefined when
                    // getHolders short-circuits for a nonexistent token.
                    if(cfg.data.method=='getHolders' && data && data.length > 0){
                        let info = data[0];
                        json.tick       = info.tick;
                        json.supply     = info.supply;
                        json.decimals   = info.decimals;
                        json.coin_price = info.coin_price;
                    }
                }
                // DataTables server-side format (https://datatables.net/manual/server-side#Returned-data)
                if(cfg.type=='explorer'){
                    // DataTables sends back the server's own recordsTotal as ?total= to
                    // avoid a re-count on paging. Validate it: total flows into
                    // getPagingDataResults -> bcsub (mathjs), so an unvalidated non-numeric
                    // override (e.g. ?total=abc) threw a DecimalError outside any try/catch
                    // and crashed the process. Ignore a non-numeric override and keep the
                    // real DB count. Mirrors the isInteger/Number guards on start/limit/length.
                    if(cfg.data.query.total && this.util.isNumeric(cfg.data.query.total))
                        total = Number(cfg.data.query.total)
                    json.recordsTotal    = total;
                    json.recordsFiltered = total;
                }
                json.data  = this.getPagingDataResults(cfg, data, total);
            } else {
                json = data;
            }

            if(cfg.data.method=='getBalances')
                json.address = cfg.data.search;
            if(cfg.data.method=='getSearch'){
                delete data.data;
                json = Object.assign({}, json, data);
            }

            if(cfg.type=='api' && !this.util.isNull(json)){
                json = this.util.ksort(json);
                for(let idx in json.data)
                    json.data[idx] = this.util.ksort(json.data[idx]);
            }

            response.json = json;

            if(mirrorGate){
                if(mirrorGate.blocked){
                    response.code = 503;
                    response.json = this._mirrorBlockedBody(mirrorGate.blocked);
                } else if(mirrorGate.annotate){
                    Object.assign(response.json, mirrorGate.annotate);
                }
            }
            }
        }

        if(this.util.isNull(cfg.file) && this.util.isNull(cfg.data.method)){
            cfg.file = '404.html';
            cfg.type = 'html';
            response.code = 404;
        }

        if(['api','explorer'].includes(cfg.type) && !this.util.isNull(cfg.data.method) && !validDataRequest){
            response.code = 503;
            response.json = {
                error: 'Explorer not configured to support data requests for this coin.',
                code: 'COIN_NOT_AVAILABLE'
            };
        }

        // No record for a single-resource lookup: return 404 so the HTTP status agrees
        // with the body's NOT_FOUND code and matches the hand-registered routes elsewhere
        // in this service (e.g. :1071, :1133). A 400 made consumers that branch on status
        // (including xchain-sdk) treat "does not exist" as a malformed request. Empty list
        // queries are unaffected (they return 200 with total:0).
        else if(!dbError && ['api','explorer'].includes(cfg.type) && this.util.isNull(data) && this.util.isNull(total)){
            response.code = 404;
            response.json = {
                error: 'The requested resource was not found.',
                code: 'NOT_FOUND'
            };
        }

        if(cfg.type=='html'){
            let htmlDirectory   = path.join(__dirname, 'content/html/')

            let templateFile    = path.join(htmlDirectory, 'template.html');
            let templateExists  = await this.util.fileExists(templateFile);
            let templateContent = (templateExists) ? await this.util.fileGetContents(templateFile) : 'Error loading template file!';

            let htmlFile    = path.join(htmlDirectory, cfg.file);
            let htmlExists  = await this.util.fileExists(htmlFile);
            let htmlContent = (htmlExists) ? await this.util.fileGetContents(htmlFile) : 'Error loading html file!';

            let pageContent = templateContent;
            // Use a replacement FUNCTION, not the raw string: String.replace treats $-sequences
            // ($&, $', $`, $1) specially in a string replacement, so any page content containing
            // them (e.g. a "$" in inline JS or a token description) would be mangled or truncated.
            pageContent     = pageContent.replace('{CONTENT}', () => htmlContent);

            response.html = pageContent;
        }

        response.time = this.util.getTimer(debugTimer);

        if(response.json)
            response.json.runtime = this.util.getTimerString(response.time);

        response.head = structuredClone(this.headers);

        if(process.env.DEBUG && !this.util.isNull(response.time))
            response.head['XChain-Runtime-Ms'] = response.time;

        if(!this.util.isNull(response.head))
            res.set(response.head);

        res.status(response.code);

        if(!this.util.isNull(response.json)){
            res.type('json').send(this.util.jsonStringify(response.json));
        } else if(!this.util.isNull(response.html)){
            res.send(response.html);
        } else {
            res.send('response of last resort...');
        }

        if(!this.util.isNull(response.time)){
            // Record this request's latency in the circular buffer so p95 and a
            // total served count are available from ping(). The buffer size is
            // fixed (LATENCY_WINDOW) so memory stays constant at steady state.
            latencyBuf[latencyIdx % LATENCY_WINDOW] = response.time;
            latencyIdx++;
            requestCount++;
        }

        if(response.time > 400){
            slowRequests++;
            console.warn('SLOW_REQUEST', req.path, response.time + 'ms');
        }

        if(process.env.DEBUG){
            console.log('--- REQUEST CONFIG ---');
            console.dir(cfg, {
                colors: true,
                depth: 3
            });
        }
    }

    getPagingDataResults(config, data, total){
        let cfg    = config;
        let type   = cfg.type;
        let max    = this.db.getMaxMethodResults(cfg.data.method);
        let q      = (cfg.data && cfg.data.query) ? cfg.data.query : false;
        let start  = (q && q.start  && this.util.isInteger(Number(q.start)))  ? q.start  : 0;
        let limit  = (q && q.limit  && this.util.isInteger(Number(q.limit)))  ? q.limit  : max;
        let length = (q && q.length && this.util.isInteger(Number(q.length))) ? q.length : 10;
        let offset = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.start))  ? cfg.data.offset.start  : false;
        let action = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.action)) ? cfg.data.offset.action : false;
        let method = cfg.data.method;
        // Cursor-paged list views (anchor_actions, slash_events, the hub mirrors, etc.) carry
        // no server-computed boundary on a jump-to-last: their main query already returns the
        // exact final page (ORDER BY <cursor> ASC LIMIT n), so there is no `offset` to satisfy
        // the keep test below. The `cnt > start` window test then drops every row (cnt is
        // 1-based within the single returned page, never exceeding `start`). Keep all rows in
        // that case, mirroring how the `|| offset` branch keeps a cursor-windowed page.
        let cursorLast = (action=='last') && (this.db.cursorPagedMethods || []).includes(method);

        // Clamp pagination values to safe ranges
        start  = Math.max(0, Number(start));
        limit  = Math.max(1, Math.min(Number(limit), max));
        length = Math.max(1, Number(length));

        if(method=='getSearch')
            data = data.data;

        // SQL OFFSET already handled pagination for API requests; return all rows
        if(cfg.type=='api'){
            start = 0;
        }
        if(cfg.type=='explorer'){
            // Limit results to 100 max (except in special cases where we can not use an offset)
            if(length > 100 && !['getHolders','getBalances','getCredits','getDebits'].includes(cfg.data.method))
                length = 100;
            limit = this.util.bcadd(start, length);
        }

        // Placeholder for the results we will actually show
        let show          = [];
        let cnt           = (offset) ? start : 0;
        let count         = 0;
        let count_reverse = 0;

        // Loop through data and determine what to return to use
        for(let idx in data){
            cnt++;
            idx++;

            // Keep track of display count separate from actual count
            count = cnt;

            if(['prev','last'].includes(action))
                count = this.util.bcadd(start,this.util.bcsub(data.length, this.util.bcsub(idx, 1)),0);

            // Reverse-count: total minus (count-1), used because latest is first in most cases
            count_reverse = this.util.bcsub(total,this.util.bcsub(count, 1),0);

            if((cnt > start && cnt <= limit) || offset || cursorLast){
                let info   = data[idx-1];
                if(type=='api'){
                    // Holders: hoist token-level fields to top; pass only address+amount per row
                    if(method=='getHolders'){
                        info = {
                            'address': info.address,
                            'amount':  info.amount
                        };
                    }
                }
                if(type=='explorer'){
                    let status = (info.status=='valid') ? 1 : 0; // 1=valid, 2=invalid
                    let percent = 0;                             // Percentage of total supply
                    let value   = 0;                             // Estimated value
                    let amount  = 0;                             // Amount formatted to correct decimal precision

                    let locks = false;
                    if(['getIssues','getTokens','getProjectTokens'].includes(method)){
                        let arr = [
                            info.lock_max_supply,
                            info.lock_mint,
                            info.lock_mint_supply,
                            info.lock_max_mint,
                            info.lock_description,
                            info.lock_sleep,
                            info.lock_callback
                        ];
                        locks = arr.join('|');
                    }

                    let actions = false;
                    if(method=='getBlocks'){
                        let arr = [
                            info.actions.addresses,
                            info.actions.airdrops,
                            info.actions.batches,
                            info.actions.broadcasts,
                            info.actions.callbacks,
                            info.actions.destroys,
                            info.actions.dispensers,
                            info.actions.dispenses,
                            info.actions.dividends,
                            info.actions.files,
                            info.actions.issues,
                            info.actions.links,
                            info.actions.lists,
                            info.actions.messages,
                            info.actions.mints,
                            info.actions.orders,
                            info.actions.order_cancels,
                            info.actions.order_edits,
                            info.actions.order_matches,
                            info.actions.sends,
                            info.actions.sleeps,
                            info.actions.swaps,
                            info.actions.swap_cancels,
                            info.actions.swap_edits,
                            info.actions.swap_matches,
                            info.actions.sweep
                        ];
                        actions = arr.join('|');
                    }

                    if(['getBalances','getHolders'].includes(method)){
                        amount  = String(this.util.bcformat(info.amount, info.decimals));
                        percent = String(this.util.bcmul(this.util.bcdiv(info.amount,info.supply, 8), 100, 8));
                        value   = String(this.util.bcmul(info.amount, info.coin_price, 8));
                    }
                    // Build out the correct response array based on method type
                    if(method=='getAddresses')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.fee_preference, info.require_memo, info.dispenser_preference, status, info.action_index];
                    if(method=='getAirdrops')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
                    if(method=='getBalances')
                        info = [count, info.tick, amount, percent, value, null];
                    if(method=='getBatches')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, status, info.action_index];
                    if(method=='getBlocks')
                        info = [info.block_index, info.timestamp, actions, info.block_index];
                    if(method=='getBroadcasts')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.message, info.value, info.fee, status, info.action_index];
                    if(method=='getCallbacks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.callback_tick, info.callback_amount, status, info.action_index];
                    if(['getCredits','getDebits','getEscrows'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.address, info.tick, info.amount, info.action, info.action_index];
                    if(method=='getDestroys')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
                    if(method=='getDispensers')
                        // give_ownership sits BEFORE status/action_index so action_index stays LAST
                        // and status second-to-last (the client's length-relative extraction + paging cursor).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, info.give_ownership, status, info.action_index];
                    if(method=='getDispenses')
                        info = [count_reverse, info.block_index, info.timestamp, info.destination, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, status, info.action_index];
                    if(method=='getDividends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.dividend_tick, info.amount, status, info.action_index];
                    if(method=='getFees')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.method, info.action, info.action_index];
                    if(method=='getFiles')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.name, info.type, info.title, info.gate_ticker, status, info.action_index];
                    if(method=='getPrices')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.coin, info.tick, info.fiat, info.value, info.fee, status, info.action_index];
                    if(method=='getControllers')
                        info = [count_reverse, info.block_index, info.timestamp, info.scope, info.subject, info.action_class, info.contract_index, info.is_unbind, info.cooldown_blocks, info.cooldown_end_block, status, info.action_index];
                    if(method=='getDeployChunks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.code_hash, info.chunk_index, info.total_chunks, status, info.action_index];
                    if(method=='getHistory')
                        info = [count_reverse, info.block_index, info.timestamp, info.action, info.details, status, info.action_index];
                    if(method=='getHolders')
                        info = [count, info.address, amount, percent, value, null];
                    // transfer (ownership-transfer destination, null for plain issues)
                    // sits BEFORE status/action_index so the client's length-relative
                    // status + paging-offset extraction keeps working
                    if(method=='getIssues')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.max_supply, info.max_mint, locks, info.transfer, status, info.action_index];
                    if(method=='getLinks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.coin1, info.coin1_action_index, info.coin2, info.coin2_action_index, info.memo, status, info.action_index];
                    if(method=='getLists')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.edit, status, info.action_index];
                    if(method=='getMarkets')
                        info = [count_reverse, info.tick1, info.tick2, info.tick1_price, info.tick1_ask, info.tick1_bid, info.tick2_24hr_volume, info.tick1_24hr_change, info.id];
                    if(method=='getMarketHistory')
                        info = [count_reverse, info.block_index, info.timestamp, info.type, info.price, info.amount, null, info.action_index];
                    if(method=='getMessages')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.plaintext_message, info.encrypted_message, status, info.action_index];
                    if(method=='getMints')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, status, info.action_index];
                    if(method=='getOrders')
                        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
                    if(method=='getSends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
                    if(method=='getSleeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.tick, info.resume_block, status, info.action_index];
                    if(method=='getSwaps')
                        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
                    if(method=='getSweeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.balances, info.ownerships, info.orders, info.swaps, info.dispensers, status, info.action_index];
                    // NOTE: decimals sits BEFORE the trailing id; the datatables client
                    // uses the LAST element of each row for offset paging (offset_first/
                    // offset_last), so new fields must never displace it. decimals +
                    // locks (lock_max_supply) let the client badge NFT-pattern tokens.
                    if(['getTokens','getProjectTokens'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.tick, info.supply, info.max_supply, info.max_mint, locks, info.decimals, info.id];
                    // VM / Contract list pages
                    if(method=='getContracts')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.code_hash, info.api_version, info.cooldown_blocks, info.slash_destination, status, info.action_index];
                    if(method=='getExecutions')
                        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.caller, info.method_name, info.gas_used, status, info.action_index];
                    if(['getDeposits','getWithdrawals'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.contract_index, info.tick, info.amount, status, info.action_index];
                    // Capability staking list pages. The raw stakes page keeps action_index LAST
                    // (paging cursor); validators carry activation/deactivation tails for the active-set
                    // view (small set, single page) and are shaped separately.
                    if(method=='getStakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, status, info.action_index];
                    if(method=='getValidators')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, status, info.action_index, info.activation_block, info.deactivation_block];
                    if(method=='getDelegations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, status, info.action_index];
                    if(method=='getValidatorRewards')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.reward_type, info.amount, info.id];
                    // Full-node possession-proof verdict list page. action_index stays LAST
                    // (the datatables client uses it as the paging offset cursor).
                    if(method=='getFullNodeVerifications')
                        info = [count_reverse, info.block_index, info.timestamp, info.signing_pubkey, info.staking_source, info.epoch_height, info.target_height, info.challenge_id, info.passed, info.action_index];
                    // Contract-targeted staking list pages
                    if(method=='getContractStakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.version, status, info.action_index];
                    if(method=='getContractUnstakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.cooldown_end_block, status, info.action_index];
                    if(method=='getSlashEvents')
                        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.target_contract_index, info.tick, info.amount, info.destination, info.execution_index];
                    // Capability staking lifecycle list pages. action_index stays LAST (paging cursor).
                    if(method=='getCollects')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.amount, status, info.action_index];
                    if(method=='getUnstakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.amount, info.cooldown_end_block, status, info.action_index];
                    if(method=='getStakeKeyRevocations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.deactivation_block, status, info.action_index];
                    // Capability equivocation slashes. No own action_index; id is the paging cursor
                    // (LAST), slash_action_index links the view to the SLASH wire action.
                    if(method=='getCapabilitySlashEvents')
                        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.capability, info.amount, info.submitter, info.slash_action_index, info.id];
                    // User token/fiat oracle rows (hub-mirrored, cross-chain). id is the paging cursor
                    // (LAST); block_time + source_chain replace the block/time columns (no local block).
                    if(method=='getOraclePrices')
                        info = [count_reverse, info.block_time, info.source_chain, info.source_address, info.tick, info.fiat, info.value, info.id];
                    // Attestation list page
                    if(method=='getAttestations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.provider_id, info.request_id, info.request_status, info.response_status, status, info.action_index, info.payload, info.callback_params_json, info.fee_payer];
                    // VOTE poll list page. poll_status (lifecycle enum), end_block (close
                    // height) and callback_contract_index (non-null = binding poll: the
                    // result fires a contract method) are rendered columns; status (0/1
                    // action validity) + action_index stay LAST for the client's generic
                    // row-color + paging-cursor extraction (data[len-2]/data[len-1]).
                    if(method=='getPolls')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.question, info.poll_status, info.end_block, info.callback_contract_index, status, info.action_index];
                    // VOTE ballot list page. One row per (poll, voter, chosen option); the voter
                    // is the source. action_index stays LAST (paging cursor; links the ballot action).
                    if(method=='getVotes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.poll_index, info.choice, info.share, status, info.action_index];
                    // XCALL cross-chain call list page (source request rows). action_index stays
                    // LAST (the datatables client uses it as the paging offset cursor).
                    if(method=='getXcalls')
                        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.target_chain, info.target_contract_index, info.method, info.request_status, status, info.action_index];
                    // ANCHOR checkpoint list page. action_index stays LAST (paging cursor).
                    if(method=='getAnchors')
                        info = [count_reverse, info.block_index, info.timestamp, info.chain, info.network, info.version, info.checkpoint_seq, info.snapshot_block, info.match_count, status, info.action_index];
                    // Cross-chain DEX match (hub-mirrored, id-keyed). id is the paging cursor (LAST);
                    // snapshot_block is the BTC-anchored quorum block. No status coloring (status is a
                    // word, not 0/1); the render badges it instead.
                    if(method=='getCrossChainMatches')
                        info = [count_reverse, info.snapshot_block, info.network, info.match_id, info.a_chain, info.a_tick, info.a_amount, info.b_chain, info.b_tick, info.b_amount, info.status, info.id];
                    // Cross-chain settlement leg (local action-chain row; no status column). action_index
                    // is the paging cursor (LAST) and links the local settlement action.
                    if(method=='getCrossChainSettlements')
                        info = [count_reverse, info.block_index, info.timestamp, info.match_id, info.local_action_index, info.action_index];
                    // Hub capability + governance rows (read from the co-located hub DB, id-keyed).
                    // id is the paging cursor (LAST); status/vote are enum words (no 0/1 coloring,
                    // so these methods sit in the no-color list client-side).
                    if(method=='getValidatorCapabilities')
                        info = [count_reverse, info.updated_at, info.signing_pubkey, info.capability, info.qualified, info.self_test_ok, info.enabled, info.qualified_at_block, info.id];
                    if(method=='getGovernanceProposals')
                        info = [count_reverse, info.proposal_id, info.parameter, info.current_value, info.proposed_value, info.status, info.voting_end, info.activation_block, info.proposer_pubkey, info.id];
                    if(method=='getGovernanceVotes')
                        info = [count_reverse, info.created_at, info.proposal_id, info.voter_pubkey, info.vote, info.id];
                    if(method=='getSearch'){
                        if(cfg.data.type=='address')
                            info = [count, info.address, null];
                        if(cfg.data.type=='broadcast')
                            info = [count, info.message, info.memo, info.action_index];
                        if(cfg.data.type=='token')
                            info = [count, info.tick, info.description, null];
                        if(cfg.data.type=='transaction')
                            info = [count, info.hash, null];
                    }
                }

                show.push(info);

            }
        }

        if(['prev','last'].includes(action))
            show = show.reverse();

        return show;
    }

    async processIconRequest(req, res){
        const dirPath  = path.resolve(path.join(__dirname, 'content/icons'));
        const filePath = path.resolve(path.join(dirPath, req.path.replace(/^\/icon/, '')));
        if(!filePath.startsWith(dirPath + path.sep))
            return res.status(403).json({ error: 'Access denied', code: 'PATH_DENIED' });
        if(fs.existsSync(filePath)){
            res.sendFile(filePath);
        } else {
            res.redirect(302, '/icon/default.png');
        }
    }

    /**********************************************************
     * FILE content: raw bytes
     *
     * GET /{COIN}/api/file/{ACTION_INDEX}/raw
     *
     * Gated FILE: returns the AES-256-GCM ciphertext bytes (12-byte
     * nonce || ciphertext || 16-byte GCM tag) as octet-stream.
     * Holders decrypt client-side after receiving the symmetric key
     * via an ECIES MESSAGE.
     *
     * Non-gated FILE: returns the stored bytes from the colocated
     * decoder DB. This is the resolution target for TIS `data_ref`
     * entries (`action:<index>`), so NFT-pattern tokens with fully
     * on-chain artwork can render in the browser. The declared MIME
     * type is honored INLINE only for safe media types; on-chain
     * bytes are attacker-controlled, and serving them as text/html
     * (or letting the browser sniff them into it) from the explorer
     * origin would be stored XSS. Everything else downloads as an
     * octet-stream attachment.
     *
     * Unknown action indexes (or an unreachable decoder DB) return 404.
     *********************************************************/
    async processFileRawRequest(req, res){
        let coin = String(req.params.coin || '').toUpperCase();
        let actionIndex = req.params.actionIndex;
        if(!/^[0-9]+$/.test(String(actionIndex)))
            return res.status(400).json({ error: 'Invalid action_index', code: 'INVALID_ACTION_INDEX' });
        if(!this.db.pools || !this.db.pools[coin])
            return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
        let config = { coin, data: {} };
        let raw  = null;
        let file = null;
        try {
            let rows = await this.db.getGatedFileRaw(config, actionIndex);
            if(rows && rows.length > 0) raw = rows[0].raw_data;
            if(!raw)
                file = await this.db.getFileRaw(config, actionIndex);
        } catch (e) {
            console.error('processFileRawRequest error:', e);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
        if(!raw && !file)
            return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
        // Never let the browser sniff a different content type out of the bytes
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        if(raw){
            res.set('Content-Type', 'application/octet-stream');
            return res.send(raw);
        }
        // Non-gated: honor the declared MIME type inline only when it is a
        // well-formed, render-safe media type; anything else (html, svg, xml,
        // scripts, unknown) is forced to download as an opaque attachment.
        let type   = String(file.type || '').toLowerCase();
        let valid  = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type);
        let inline = valid && (
            ((/^(image|audio|video)\//).test(type) && type!='image/svg+xml') ||
            type=='application/pdf' ||
            // On-chain TIS documents (DESCRIPTION = action:<index>) are JSON
            // FILEs fetched same-origin by clients. JSON is render-safe:
            // with nosniff set it can't be coerced into a scriptable type.
            type=='application/json'
        );
        if(inline){
            res.set('Content-Type', type);
        } else {
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment');
        }
        return res.send(file.raw_data);
    }

    // Staleness gate for consensus data served from a SELF-SYNCED checkpoint
    // mirror (#4138 semantics carried into the decoupled world). Only applies
    // to coins whose mirror this process runs (HubMirrorSyncManager); the
    // externally-maintained-schema mode is unaffected. Two tiers, per the
    // operator decision on this feature: a mirror that has NEVER completed its
    // REST bootstrap must fail loud (an empty mirror must read as an outage,
    // not as an empty ledger), while a bootstrapped-but-lagging mirror serves
    // with a mirror_lag_seconds annotation and warns past MIRROR_MAX_LAG_S,
    // hard-failing only when MIRROR_LAG_FAIL_CLOSED=1 opts in.
    _mirrorGate(coin){
        let mgr = this.hubMirrorSync;
        if(!mgr || !mgr.managesCoin(coin)) return { blocked: null, annotate: null };
        let status = mgr.statusForCoin(coin) || {};
        if(!status.bootstrapDrained)
            return { blocked: 'MIRROR_NOT_BOOTSTRAPPED', annotate: null };
        let annotate = { mirror_bootstrapped: true, mirror_lag_seconds: status.mirrorLagSeconds };
        let maxLag = parseInt(process.env.MIRROR_MAX_LAG_S, 10) || 0;
        if(maxLag > 0 && status.mirrorLagSeconds !== null && status.mirrorLagSeconds > maxLag){
            console.warn('[hub-mirror] ' + coin + ' mirror lag ' + status.mirrorLagSeconds +
                's exceeds MIRROR_MAX_LAG_S=' + maxLag +
                (process.env.MIRROR_LAG_FAIL_CLOSED === '1' ? ' (failing closed)' : ' (serving with annotation)'));
            if(process.env.MIRROR_LAG_FAIL_CLOSED === '1')
                return { blocked: 'MIRROR_STALE', annotate };
        }
        return { blocked: null, annotate };
    }

    _mirrorBlockedBody(blocked){
        return {
            error: blocked === 'MIRROR_NOT_BOOTSTRAPPED'
                ? 'Hub-mirror has not completed its initial bootstrap; consensus data is unavailable rather than served empty.'
                : 'Hub-mirror is stale beyond MIRROR_MAX_LAG_S and MIRROR_LAG_FAIL_CLOSED is set.',
            code: blocked
        };
    }

    // GET /{COIN}/api/hub-mirror/status: self-synced mirror observability for
    // this coin ({enabled:false} when the coin is served from an externally-
    // maintained schema). Operators use bootstrapDrained/mirrorLagSeconds to
    // tell "empty because nothing exists" from "empty because never synced".
    async processHubMirrorStatusRequest(req, res){
        let coin = String(req.params.coin || '').toUpperCase();
        if(!this.db.pools || !this.db.pools[coin])
            return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
        let status = this.hubMirrorSync ? this.hubMirrorSync.statusForCoin(coin) : null;
        return res.json(status || { enabled: false });
    }

    // GET /{COIN}/api/checkpoints[?limit=N]: latest quorum-signed state checkpoints
    // for this coin's chain, from the hub-mirrored state_checkpoints table.
    async processCheckpointsRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let limit = Math.min(parseInt(req.query.limit) || 10, 100);
            let rows = await this.db.getCheckpointRows({ coin, data: {} }, null, limit);
            return res.json({ checkpoints: rows || [], count: (rows || []).length, ...(gate.annotate || {}) });
        } catch (e) {
            console.error('processCheckpointsRequest error:', e);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/checkpoint/{blockIndex}/verify: re-verify the checkpoint at a
    // height against the mirrored oracle_publish capability snapshot. Returns the
    // canonical signing string + qualifying validator set so a client can ALSO
    // verify independently rather than trusting this server's `verified` flag.
    async processCheckpointVerifyRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let blockIndex = req.params.blockIndex;
            if(!/^[0-9]+$/.test(String(blockIndex)))
                return res.status(400).json({ error: 'Invalid block_index', code: 'INVALID_BLOCK_INDEX' });
            let config = { coin, data: {} };
            let rows = await this.db.getCheckpointRows(config, Number(blockIndex), 1);
            if(!rows || rows.length === 0)
                return res.status(404).json({ error: 'No checkpoint at this height', code: 'CHECKPOINT_NOT_FOUND' });
            let cp = rows[0];

            // Canonical signing string, byte-identical to the hub engine + ANCHOR
            // verifier + SDK (canonicalCheckpointString below the class; exported so
            // the unit suite cross-checks it against the SDK builder byte-for-byte).
            let canonical = canonicalCheckpointString(cp);

            let validators = await this.db.getCapabilitySnapshotRows(config, 'oracle_publish', cp.snapshot_block) || [];
            let qualified  = new Set(validators.map(v => String(v.signing_pubkey).toLowerCase()));
            let quorum     = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));

            // Stake-weighted-or-count is gated on the BTC-anchored snapshot_block +
            // network, the same flag-day the hub/indexer flip on. Below it the count
            // quorum decides; at/above it the VALID signers' distinct stake sources
            // must clear the source-deduped 3·Σ > 2·S predicate.
            let isWeighted = swq.isStakeWeightedQuorumActive(cp.snapshot_block, cp.network);

            let sigs = [];
            let sigsParseFailed = false;
            try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch(e){ console.error('processCheckpointVerifyRequest: validator_signatures parse failed for ' + cp.chain + '/' + cp.block_index + ':', e); sigs = []; sigsParseFailed = true; }
            let validSigs = 0, seen = new Set(), validSigners = [];
            for(let s of sigs){
                let pk  = String(s && s.pubkey || '').toLowerCase();
                let sig = String(s && s.sig || '');
                if(!pk || seen.has(pk) || !qualified.has(pk)) continue;
                // Only mark a pubkey "seen" once its signature actually verifies
                // (matching the SDK's hardened verifyCheckpoint): marking on first
                // encounter would let a garbage-then-valid pair of entries for the
                // same qualified validator suppress the real signature (order-
                // dependent quorum under-count), failing a quorate checkpoint closed.
                if(this.util.ed25519Verify(canonical, sig, pk)){ seen.add(pk); validSigs++; validSigners.push(pk); }
            }

            // Per-validator { pubkey, weight, source } so a client can re-derive the
            // weighted verdict locally (weight = the key's stake amount; source = its
            // stake-weight grouping key, empty string in the legacy count regime).
            let validatorSet = validators.map(v => ({
                pubkey: String(v.signing_pubkey).toLowerCase(),
                weight: String(v.amount != null ? v.amount : '0'),
                source: String(v.source != null ? v.source : '')
            }));

            let verified = isWeighted
                ? (qualified.size > 0 && swq.meetsStakeThreshold(validatorSet, validSigners))
                : (qualified.size > 0 && validSigs >= quorum);

            return res.json({
                checkpoint:    cp,
                canonical:     canonical,
                validators:    validatorSet,
                is_weighted:   isWeighted,
                quorum:        quorum,
                valid_sigs:    validSigs,
                verified:      verified,
                // qualified.size === 0 → the oracle_publish snapshot isn't mirrored
                // here; the sigs may still be valid (clients can verify elsewhere).
                snapshot_available:      qualified.size > 0,
                signatures_unparseable:  sigsParseFailed
            });
        } catch (e) {
            console.error('processCheckpointVerifyRequest error:', e);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/balance/{address}/{tick}?height=H  (SPV spec §4.4/§8.1)
    // Returns a BalanceProof bound to the nearest signed checkpoint at height >= H
    // (or the latest), which the client recomputes locally against the committed
    // state_root. A claimed-zero balance comes back as an SMT non-inclusion proof.
    async processBalanceProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Balance proofs bind to a quorum-signed checkpoint from the mirror,
            // so they inherit the same staleness gate as the checkpoint routes.
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let address = String(req.params.address || '');
            let tick    = String(req.params.tick || '');
            if(!address || !tick)
                return res.status(400).json({ error: 'address and tick are required', code: 'MISSING_PARAMETER' });
            let height = (req.query.height !== undefined && req.query.height !== '') ? req.query.height : null;
            if(height !== null && !/^[0-9]+$/.test(String(height)))
                return res.status(400).json({ error: 'Invalid height', code: 'INVALID_HEIGHT' });
            let config = { coin, data: {} };
            let result = await this.proofServer.balanceProof(config, parsed.coin, parsed.network, address, tick,
                                                             height === null ? null : Number(height));
            if(result.error){
                let map = { NO_CHECKPOINT: [404, 'No signed checkpoint at or above this height'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            console.error('processBalanceProofRequest error:', e && e.message);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/checkpoints/range?from=&to=  (SPV spec §8.1, forward-following)
    async processCheckpointsRangeRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let from = req.query.from, to = req.query.to;
            if(!/^[0-9]+$/.test(String(from)) || !/^[0-9]+$/.test(String(to)))
                return res.status(400).json({ error: 'from and to (integers) are required', code: 'INVALID_RANGE' });
            from = Number(from); to = Number(to);
            if(to < from)
                return res.status(400).json({ error: 'to must be >= from', code: 'INVALID_RANGE' });
            // Cap the span so a single request cannot scan an unbounded range.
            let limit = Math.min(500, (to - from) + 1);
            let config = { coin, data: {} };
            return res.json(await this.proofServer.checkpointRange(config, from, to, limit));
        } catch(e){
            console.error('processCheckpointsRangeRequest error:', e && e.message);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/action/{actionIndex}  (SPV spec §5/§8.1)
    // A per-row block-content inclusion proof for the action, bound to the signed
    // checkpoint that commits its block's block_merkle_root. block_merkle_root is
    // per-block, so the action's block must itself be checkpointed (D3); a non-
    // checkpointed block returns 409. The client recomputes the root locally.
    async processActionProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Action proofs bind to a quorum-signed checkpoint read from the mirror,
            // so they inherit the same staleness gate as the balance-proof/checkpoint
            // routes: on a never-bootstrapped or stale self-synced mirror they must 503
            // rather than answer an authoritative "not checkpointed" (409) off an
            // empty/frozen mirror.
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let actionIndex = req.params.actionIndex;
            if(!/^[0-9]+$/.test(String(actionIndex)))
                return res.status(400).json({ error: 'Invalid action index', code: 'INVALID_ACTION_INDEX' });
            let config = { coin, data: {} };
            let result = await this.proofServer.actionProof(config, parsed.coin, parsed.network, Number(actionIndex));
            if(result.error){
                let map = { ACTION_NOT_FOUND: [404, 'No such action on this server'],
                            ACTION_BLOCK_NOT_CHECKPOINTED: [409, 'The action\'s block is not checkpointed (no signed block_merkle_root to bind to)'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            ACTION_LEAF_NOT_FOUND: [500, 'Action row not present in its block leaf set'],
                            PROOF_BLOCK_MERKLE_MISMATCH: [500, 'Committed block_merkle_root does not match the local block tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            console.error('processActionProofRequest error:', e && e.message);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/validator-set?height=<btc_snapshot>  (SPV spec §7.2/§8.1)
    // Proves the oracle_publish/cross_chain signer set + weights + source-deduped total
    // at BTC snapshot height S, bound to the BTC checkpoint at block_index == S. BTC-only.
    async processValidatorSetProofRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            // Validator-set proofs bind to the BTC checkpoint at the snapshot height,
            // read from the mirror, so they inherit the same staleness gate as the
            // balance-proof/checkpoint routes (503 on an unbootstrapped/stale mirror
            // instead of an authoritative "not yet checkpointed" 409 off a frozen mirror).
            let gate = this._mirrorGate(coin);
            if(gate.blocked)
                return res.status(503).json(this._mirrorBlockedBody(gate.blocked));
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            if(parsed.coin !== 'BTC')
                return res.status(400).json({ error: 'validator-set proof is BTC-only (stakes_root is BTC-only)', code: 'STAKES_BTC_ONLY' });
            let height = req.query.height;
            if(!/^[0-9]+$/.test(String(height)))
                return res.status(400).json({ error: 'height (BTC snapshot block) is required', code: 'INVALID_HEIGHT' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'validator-set proof unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            let connector = new IndexerConnector(url);
            let config = { coin, data: {} };
            let result = await this.proofServer.validatorSetProof(config, parsed.coin, parsed.network, Number(height), connector);
            if(result.error){
                let map = { STAKES_BTC_ONLY: [400, 'validator-set proof is BTC-only'],
                            SNAPSHOT_NOT_YET_CHECKPOINTED: [409, 'No BTC checkpoint at this snapshot height yet (retry after the chain advances)'],
                            CHECKPOINT_PRE_COMMITMENT: [409, 'Checkpoint predates the state-commitment flag-day (no committed roots)'],
                            NO_STATE_TREE: [501, 'This server does not hold the state tree (point a full indexer DB at the proof server)'],
                            INDEXER_UNAVAILABLE: [502, 'Indexer API unavailable for the stake set'],
                            PROOF_STATE_ROOT_MISMATCH: [500, 'Committed state_root does not match the local state tree'] };
                let m = map[result.error] || [500, 'Server error'];
                return res.status(m[0]).json({ error: m[1], code: result.error });
            }
            return res.json(result);
        } catch(e){
            console.error('processValidatorSetProofRequest error:', e && e.message);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/proof/contract-state/{contractIndex}/{key}  (SPV spec §8.1)
    // RESERVED: contract_state_root is committed EMPTY in state_root_version 1 (spec
    // §10 D1), so no real contract-state proof can be served until a later version.
    async processContractStateProofRequest(req, res){
        return res.status(501).json({ error: 'contract-state proof unsupported in state_root_version 1 (committed EMPTY per spec D1)',
                                      code: 'UNSUPPORTED_VERSION' });
    }

    // POST /{COIN}/api/contract/{contractIndex}/call  body: {method, params?, caller?}
    // Read-only simulation of a contract method against current state (see
    // vm-query.js). Contract-level failures (unknown method, revert, gas) come
    // back as success:false in a 200 body, exactly as the VM reports them;
    // request/infra failures map to typed HTTP errors.
    async processContractCallRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let parsed = this.parseCoinCode(coin, await this.configInfo.getConfig());
            if(!parsed)
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let contractIndex = req.params.contractIndex;
            if(!/^[0-9]+$/.test(String(contractIndex)))
                return res.status(400).json({ error: 'Invalid contract index', code: 'INVALID_CONTRACT_INDEX' });

            let config = { coin, data: {} };
            let result = await vmQuery.simulate(this.db, config, Number(contractIndex), req.body || {}, parsed.coin, parsed.network, req.ip);

            // Effects live under `simulation` with an explicit disclaimer so no
            // client can mistake a would-be write for an on-chain one.
            return res.json({
                success:     result.success,
                error:       result.error,
                gasUsed:     result.gasUsed,
                returnValue: result.returnValue,
                logs:        result.logs,
                simulation: {
                    note:           'read-only preview; nothing was committed on-chain',
                    stateChanges:   result.stateChanges,
                    stateDeletes:   result.stateDeletes,
                    emittedActions: result.emittedActions
                }
            });
        } catch(e){
            if(e && e.code && e.httpStatus)
                return res.status(e.httpStatus).json({ error: e.message, code: e.code });
            console.error('processContractCallRequest error:', e && e.message);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // Resolve an explorer coin code (e.g. 'BTC', 'TBTC', 'RDOGE') to its base coin + network
    // using the configured prefix map. Returns { coin, network } or null when unrecognised.
    parseCoinCode(code, config){
        code = String(code || '').toUpperCase();
        let prefixes = config['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        let coins    = config['COIN_NETWORKS'] || {};
        // Non-empty prefixes (T/R) first so 'TBTC' isn't mis-read as a mainnet coin named 'TBTC'.
        for(let network in prefixes){
            let p = prefixes[network];
            if(p && code.startsWith(p)){
                let base = code.slice(p.length);
                if(coins[base]) return { coin: base, network };
            }
        }
        if(coins[code]) return { coin: code, network: 'mainnet' };
        return null;
    }

    // Native-coin fee pre-flight (proxy to the colocated indexer's `feequote`).
    // GET /{COIN}/api/feequote?action=ISSUE&params=0|NEWTICK&source=...&feeOutputSats=...
    async processFeeQuoteRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'native fee pre-flight unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            if(this.util.isNull(req.query.action))
                return res.status(400).json({ error: 'action is required', code: 'MISSING_PARAMETER' });
            let connector = new IndexerConnector(url);
            let result = await connector.feequote({
                action:        req.query.action,
                params:        req.query.params,   // pipe-delimited string; the indexer splits it
                source:        req.query.source,
                feeOutputSats: req.query.feeOutputSats
            });
            return res.json(result);
        } catch(e){
            console.error('processFeeQuoteRequest error:', e.message || e);
            return res.status(502).json({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR' });
        }
    }

    // Native-coin fee schedule + current oracle prices (proxy to the indexer's `feeschedule`).
    // GET /{COIN}/api/feeschedule
    async processFeeScheduleRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'fee schedule unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            let connector = new IndexerConnector(url);
            return res.json(await connector.feeschedule());
        } catch(e){
            console.error('processFeeScheduleRequest error:', e.message || e);
            return res.status(502).json({ error: 'fee schedule upstream error', code: 'UPSTREAM_ERROR' });
        }
    }

    // SSRF guard helper: classify a resolved IP literal as a private, loopback,
    // link-local, CGNAT, unique-local or cloud-metadata address that the /relay
    // endpoint must refuse to connect to. Delegates to the canonical classifier
    // in ssrf-guard.js so the /relay and IconDownloader egress paths share one
    // range list instead of drifting apart.
    _isPrivateAddress(ip){
        return ssrfGuard.isPrivateAddress(ip);
    }

    // SSRF guard: a dns.lookup-compatible shim handed to axios so the address it
    // is about to connect to is checked against _isPrivateAddress. Rejecting here
    // (rather than re-resolving separately) means there is no gap between the
    // check and the connection, closing the DNS-name / DNS-rebinding bypass of
    // the literal hostname blocklist.
    _ssrfSafeLookup(hostname, options, callback){
        if(typeof options === 'function'){ callback = options; options = {}; }
        dns.lookup(hostname, options, (err, address, family) => {
            if(err) return callback(err);
            let entries = Array.isArray(address) ? address : [{ address, family }];
            for(let e of entries){
                if(this._isPrivateAddress(e.address)){
                    let denied = new Error('Destination resolves to a non-permitted address');
                    denied.code = 'RELAY_DENIED';
                    return callback(denied);
                }
            }
            callback(null, address, family);
        });
    }

    async processRelayRequest(req, res){
        if(!this.util.isNull(req.query.url)){
            try {
                const parsed = new URL(req.query.url);

                if(!['http:', 'https:'].includes(parsed.protocol))
                    return res.status(400).json({ error: 'Invalid protocol', code: 'RELAY_INVALID_PROTOCOL' });

                // Node's URL parser wraps IPv6 in brackets (e.g. [::1]); strip them for matching
                const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
                // Literal-IP hosts never reach the dns.lookup shim below (Node's
                // net.connect skips a custom `lookup` for IP literals), so a private
                // literal would otherwise sail past the shim entirely. Check literals
                // here against the canonical range classifier, which covers IPv6 ULA
                // (fc00::/7 incl. fd00:ec2::254), CGNAT (100.64/10), and the full
                // link-local range that the drifted inline list below missed.
                if(net.isIP(hostname) && this._isPrivateAddress(hostname))
                    return res.status(403).json({ error: 'Destination not permitted', code: 'RELAY_DENIED' });
                const blocked = [
                    /^localhost$/i,
                    /^127\./,
                    /^0\./,
                    /^10\./,
                    /^172\.(1[6-9]|2[0-9]|3[01])\./,
                    /^192\.168\./,
                    /^169\.254\./,
                    /^::1$/,
                    /^fc00:/,
                    /^::ffff:/i,
                    /^fe80:/i,
                    /^\d+$/,
                ];
                if(blocked.some(r => r.test(hostname)))
                    return res.status(403).json({ error: 'Destination not permitted', code: 'RELAY_DENIED' });

                const ext  = String(path.extname(parsed.pathname)).replace('.','').toLowerCase();
                // The literal-hostname blocklist only catches IPs in the URL; a domain whose
                // DNS record points at a private address (or rebinds) would sail past it.
                // _ssrfSafeLookup validates the address axios actually connects to, closing
                // the TOCTOU window between a separate re-resolution check and the connection.
                const opts = { timeout: 5000, maxContentLength: 5 * 1024 * 1024, maxRedirects: 0,
                               lookup: this._ssrfSafeLookup.bind(this) };

                const isArweave = /^arweave\.net$/i.test(parsed.hostname);
                if(ext=='json' || isArweave){
                    let response = await axios.get(parsed.href, opts);
                    if(!this.util.isNull(response.data)){
                        res.type('json').send(this.util.jsonStringify(response.data));
                        return;
                    }
                }

                if(ext=='png'){
                    let response    = await axios.get(parsed.href, { ...opts, responseType: 'arraybuffer' });
                    let base64Image = btoa(new Uint8Array(response.data).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                    res.send(base64Image);
                    return;
                }
            } catch(e) {
                return res.status(400).json({ error: 'Invalid or unreachable URL', code: 'RELAY_FETCH_FAILED' });
            }
        }
        res.status(503).json({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    }

    static getSlowRequests() { return slowRequests; }

    // Return p95 latency (ms) and total requests served, derived from the
    // rolling latency buffer. p95 is computed over whichever is smaller: the
    // number of requests ever served or the buffer window, so it is meaningful
    // from the very first request rather than waiting for a full window.
    static getLatencyStats(){
        let n = Math.min(requestCount, LATENCY_WINDOW);
        if(n === 0) return { p95_ms: null, requests_served: 0 };
        // Sort only the slice that has real data; copy so the buffer is untouched.
        let slice = latencyBuf.slice(0, n).sort((a, b) => a - b);
        let p95   = slice[Math.floor(n * 0.95)];
        return { p95_ms: p95, requests_served: requestCount };
    }
}

// The explorer's copy of the XCHECKPOINT canonical signing string, byte-identical
// to the hub's StateCheckpointEngine.canonicalCheckpoint, the indexer's ANCHOR verifier,
// xchain-sdk/src/checkpoint.js canonicalCheckpoint, xchain-sync/src/checkpoint.js
// canonicalCheckpoint, xchain-indexer/src/recovery.js's _wrapperCanonical (rebuilds the
// same base from parsed ANCHOR bytes), and xchain-hub/src/StateAnchorPublisher.js's
// _archiveCanonical (nests _rawCanonicalCheckpoint). Six independent sibling copies;
// all must change in lockstep with this one.
// At/above the EQUIV flag-day (gated on the BTC snapshot_block + network) the v0
// canonical is wrapped in the uniform header (TAG=XCHECKPOINT, v0 ROUND_ID, VIEW=0).
// SPV Phase 2 (spec §6.1): post CHECKPOINT_COMMITMENT flag-day the signed string
// additively commits the light-client roots + version bytes from the checkpoint row,
// appended to the RAW string BEFORE the EQUIV wrap. Append only when the roots are
// present (legacy/null-root rows keep their original rootless canonical; the hub
// never signs a rootless checkpoint post-flag-day). Exported for the byte-parity
// cross-check against the SDK builder in explorer.checkpoints.test.js.
function canonicalCheckpointString(cp){
    let canonRaw = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    if(ckpt.isCheckpointCommitmentActive(cp.snapshot_block, cp.network) &&
       cp.state_root != null && cp.block_merkle_root != null &&
       cp.state_root_version != null && cp.block_merkle_version != null)
        canonRaw += '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
                           String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    return eq.isEquivHeaderActive(cp.snapshot_block, cp.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
            cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq, 0, canonRaw)
        : canonRaw;
}

module.exports = XChainExplorer;
module.exports.canonicalCheckpointString = canonicalCheckpointString;
