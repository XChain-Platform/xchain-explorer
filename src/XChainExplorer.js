/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - Explorer Class
 * 
 * This file handles starting the explorer, decoding requests, and returning data
 *
 ********************************************************************/

// Load required libraries
const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const dns            = require('dns');
const axios          = require('axios');
const util           = require('./utility.js');
const database       = require('./db.js');
const IconDownloader = require('./IconDownloader.js');
const IndexerConnector = require('./XChainIndexerConnector.js');

let slowRequests = 0;

class XChainExplorer {

    // Handle constructing a class instance
    constructor(app, configInfo){

        // XChain Indexer Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        // Setup alias to app (express)
        this.app = app;

        // Setup alias to explorer config
        this.configInfo  = configInfo;

        // Create instance of the utility class
        this.util = new util(this.configInfo);

        // Create instance of the datbase class
        this.db   = new database(this);

        // Setup alias to list of supported URLs
        this.urls = this.setupUrls();

        // Define any custom headers to pass with each request
        this.headers = {};

        // Setup empty request response
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
        // Optional: in-process icon downloader. Opt-in via configInfo.iconDownload.enabled.
        // Requires sql/icons.sql installed in each indexer DB and ImageMagick `convert` on PATH.
        this.iconDownloader = new IconDownloader(this);
        try {
            await this.iconDownloader.start();
        } catch (e){
            console.error('icon-downloader failed to start:', e && e.stack ? e.stack : e);
        }
    }

    // Function to define a list of explorer urls
    setupUrls(){

        // Define list of URLS to parse through and determine how to process each
        let urls = {

            // Define list of static file directories to just serve out the raw file
            'static' : [
                'css',
                'fonts',
                'charts',
                'images',
                'json',
                'js'
            ],

            // List of HTML URLs and the HTML content file to serve out
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
                '/{COIN}/execution/{QUERY}'   : 'execution.html',
                '/{COIN}/deposits'            : 'deposits.html',
                '/{COIN}/withdrawals'         : 'withdrawals.html',
                '/{COIN}/validators'          : 'validators.html',
                '/{COIN}/contract_stakes'     : 'contract_stakes.html',
                '/{COIN}/contract_unstakes'   : 'contract_unstakes.html',
                '/{COIN}/slash_events'        : 'slash_events.html',
                '/{COIN}/attestations'        : 'attestations.html',
                '/{COIN}/sends'               : 'sends.html',
                '/{COIN}/sleeps'              : 'sleeps.html',
                '/{COIN}/swaps'               : 'swaps.html',
                '/{COIN}/swap_matches'        : 'swaps.html',
                '/{COIN}/sweeps'              : 'sweeps.html',
                // Misc 
                '/{COIN}'                     : 'coin_home.html',
                '/{COIN}/blocks'              : 'blocks.html',
                '/{COIN}/markets'             : 'markets.html',
                '/{COIN}/search'              : 'search.html',
                '/{COIN}/tokens'              : 'tokens.html',
                '/{COIN}/terms'               : 'terms.html',
                '/{COIN}/mempool'             : 'mempool.html',
                //  Specific Information pages
                '/{COIN}/address/{QUERY}'     : 'address.html',
                '/{COIN}/action/{QUERY}'      : 'action.html',
                '/{COIN}/block/{QUERY}'       : 'block.html',
                '/{COIN}/dispenser/{QUERY}'   : 'dispenser.html',
                '/{COIN}/market/{QUERY}'      : 'market.html',
                '/{COIN}/token/{QUERY}'       : 'token.html',
                '/{COIN}/transaction/{QUERY}' : 'transaction.html'

            },

            // List of API endpoints and the related method
            'api' : {
                // API Action Endpoints                        Method                    Types
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
                '/{COIN}/api/coinpays/{QUERY}/{TYPE}'           : ['getCoinpays',          ['block', 'address']],
                '/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}'    : ['getCoinpayExpires',     ['block', 'address']],
                '/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}': ['getCoinpayObligations', ['block', 'address']],
                // Price Endpoints (PRICE v0 validator COIN/FIAT snapshots + v1 user TOKEN/FIAT oracle)
                '/{COIN}/api/prices/{QUERY}/{TYPE}'           : ['getPrices',           ['block', 'address', 'source', 'token']],
                '/{COIN}/api/prices'                          : ['getPrices'],
                '/{COIN}/api/price_snapshots/{QUERY}/{TYPE}'  : ['getPriceSnapshots',    ['pair', 'round', 'status']],
                '/{COIN}/api/price_snapshots'                 : ['getPriceSnapshots'],
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
                // Deposit / Withdrawal Endpoints
                '/{COIN}/api/deposits/{QUERY}/{TYPE}'          : ['getDeposits',          ['block', 'address', 'source', 'contract']],
                '/{COIN}/api/withdrawals/{QUERY}/{TYPE}'       : ['getWithdrawals',       ['block', 'address', 'source', 'contract']],
                // Staking / Validator Endpoints
                '/{COIN}/api/stakes/{QUERY}/{TYPE}'            : ['getStakes',            ['block', 'address', 'source']],
                '/{COIN}/api/stakes'                           : ['getStakes'],
                '/{COIN}/api/validators'                       : ['getValidators'],
                '/{COIN}/api/delegations/{QUERY}/{TYPE}'       : ['getDelegations',       ['block', 'address', 'source']],
                '/{COIN}/api/rewards/{QUERY}/{TYPE}'           : ['getValidatorRewards',  ['address', 'source']],
                // Contract-targeted Staking (STAKE v3 / UNSTAKE v1 + slash side-effects)
                '/{COIN}/api/contract_stakes/{QUERY}/{TYPE}'   : ['getContractStakes',    ['block', 'address', 'contract']],
                '/{COIN}/api/contract_stakes'                  : ['getContractStakes'],
                '/{COIN}/api/contract_unstakes/{QUERY}/{TYPE}' : ['getContractUnstakes',  ['block', 'address', 'contract']],
                '/{COIN}/api/contract_unstakes'                : ['getContractUnstakes'],
                '/{COIN}/api/contract_delegations/{QUERY}/{TYPE}' : ['getContractDelegations', ['block', 'address', 'contract']],
                '/{COIN}/api/contract_delegations'             : ['getContractDelegations'],
                '/{COIN}/api/slash_events/{QUERY}/{TYPE}'      : ['getSlashEvents',       ['block', 'address', 'contract']],
                '/{COIN}/api/slash_events'                     : ['getSlashEvents'],
                // Cross-chain coordination mirrors (hub-replicated match + local settlement legs)
                '/{COIN}/api/cross_chain_matches/{QUERY}/{TYPE}'     : ['getCrossChainMatches',     ['match', 'block', 'status']],
                '/{COIN}/api/cross_chain_matches'                    : ['getCrossChainMatches'],
                '/{COIN}/api/cross_chain_settlements/{QUERY}/{TYPE}' : ['getCrossChainSettlements', ['match', 'block']],
                '/{COIN}/api/cross_chain_settlements'                : ['getCrossChainSettlements'],
                // Attestation Endpoints (ATTEST v0 requests + v1 responses from the `attests` table)
                '/{COIN}/api/attestations/{QUERY}/{TYPE}'      : ['getAttestations',      ['block', 'address', 'contract']],
                '/{COIN}/api/attestations'                     : ['getAttestations'],
                // Core Action Endpoints (continued)
                '/{COIN}/api/sends/{QUERY}/{TYPE}'             : ['getSends',            ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/sleeps/{QUERY}/{TYPE}'            : ['getSleeps',           ['block', 'address', 'token']],
                '/{COIN}/api/swaps/{QUERY}/{TYPE}'             : ['getSwaps',            ['block', 'address', 'token']],
                '/{COIN}/api/swap_edits/{QUERY}/{TYPE}'        : ['getSwapEdits',        ['block', 'address']],
                '/{COIN}/api/swap_expires/{QUERY}/{TYPE}'      : ['getSwapExpires',      ['block', 'address']],
                '/{COIN}/api/swap_cancels/{QUERY}/{TYPE}'      : ['getSwapCancels',      ['block', 'address']],
                '/{COIN}/api/swap_matches/{QUERY}/{TYPE}'      : ['getSwapMatches',      ['block']],
                '/{COIN}/api/sweeps/{QUERY}/{TYPE}'            : ['getSweeps',           ['block', 'address', 'source', 'destination']],
                // Misc API Endpoints                          Method                    Types
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
                // Project registry — current roster of a project tick (protocol/Project_Registry.md)
                '/{COIN}/api/project/{QUERY}'                  : ['getProject',          'token'],
                '/{COIN}/api/token/{QUERY}'                    : ['getToken',            'token'],
                '/{COIN}/api/tokens/{QUERY}/{TYPE}'            : ['getTokens',           ['block', 'address', 'token', 'subtoken', 'nft']],
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

            // List of explorer endpoints and the related method
            'explorer' : {
                // Explorer Endpoints                           Method           Types
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
                '/{COIN}/explorer/deposits/{QUERY}/{TYPE}'                   : ['getDeposits',     ['block', 'address', 'contract']],
                '/{COIN}/explorer/withdrawals/{QUERY}/{TYPE}'                : ['getWithdrawals',  ['block', 'address', 'contract']],
                '/{COIN}/explorer/stakes/{QUERY}/{TYPE}'                     : ['getStakes',       ['block', 'address']],
                '/{COIN}/explorer/delegations/{QUERY}/{TYPE}'                : ['getDelegations',  ['block', 'address']],
                '/{COIN}/explorer/rewards/{QUERY}/{TYPE}'                    : ['getValidatorRewards', ['address']],
                '/{COIN}/explorer/validators/{QUERY}/{TYPE}'                 : ['getValidators',   ['block', 'address']],
                '/{COIN}/explorer/contract_stakes/{QUERY}/{TYPE}'           : ['getContractStakes',   ['block', 'address', 'contract']],
                '/{COIN}/explorer/contract_unstakes/{QUERY}/{TYPE}'         : ['getContractUnstakes', ['block', 'address', 'contract']],
                '/{COIN}/explorer/slash_events/{QUERY}/{TYPE}'              : ['getSlashEvents',  ['block', 'address', 'contract']],
                '/{COIN}/explorer/attestations/{QUERY}/{TYPE}'              : ['getAttestations', ['block', 'address', 'contract']],
                '/{COIN}/explorer/sends/{QUERY}/{TYPE}'                     : ['getSends',        ['block', 'address', 'token']],
                '/{COIN}/explorer/search/{QUERY}/{TYPE}'                    : ['getSearch',       ['address', 'broadcast', 'token', 'transaction']],
                '/{COIN}/explorer/sleeps/{QUERY}/{TYPE}'                    : ['getSleeps',       ['block', 'address', 'token']],
                '/{COIN}/explorer/swaps/{QUERY}/{TYPE}'                     : ['getSwaps',        ['block', 'address', 'token']],
                '/{COIN}/explorer/sweeps/{QUERY}/{TYPE}'                    : ['getSweeps',       ['block', 'address']],
                '/{COIN}/explorer/tokens/{QUERY}/{TYPE}'                    : ['getTokens',       ['block', 'address', 'token', 'subtoken', 'nft']]
            }
        };

        // Setup listener for icon requests
        this.app.use('/icon', (req, res) => { this.processIconRequest(req, res); });

        // Setup listener for relay requests
        this.app.use('/relay', (req, res) => { this.processRelayRequest(req, res); });

        // Machine-readable API spec (OpenAPI 3.1). Regenerated by docs/openapi.build.js;
        // test/unit/openapi-coverage.test.js keeps it in lockstep with the urls tables above.
        this.app.get('/openapi.json', (req, res) => {
            if(!this.openapiSpec)
                this.openapiSpec = fs.readFileSync(path.join(__dirname, '../docs/openapi.json'));
            res.set('Cache-Control', 'public, max-age=3600');
            res.type('application/json').send(this.openapiSpec);
        });

        // Setup listeners for STATIC file requests
        for(let directory of urls['static'])
            this.app.use('/' + directory, express.static(path.join(__dirname, 'content', directory)))

        // Raw bytes for a FILE action. Gated files return their ciphertext as
        // application/octet-stream (holders decrypt client-side — see
        // xchain-documentation/protocol/TOKEN_GATED_CONTENT.md); non-gated files
        // return the stored bytes from the colocated decoder DB, served inline
        // only for safe media MIME types (this is how TIS `data_ref` entries
        // resolve for NFT display — see protocol/NFT_Standard.md).
        // Registered before the wildcard so the express route matcher hits this first.
        this.app.get('/:coin/api/file/:actionIndex/raw', (req, res) => { this.processFileRawRequest(req, res); });

        // Native-coin fee pre-flight + schedule. Thin proxies to the colocated indexer's
        // read-only feequote/feeschedule JSON-RPC, so the authoritative fee + oracle-price logic
        // stays single-sourced there. Registered before the wildcard so the matcher hits these
        // first. See xchain-documentation/concepts/GAS.md (client pre-validation).
        this.app.get('/:coin/api/feequote',    (req, res) => { this.processFeeQuoteRequest(req, res); });
        this.app.get('/:coin/api/feeschedule', (req, res) => { this.processFeeScheduleRequest(req, res); });

        // Quorum-signed state checkpoints — the light-client verification surface.
        // /checkpoints lists the latest signed checkpoints for the coin's chain;
        // /checkpoint/:blockIndex/verify re-verifies the 2f+1 oracle_publish
        // signatures server-side AND returns everything a client needs to verify
        // independently (canonical string, sigs, qualifying validator set).
        // Spec: xchain-documentation/protocol/actions/ANCHOR.md
        this.app.get('/:coin/api/checkpoints', (req, res) => { this.processCheckpointsRequest(req, res); });
        this.app.get('/:coin/api/checkpoint/:blockIndex/verify', (req, res) => { this.processCheckpointVerifyRequest(req, res); });

        // Setup wildcard listener to process all other requests (includes static failures)
        this.app.get('*', (req, res) => { this.processRequest(req, res); });

        // Return the urls 
        return urls;
    }

    // Function to handle processing a API request and returning a response
    async processRequest(req, res){
        //load config
        let config = await this.configInfo.getConfig()
        
        // Setup empty response object
        let response = structuredClone(this.response);

        // Start tracking time to parse block
        let debugTimer = this.util.startTimer();

        // Define some data placeholders
        let total = null;
        let data  = null;

        // Define basic request config object 
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
                // Offset Information (used by explorer for paging)
                offset: {
                    action: null, // Action (first, last, next, prev)
                    start:  null, // start value (action_index, etc)
                    stop:   null, // stop value (action_index, etc)
                }
            },
        };

        // Clean up path to remove any leading and trailing slashes and split the url path up into its various parts
        let urlPath = String(req.path).substring(1).replace(/\/$/,'').split('/');

        // Convert any 'null' string value to an actual null value (so isNull evaluates it properly)
        urlPath.forEach(function(value, idx){
            if(String(value).toLowerCase()=='null')
                urlPath[idx] = null;
        });

        // Determine the COIN using the first part of the URL path (BTC, LTC, DOGE, etc)
        let coin = String(urlPath[0]).toUpperCase();
        if(!this.util.isNull(config['COIN_SUPPORTED'][coin]))
            cfg.coin = coin;

        // Determine what TYPE of request this is using the second part of the URL path
        let type = String(urlPath[1]).toLowerCase();
        cfg.type = (['api','explorer'].includes(type) && urlPath.length>2) ? type : 'html';

        // Setup alias to req.path which we can easily tweak as needed
        let requestPath = req.path;

        // Set flag to indicate if this is a request for a COIN that is supported, but not available in this explorer
        let validDataRequest = (!this.util.isNull(config['COIN_SUPPORTED'][coin]) && !this.util.isNull(config['COIN_AVAILABLE'][coin])) ? true : false;

        // Force data all /{COIN}/api/status requests to valid so we return the explorer config
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

            // Handle html page matches
            if(cfg.type=='html'){
                // Handle exact page matches
                if(String(requestPath).toLowerCase()==String(url).toLowerCase())
                    match = true;
                // Handle COIN match
                if(parts.length==1 && urlPath.length==1 && parts[0]=='{COIN}' && !this.util.isNull(cfg.coin))
                    match = true;
                // Handle COIN action matches
                if(parts.length > 1 && parts[1]==String(urlPath[1]).toLowerCase())
                    match = true;
            }

            // Handle market matches
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
                // Pass forward the addional search criteria
                if(match){
                    cfg.data.search2 = urlPath[4];
                    cfg.data.search3 = urlPath[6];
                }
            // Handle action matches. Require the route's segment count to match the
            // request path so a shorter route can't swallow a deeper one — e.g.
            // /contract/{QUERY} must NOT match /contract/{QUERY}/state (which would
            // otherwise make the /state and /state/{TYPE} routes unreachable).
            // The 5th-segment literal must also match when the route declares one
            // (e.g. .../state vs .../balance) — without this, two same-length routes
            // sharing parts[1]/parts[2] are indistinguishable and the first-defined
            // one wins, shadowing the other (the /balance route was unreachable).
            } else if(!match && parts.length==urlPath.length && parts[1]==String(urlPath[1]).toLowerCase() &&
                parts[2]==String(urlPath[2]).toLowerCase() &&
                (this.util.isNull(parts[4]) || String(parts[4]).startsWith('{') || String(parts[4]).toLowerCase()==String(urlPath[4]).toLowerCase())){
                // Handle exact explorer matches without any search type
                if(cfg.type=='explorer' && urlPath.length==3)
                    match = true;
                // Handle setting search type
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

            // Update config object with request info
            if(match){
                if(cfg.type=='html')
                    cfg.file = info;
                if(['api','explorer'].includes(cfg.type)){
                    cfg.data.method = info[0];
                    cfg.data.search = urlPath[3];
                    cfg.data.type   = searchType;
                    // Set additional offset information used in explorer paging
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

        // If we have a method defined to get some data, retrieve the requested data from the database
        if(!this.util.isNull(cfg.data.method) && validDataRequest){
            [data, total] = await this.db.getData(cfg);

            // Placeholder for the JSON response object
            let json = {};

            // If we have a total then we are dealing with results, so get only the results we want to return
            if(this.util.isNumeric(total)){
                if(cfg.type=='api'){
                    // Return total number of records found
                    json.total = total;

                    // Handle pushing some data to the top level of the JSON response
                    // Note: we do this so we don't pass these fields in the data array since they are all the same values
                    if(cfg.data.method=='getHolders'){
                        let info = data[0];
                        json.tick       = info.tick;
                        json.supply     = info.supply;
                        json.decimals   = info.decimals;
                        json.coin_price = info.coin_price;
                    }
                }
                // Return total number of records found in format that datatables expects (https://datatables.net/manual/server-side#Returned-data)
                if(cfg.type=='explorer'){
                    // If a total number of records was passed in the request, use it as total
                    if(cfg.data.query.total)
                        total = cfg.data.query.total
                    json.recordsTotal    = total;
                    json.recordsFiltered = total;
                }
                json.data  = this.getPagingDataResults(cfg, data, total);
            } else {
                // Merge the data into the JSON response object
                json = data;
            }

            // Special case JSON customizations based on method called
            if(cfg.data.method=='getBalances')
                json.address = cfg.data.search;
            if(cfg.data.method=='getSearch'){
                delete data.data;
                json = Object.assign({}, json, data);
            }

            // Sort the json data and object properties alphabetically (OCD much?)
            if(cfg.type=='api' && !this.util.isNull(json)){
                json = this.util.ksort(json);
                for(let idx in json.data)
                    json.data[idx] = this.util.ksort(json.data[idx]);
            }

            // Store the response JSON in the response object
            response.json = json;
        }

        // If we don't have a file or method at this point, default to a 404
        if(this.util.isNull(cfg.file) && this.util.isNull(cfg.data.method)){
            cfg.file = '404.html';
            cfg.type = 'html';
            response.code = 404;
        }

        // If this is not a valid data request, return a '503 - Service Unavailable' response
        if(['api','explorer'].includes(cfg.type) && !this.util.isNull(cfg.data.method) && !validDataRequest){
            response.code = 503;
            response.json = {
                error: 'Explorer not configured to support data requests for this coin.',
                code: 'COIN_NOT_AVAILABLE'
            };
        }

        // If we have no data and no total, return a '400 - Bad Request' response
        else if(['api','explorer'].includes(cfg.type) && this.util.isNull(data) && this.util.isNull(total)){
            response.code = 400;
            response.json = {
                error: 'Explorer was unable to successfully process your request.',
                code: 'BAD_REQUEST'
            };
        }

        /**********************************************************
         * HTML page handler
         *********************************************************/
        if(cfg.type=='html'){
            // Define base path to html directory
            let htmlDirectory   = path.join(__dirname, 'content/html/')

            // Load HTML template
            let templateFile    = path.join(htmlDirectory, 'template.html');
            let templateExists  = await this.util.fileExists(templateFile);
            let templateContent = (templateExists) ? await this.util.fileGetContents(templateFile) : 'Error loading template file!';

            // Load HTML content
            let htmlFile    = path.join(htmlDirectory, cfg.file);
            let htmlExists  = await this.util.fileExists(htmlFile);
            let htmlContent = (htmlExists) ? await this.util.fileGetContents(htmlFile) : 'Error loading html file!';

            // Swap Content into template
            let pageContent = templateContent;
            pageContent     = pageContent.replace('{CONTENT}',htmlContent);

            // Store HTML response
            response.html = pageContent;
        }

        // Log the total processing time for this request (in milliseconds)
        response.time = this.util.getTimer(debugTimer);

        // Pass forward the total runtime info in a readable string in the JSON response
        if(response.json)
            response.json.runtime = this.util.getTimerString(response.time);

        // Set any custom headers
        response.head = structuredClone(this.headers);

        if(process.env.DEBUG && !this.util.isNull(response.time))
            response.head['XChain-Runtime-Ms'] = response.time;

        // Return any custom headers in response
        if(!this.util.isNull(response.head))
            res.set(response.head);

        // Return HTTP status Code
        res.status(response.code);

        // Return the actual response
        if(!this.util.isNull(response.json)){
            res.type('json').send(this.util.jsonStringify(response.json));
        } else if(!this.util.isNull(response.html)){
            res.send(response.html);
        } else {
            res.send('response of last resort...');
        }

        // Log any requests which took longer than 400 milliseconds to return a response
        if(response.time > 400){
            slowRequests++;
            console.warn('SLOW_REQUEST', req.path, response.time + 'ms');
        }

        // DEBUG INFO (only log when DEBUG env var is set)
        if(process.env.DEBUG){
            console.log('--- REQUEST CONFIG ---');
            console.dir(cfg, {
                colors: true,
                depth: 3
            });
        }
    }

    // Handle looping through database results and only returning the records the user cares about using paging and limit
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

        // Clamp pagination values to safe ranges
        start  = Math.max(0, Number(start));
        limit  = Math.max(1, Math.min(Number(limit), max));
        length = Math.max(1, Number(length));

        // Update the data object to be the search results data
        if(method=='getSearch')
            data = data.data;

        // For API requests, SQL OFFSET already handled pagination — return all rows
        if(cfg.type=='api'){
            start = 0;
        }
        // Set limit based on given length and start params
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

            // Tweak count since we reverse results in some cases
            if(['prev','last'].includes(action))
                count = this.util.bcadd(start,this.util.bcsub(data.length, this.util.bcsub(idx, 1)),0);

            // Stash the reverse count since latest is first in most cases
            count_reverse = this.util.bcsub(total,this.util.bcsub(count, 1),0);

            // Display only the results we care about showing
            if((cnt > start && cnt <= limit) || offset){
                let info   = data[idx-1];
                // For API requests, pass fields in the correct place
                if(type=='api'){
                    // Only pass address and amount for holders (token data is already passed at the top level)
                    if(method=='getHolders'){
                        info = {
                            'address': info.address,
                            'amount':  info.amount
                        };
                    }
                }
                // For Explorer requests, pass array of fields in specific order
                if(type=='explorer'){
                    let status = (info.status=='valid') ? 1 : 0; // 1=valid, 2=invalid
                    let percent = 0;                             // Percentage of total supply
                    let value   = 0;                             // Estimated value
                    let amount  = 0;                             // Amount formatted to correct decimal precision

                    // Handle building out locks info into nice string
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

                    // Handle building out action count info into a nice string (reduces data sent back and forth)
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

                    // Handle calculating amounts, percentages of supply, and estimated value
                    if(['getBalances','getHolders'].includes(method)){
                        // Force amount to display in coin decimal precision
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
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.callback_amount, info.memo, status, info.action_index];
                    if(method=='getDispensers')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, status, info.action_index, info.give_ownership];
                    if(method=='getDispenses')
                        info = [count_reverse, info.block_index, info.timestamp, info.destination, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, status, info.action_index];
                    if(method=='getDividends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.dividend_tick, info.amount, status, info.action_index];
                    if(method=='getFees')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.method, info.action, info.action_index];
                    if(method=='getFiles')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.name, info.type, info.title, info.gate_ticker, status, info.action_index];
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
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, status, info.action_index, info.give_ownership, info.get_ownership];
                    if(method=='getSends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
                    if(method=='getSleeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.tick, info.resume_block, status, info.action_index];
                    if(method=='getSwaps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, status, info.action_index, info.give_ownership, info.get_ownership];
                    if(method=='getSweeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.balances, info.ownerships, info.orders, info.swaps, info.dispensers, status, info.action_index];
                    // NOTE: decimals sits BEFORE the trailing id — the datatables client
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
                    // Capability staking list pages
                    if(['getStakes','getValidators'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, status, info.action_index, info.activation_block, info.deactivation_block];
                    if(method=='getDelegations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, status, info.action_index];
                    if(method=='getValidatorRewards')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.reward_type, info.amount, info.id];
                    // Contract-targeted staking list pages
                    if(method=='getContractStakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.version, status, info.action_index];
                    if(method=='getContractUnstakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.cooldown_end_block, status, info.action_index];
                    if(method=='getSlashEvents')
                        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.target_contract_index, info.tick, info.amount, info.destination, info.execution_index];
                    // Attestation list page
                    if(method=='getAttestations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.provider_id, info.request_id, info.request_status, info.response_status, status, info.action_index, info.payload, info.callback_params_json, info.fee_payer];
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

                // Add data to the response array
                show.push(info);

            }
        }

        // Reverse the results if action is previous or last
        if(['prev','last'].includes(action))
            show = show.reverse();

        // Return the data we want to show
        return show;
    }

    /**********************************************************
     * ICON request handler
     *********************************************************/
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
     * FILE content — raw bytes
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
     * type is honored INLINE only for safe media types — on-chain
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
            // Gated file first — ciphertext is served exactly as before
            let rows = await this.db.getGatedFileRaw(config, actionIndex);
            if(rows && rows.length > 0) raw = rows[0].raw_data;
            // Fall through to the non-gated FILE bytes (decoder DB)
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
            // Gated ciphertext — opaque bytes
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

    // GET /{COIN}/api/checkpoints[?limit=N] — latest quorum-signed state checkpoints
    // for this coin's chain, from the hub-mirrored state_checkpoints table.
    async processCheckpointsRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let limit = Math.min(parseInt(req.query.limit) || 10, 100);
            let rows = await this.db.getCheckpointRows({ coin, data: {} }, null, limit);
            return res.json({ checkpoints: rows || [], count: (rows || []).length });
        } catch (e) {
            console.error('processCheckpointsRequest error:', e);
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    }

    // GET /{COIN}/api/checkpoint/{blockIndex}/verify — re-verify the checkpoint at a
    // height against the mirrored oracle_publish capability snapshot. Returns the
    // canonical signing string + qualifying validator set so a client can ALSO
    // verify independently rather than trusting this server's `verified` flag.
    async processCheckpointVerifyRequest(req, res){
        try {
            let coin = String(req.params.coin || '').toUpperCase();
            if(!this.db.pools || !this.db.pools[coin])
                return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
            let blockIndex = req.params.blockIndex;
            if(!/^[0-9]+$/.test(String(blockIndex)))
                return res.status(400).json({ error: 'Invalid block_index', code: 'INVALID_BLOCK_INDEX' });
            let config = { coin, data: {} };
            let rows = await this.db.getCheckpointRows(config, Number(blockIndex), 1);
            if(!rows || rows.length === 0)
                return res.status(404).json({ error: 'No checkpoint at this height', code: 'CHECKPOINT_NOT_FOUND' });
            let cp = rows[0];

            // Canonical signing string — byte-identical to the hub engine + ANCHOR verifier.
            let canonical = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                             cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                             String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');

            let validators = await this.db.getCapabilitySnapshotRows(config, 'oracle_publish', cp.snapshot_block) || [];
            let qualified  = new Set(validators.map(v => String(v.signing_pubkey).toLowerCase()));
            let quorum     = (qualified.size <= 1) ? 1 : Math.max(2 * Math.floor((qualified.size - 1) / 3) + 1, Math.ceil((qualified.size + 1) / 2));

            let sigs = [];
            try { sigs = JSON.parse(cp.validator_signatures || '[]'); } catch(e){ sigs = []; }
            let validSigs = 0, seen = new Set();
            for(let s of sigs){
                let pk  = String(s && s.pubkey || '').toLowerCase();
                let sig = String(s && s.sig || '');
                if(!pk || seen.has(pk) || !qualified.has(pk)) continue;
                seen.add(pk);
                if(this.util.ed25519Verify(canonical, sig, pk)) validSigs++;
            }

            return res.json({
                checkpoint:    cp,
                canonical:     canonical,
                validators:    validators.map(v => String(v.signing_pubkey).toLowerCase()),
                quorum:        quorum,
                valid_sigs:    validSigs,
                verified:      (qualified.size > 0 && validSigs >= quorum),
                // qualified.size === 0 → the oracle_publish snapshot isn't mirrored
                // here; the sigs may still be valid (clients can verify elsewhere).
                snapshot_available: qualified.size > 0
            });
        } catch (e) {
            console.error('processCheckpointVerifyRequest error:', e);
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
                return res.status(503).json({ error: 'native fee pre-flight unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
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
                return res.status(503).json({ error: 'fee schedule unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            let connector = new IndexerConnector(url);
            return res.json(await connector.feeschedule());
        } catch(e){
            console.error('processFeeScheduleRequest error:', e.message || e);
            return res.status(502).json({ error: 'fee schedule upstream error', code: 'UPSTREAM_ERROR' });
        }
    }

    /**********************************************************
     * RELAY request handler
     *
     * Notes :
     * - All content can be delivered via https/ssl (doesn't break browser SSL lock)
     * - Most .json files do not pass Access-Control-Allow-Origin header (xhr refuses to make request)
     *********************************************************/
    // SSRF guard helper: classify a resolved IP literal as a private, loopback,
    // link-local or cloud-metadata address that the /relay endpoint must refuse
    // to connect to. IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped first so a
    // mapped private v4 can't slip through.
    _isPrivateAddress(ip){
        let addr = String(ip).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
        return [
            /^127\./, /^0\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
            /^192\.168\./, /^169\.254\./,
            /^::1$/, /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/i,
        ].some(r => r.test(addr));
    }

    // SSRF guard: a dns.lookup-compatible shim handed to axios so the address it
    // is about to connect to is checked against _isPrivateAddress. Rejecting here
    // (rather than re-resolving separately) means there is no gap between the
    // check and the connection — closing the DNS-name / DNS-rebinding bypass of
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
        // Only proceed if we were passed a URL
        if(!this.util.isNull(req.query.url)){
            try {
                // Parse and validate the URL
                const parsed = new URL(req.query.url);

                // Only allow http and https protocols
                if(!['http:', 'https:'].includes(parsed.protocol))
                    return res.status(400).json({ error: 'Invalid protocol', code: 'RELAY_INVALID_PROTOCOL' });

                // Block private/loopback/metadata IP ranges to prevent SSRF
                // Note: Node's URL parser wraps IPv6 in brackets (e.g. [::1]), so strip them for matching
                const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
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
                // The literal-hostname blocklist above only catches IPs written
                // directly in the URL. A normal domain whose DNS A/AAAA record
                // points at a private/metadata address (or rebinds between checks)
                // would sail past it, so also validate the address axios actually
                // connects to via a custom lookup — no separate re-resolution, so
                // no TOCTOU window.
                const opts = { timeout: 5000, maxContentLength: 5 * 1024 * 1024, maxRedirects: 0,
                               lookup: this._ssrfSafeLookup.bind(this) };

                // Handle JSON files (also accept arweave.net gateway URLs without a .json extension)
                const isArweave = /^arweave\.net$/i.test(parsed.hostname);
                if(ext=='json' || isArweave){
                    let response = await axios.get(parsed.href, opts);
                    if(!this.util.isNull(response.data)){
                        res.type('json').send(this.util.jsonStringify(response.data));
                        return;
                    }
                }

                // Handle PNG images
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
        // Return `503 - Service Unavailable` error message as last resort
        res.status(503).json({ error: 'service not available', code: 'SERVICE_UNAVAILABLE' });
    }

    static getSlowRequests() { return slowRequests; }
}

module.exports = XChainExplorer;
