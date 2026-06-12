#!/usr/bin/env node
/*
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Licensed under the GNU Affero GPL v3.0 or later; see LICENSE.md.
 * A commercial license is available — contact legal@dankest.llc.
 *
 * Generates docs/openapi.json (OpenAPI 3.1) for the explorer's public REST API.
 *
 * ROUTES below deliberately mirrors the `api` table in src/XChainExplorer.js
 * key-for-key (same path templates, same {TYPE} enums) plus the special
 * pre-wildcard routes registered in setupUrls(). The unit test
 * test/unit/openapi-coverage.test.js fails if the two drift apart, so edits to
 * either side must land together. The /{COIN}/explorer/* datatable routes are
 * an internal surface for the web UI and are intentionally NOT documented.
 *
 * Run: node docs/openapi.build.js   (regenerates docs/openapi.json in place)
 */
const fs = require('fs');
const path = require('path');

const COINS = ['BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC', 'DOGE', 'TDOGE', 'RDOGE'];

// path, db method, {TYPE} enum (array) / fixed QUERY kind (string) / none, tag, summary
const ROUTES = [
    // ── Action history ────────────────────────────────────────────────────
    ['/{COIN}/api/addresses/{QUERY}/{TYPE}', 'getAddresses', ['block', 'address'], 'Action history', 'ADDRESS actions (address registrations)'],
    ['/{COIN}/api/airdrops/{QUERY}/{TYPE}', 'getAirdrops', ['block', 'address', 'token'], 'Action history', 'AIRDROP actions'],
    ['/{COIN}/api/batches/{QUERY}/{TYPE}', 'getBatches', ['block', 'address'], 'Action history', 'BATCH actions'],
    ['/{COIN}/api/broadcasts/{QUERY}/{TYPE}', 'getBroadcasts', ['block', 'address'], 'Action history', 'BROADCAST actions'],
    ['/{COIN}/api/callbacks/{QUERY}/{TYPE}', 'getCallbacks', ['block', 'address', 'token'], 'Action history', 'CALLBACK actions'],
    ['/{COIN}/api/destroys/{QUERY}/{TYPE}', 'getDestroys', ['block', 'address', 'token'], 'Action history', 'DESTROY actions (token burns)'],
    ['/{COIN}/api/dividends/{QUERY}/{TYPE}', 'getDividends', ['block', 'address', 'token'], 'Action history', 'DIVIDEND actions'],
    ['/{COIN}/api/dispensers/{QUERY}/{TYPE}', 'getDispensers', ['block', 'address', 'source', 'destination', 'token'], 'Dispensers', 'DISPENSER actions (vending machines)'],
    ['/{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}', 'getDispenserCancels', ['block', 'address'], 'Dispensers', 'Dispenser cancellations'],
    ['/{COIN}/api/dispenser_closes/{QUERY}/{TYPE}', 'getDispenserCloses', ['block', 'address'], 'Dispensers', 'Dispenser closes'],
    ['/{COIN}/api/dispenser_expires/{QUERY}/{TYPE}', 'getDispenserExpires', ['block', 'address'], 'Dispensers', 'Dispenser expirations'],
    ['/{COIN}/api/dispenser_edits/{QUERY}/{TYPE}', 'getDispenserEdits', ['block', 'address'], 'Dispensers', 'Dispenser edits'],
    ['/{COIN}/api/dispenses/{QUERY}/{TYPE}', 'getDispenses', ['block', 'address', 'source', 'destination', 'token'], 'Dispensers', 'Dispenses (vending events: coin in, tokens out)'],
    ['/{COIN}/api/fees/{QUERY}/{TYPE}', 'getFees', ['block', 'address', 'source', 'destination', 'token'], 'Action history', 'Protocol fee payments'],
    ['/{COIN}/api/files/{QUERY}/{TYPE}', 'getFiles', ['block', 'address', 'token'], 'Files', 'FILE actions (on-chain files, incl. token-gated)'],
    ['/{COIN}/api/issues/{QUERY}/{TYPE}', 'getIssues', ['block', 'address', 'token'], 'Tokens', 'ISSUE actions (token issuances)'],
    ['/{COIN}/api/links/{QUERY}/{TYPE}', 'getLinks', ['block', 'address'], 'Action history', 'LINK actions'],
    ['/{COIN}/api/lists/{QUERY}/{TYPE}', 'getLists', ['block', 'address'], 'Action history', 'LIST actions'],
    ['/{COIN}/api/messages/{QUERY}/{TYPE}', 'getMessages', ['block', 'address', 'source', 'destination'], 'Action history', 'MESSAGE actions (encrypted messaging)'],
    ['/{COIN}/api/mints/{QUERY}/{TYPE}', 'getMints', ['block', 'address', 'source', 'destination', 'token'], 'Tokens', 'MINT actions'],
    ['/{COIN}/api/orders/{QUERY}/{TYPE}', 'getOrders', ['block', 'address', 'token'], 'Markets', 'ORDER actions (DEX orders)'],
    ['/{COIN}/api/order_expires/{QUERY}/{TYPE}', 'getOrderExpires', ['block', 'address'], 'Markets', 'Order expirations'],
    ['/{COIN}/api/order_edits/{QUERY}/{TYPE}', 'getOrderEdits', ['block', 'address'], 'Markets', 'Order edits'],
    ['/{COIN}/api/order_cancels/{QUERY}/{TYPE}', 'getOrderCancels', ['block', 'address'], 'Markets', 'Order cancellations'],
    ['/{COIN}/api/order_matches/{QUERY}/{TYPE}', 'getOrderMatches', ['block'], 'Markets', 'Order matches (fills)'],
    ['/{COIN}/api/coinpays/{QUERY}/{TYPE}', 'getCoinpays', ['block', 'address'], 'Markets', 'COINPAY actions (native-coin payment legs)'],
    ['/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}', 'getCoinpayExpires', ['block', 'address'], 'Markets', 'COINPAY expirations'],
    ['/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}', 'getCoinpayObligations', ['block', 'address'], 'Markets', 'Open COINPAY obligations'],
    ['/{COIN}/api/sends/{QUERY}/{TYPE}', 'getSends', ['block', 'address', 'source', 'destination', 'token'], 'Action history', 'SEND actions (token transfers)'],
    ['/{COIN}/api/sleeps/{QUERY}/{TYPE}', 'getSleeps', ['block', 'address', 'token'], 'Action history', 'SLEEP actions'],
    ['/{COIN}/api/swaps/{QUERY}/{TYPE}', 'getSwaps', ['block', 'address', 'token'], 'Markets', 'SWAP actions (peer-to-peer swaps)'],
    ['/{COIN}/api/swap_edits/{QUERY}/{TYPE}', 'getSwapEdits', ['block', 'address'], 'Markets', 'Swap edits'],
    ['/{COIN}/api/swap_expires/{QUERY}/{TYPE}', 'getSwapExpires', ['block', 'address'], 'Markets', 'Swap expirations'],
    ['/{COIN}/api/swap_cancels/{QUERY}/{TYPE}', 'getSwapCancels', ['block', 'address'], 'Markets', 'Swap cancellations'],
    ['/{COIN}/api/swap_matches/{QUERY}/{TYPE}', 'getSwapMatches', ['block'], 'Markets', 'Swap matches'],
    ['/{COIN}/api/sweeps/{QUERY}/{TYPE}', 'getSweeps', ['block', 'address', 'source', 'destination'], 'Action history', 'SWEEP actions'],
    // ── Prices ────────────────────────────────────────────────────────────
    ['/{COIN}/api/prices/{QUERY}/{TYPE}', 'getPrices', ['block', 'address', 'source', 'token'], 'Prices', 'PRICE oracle rows, filtered'],
    ['/{COIN}/api/prices', 'getPrices', null, 'Prices', 'PRICE oracle rows (validator COIN/FIAT + user TOKEN/FIAT)'],
    ['/{COIN}/api/price_snapshots/{QUERY}/{TYPE}', 'getPriceSnapshots', ['pair', 'round', 'status'], 'Prices', 'Federation price snapshots, filtered'],
    ['/{COIN}/api/price_snapshots', 'getPriceSnapshots', null, 'Prices', 'Federation price snapshots (PBFT-finalized rounds)'],
    // ── Contracts ─────────────────────────────────────────────────────────
    ['/{COIN}/api/contracts/{QUERY}/{TYPE}', 'getContracts', ['block', 'address', 'source'], 'Contracts', 'Deployed contracts, filtered'],
    ['/{COIN}/api/contracts', 'getContracts', null, 'Contracts', 'Deployed smart contracts'],
    ['/{COIN}/api/contract/{QUERY}', 'getContract', 'contract', 'Contracts', 'One contract (by action index)'],
    ['/{COIN}/api/contract/{QUERY}/state', 'getContractState', 'contract', 'Contracts', 'Contract state (all keys)'],
    ['/{COIN}/api/contract/{QUERY}/state/{TYPE}', 'getContractState', 'contract', 'Contracts', 'Contract state (one key)'],
    ['/{COIN}/api/contract/{QUERY}/balance', 'getContractBalance', 'contract', 'Contracts', 'Contract token balances'],
    ['/{COIN}/api/contract/{QUERY}/balance/{TYPE}', 'getContractBalance', 'contract', 'Contracts', 'Contract balance (one tick)'],
    ['/{COIN}/api/executions/{QUERY}/{TYPE}', 'getExecutions', ['block', 'address', 'contract'], 'Contracts', 'Contract executions, filtered'],
    ['/{COIN}/api/executions', 'getExecutions', null, 'Contracts', 'Contract executions'],
    ['/{COIN}/api/execution/{QUERY}', 'getExecution', 'execution', 'Contracts', 'One execution (by action index)'],
    ['/{COIN}/api/deposits/{QUERY}/{TYPE}', 'getDeposits', ['block', 'address', 'source', 'contract'], 'Contracts', 'Contract deposits'],
    ['/{COIN}/api/withdrawals/{QUERY}/{TYPE}', 'getWithdrawals', ['block', 'address', 'source', 'contract'], 'Contracts', 'Contract withdrawals'],
    // ── Staking ───────────────────────────────────────────────────────────
    ['/{COIN}/api/stakes/{QUERY}/{TYPE}', 'getStakes', ['block', 'address', 'source'], 'Staking', 'Capability stakes, filtered'],
    ['/{COIN}/api/stakes', 'getStakes', null, 'Staking', 'Capability stakes (validator staking)'],
    ['/{COIN}/api/validators', 'getValidators', null, 'Staking', 'Active validators and their capabilities'],
    ['/{COIN}/api/delegations/{QUERY}/{TYPE}', 'getDelegations', ['block', 'address', 'source'], 'Staking', 'Signing-key delegations'],
    ['/{COIN}/api/rewards/{QUERY}/{TYPE}', 'getValidatorRewards', ['address', 'source'], 'Staking', 'Validator rewards (oracle/anchor/attestation)'],
    ['/{COIN}/api/contract_stakes/{QUERY}/{TYPE}', 'getContractStakes', ['block', 'address', 'contract'], 'Staking', 'Contract-targeted stakes, filtered'],
    ['/{COIN}/api/contract_stakes', 'getContractStakes', null, 'Staking', 'Contract-targeted stakes (STAKE v3)'],
    ['/{COIN}/api/contract_unstakes/{QUERY}/{TYPE}', 'getContractUnstakes', ['block', 'address', 'contract'], 'Staking', 'Contract unstakes, filtered'],
    ['/{COIN}/api/contract_unstakes', 'getContractUnstakes', null, 'Staking', 'Contract unstakes (UNSTAKE v1)'],
    ['/{COIN}/api/contract_delegations/{QUERY}/{TYPE}', 'getContractDelegations', ['block', 'address', 'contract'], 'Staking', 'Contract-stake delegations, filtered'],
    ['/{COIN}/api/contract_delegations', 'getContractDelegations', null, 'Staking', 'Contract-stake delegations'],
    ['/{COIN}/api/slash_events/{QUERY}/{TYPE}', 'getSlashEvents', ['block', 'address', 'contract'], 'Staking', 'Slash events, filtered'],
    ['/{COIN}/api/slash_events', 'getSlashEvents', null, 'Staking', 'Slash events'],
    // ── Cross-chain ───────────────────────────────────────────────────────
    ['/{COIN}/api/cross_chain_matches/{QUERY}/{TYPE}', 'getCrossChainMatches', ['match', 'block', 'status'], 'Cross-chain', 'Cross-chain order matches, filtered'],
    ['/{COIN}/api/cross_chain_matches', 'getCrossChainMatches', null, 'Cross-chain', 'Cross-chain order matches (hub-replicated)'],
    ['/{COIN}/api/cross_chain_settlements/{QUERY}/{TYPE}', 'getCrossChainSettlements', ['match', 'block'], 'Cross-chain', 'Cross-chain settlement legs, filtered'],
    ['/{COIN}/api/cross_chain_settlements', 'getCrossChainSettlements', null, 'Cross-chain', 'Cross-chain settlement legs'],
    // ── Attestations ──────────────────────────────────────────────────────
    ['/{COIN}/api/attestations/{QUERY}/{TYPE}', 'getAttestations', ['block', 'address', 'contract'], 'Attestations', 'ATTEST requests/responses, filtered'],
    ['/{COIN}/api/attestations', 'getAttestations', null, 'Attestations', 'ATTEST v0 requests + v1 responses (incl. LLM attestations)'],
    // ── Core ──────────────────────────────────────────────────────────────
    ['/{COIN}/api/status', 'getStatus', null, 'Network', 'Explorer status + chain config'],
    ['/{COIN}/api/actions', 'getActions', null, 'Core', 'Recent actions (all types)'],
    ['/{COIN}/api/action/{QUERY}', 'getAction', 'action_index', 'Core', 'One action with full decoded data (by action index)'],
    ['/{COIN}/api/address/{QUERY}', 'getAddress', 'address', 'Core', 'Address summary'],
    ['/{COIN}/api/balances/{QUERY}', 'getBalances', 'address', 'Core', 'Token balances for an address'],
    ['/{COIN}/api/block/{QUERY}', 'getBlock', 'block', 'Core', 'Block summary (by height or hash)'],
    ['/{COIN}/api/credits/{QUERY}/{TYPE}', 'getCredits', ['block', 'address'], 'Core', 'Ledger credits'],
    ['/{COIN}/api/debits/{QUERY}/{TYPE}', 'getDebits', ['block', 'address'], 'Core', 'Ledger debits'],
    ['/{COIN}/api/escrows/{QUERY}/{TYPE}', 'getEscrows', ['block', 'address'], 'Core', 'Escrowed balances (orders/swaps/dispensers)'],
    ['/{COIN}/api/history/{QUERY}/{TYPE}', 'getHistory', ['block', 'address', 'token'], 'Core', 'Combined action history'],
    ['/{COIN}/api/holders/{QUERY}', 'getHolders', 'token', 'Tokens', 'Holders of a token'],
    ['/{COIN}/api/mempool/{QUERY}/{TYPE}', 'getMempool', ['address', 'token'], 'Core', 'Unconfirmed (mempool) actions from the decoder — PRE-VALIDATION: the indexer may still reject them; rows carry the raw decoded action string in `data` for clients to parse'],
    ['/{COIN}/api/network', 'getNetwork', null, 'Network', 'Network statistics'],
    ['/{COIN}/api/pubkey/{QUERY}', 'getPublicKey', 'address', 'Core', 'Known public key for an address'],
    ['/{COIN}/api/project/{QUERY}', 'getProject', 'token', 'Tokens', 'Project registry roster (official tokens of a project tick)'],
    ['/{COIN}/api/token/{QUERY}', 'getToken', 'token', 'Tokens', 'Token detail (supply, info, NFT/registry surfaces)'],
    ['/{COIN}/api/tokens/{QUERY}/{TYPE}', 'getTokens', ['block', 'address', 'token', 'subtoken', 'nft'], 'Tokens', 'Token search (type nft = unique tokens only)'],
    ['/{COIN}/api/transaction/{QUERY}/{TYPE}', 'getTransaction', ['tx_hash', 'tx_index'], 'Core', 'Transaction lookup'],
    // ── Markets ───────────────────────────────────────────────────────────
    ['/{COIN}/api/markets', 'getMarkets', null, 'Markets', 'All trading pairs'],
    ['/{COIN}/api/markets/{TICK1}', 'getMarkets', null, 'Markets', 'Trading pairs for one tick'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}', 'getMarket', null, 'Markets', 'Market summary for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/history', 'getMarketHistory', null, 'Markets', 'Trade history for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/history/{ADDRESS}', 'getMarketHistory', null, 'Markets', 'Trade history for a pair, one address'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orders', 'getMarketOrders', null, 'Markets', 'Open orders for a pair'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orders/{ADDRESS}', 'getMarketOrders', null, 'Markets', 'Open orders for a pair, one address'],
    ['/{COIN}/api/market/{TICK1}/{TICK2}/orderbook', 'getOrderbook', null, 'Markets', 'Aggregated order book for a pair'],
];

// Pre-wildcard routes registered directly on the Express app in setupUrls().
const SPECIAL = [
    ['/{COIN}/api/file/{ACTION_INDEX}/raw', 'Files', 'Raw FILE bytes (gated: ciphertext as octet-stream; non-gated: inline for safe media types)'],
    ['/{COIN}/api/feequote', 'Fees', 'Native-coin protocol fee pre-flight quote (proxied from the indexer)'],
    ['/{COIN}/api/feeschedule', 'Fees', 'Fee schedule + oracle prices (proxied from the indexer)'],
    ['/{COIN}/api/checkpoints', 'Checkpoints', 'Latest quorum-signed state checkpoints for this chain'],
    ['/{COIN}/api/checkpoint/{BLOCK_INDEX}/verify', 'Checkpoints', 'Verify a checkpoint: 2f+1 signatures, canonical string, validator set'],
];

const QUERY_DESC = {
    block: 'block height', address: 'an XChain address', source: 'source address',
    destination: 'destination address', token: 'a token tick', contract: 'contract action index',
    execution: 'execution action index', action_index: 'action index', match: 'cross-chain match id',
    pair: 'COIN/FIAT pair (e.g. BTC/USD)', round: 'oracle round id', status: 'lifecycle status',
    subtoken: 'parent tick (returns its sub-tokens)', nft: 'NFT filter', recent: 'recent rows',
    tx_hash: 'transaction hash', tx_index: 'transaction index',
};

function opId(p) {
    return p.replace('/{COIN}/api/', '').replace(/[{}]/g, '').replace(/[\/]+/g, '_').toLowerCase() || 'root';
}
function pathParams(p, types) {
    const params = [{ $ref: '#/components/parameters/coin' }];
    if (p.includes('{QUERY}')) {
        const kinds = Array.isArray(types) ? types : [types];
        params.push({
            name: 'QUERY', in: 'path', required: true, schema: { type: 'string' },
            description: 'The value to look up — interpreted per {TYPE}: ' +
                kinds.filter(Boolean).map((t) => `${t} = ${QUERY_DESC[t] || t}`).join('; '),
        });
    }
    if (p.includes('{TYPE}'))
        params.push({
            name: 'TYPE', in: 'path', required: true,
            schema: { type: 'string', enum: types },
            description: 'How to interpret {QUERY}',
        });
    for (const extra of ['TICK1', 'TICK2', 'ADDRESS', 'ACTION_INDEX', 'BLOCK_INDEX'])
        if (p.includes(`{${extra}}`))
            params.push({ name: extra, in: 'path', required: true, schema: { type: 'string' } });
    return params;
}
const LIST_METHODS_SINGLE = new Set(['getAction', 'getAddress', 'getBlock', 'getToken', 'getProject',
    'getContract', 'getContractState', 'getContractBalance', 'getExecution', 'getPublicKey',
    'getStatus', 'getNetwork', 'getMarket', 'getOrderbook', 'getTransaction', 'getSearch']);

function operation([p, method, types, tag, summary]) {
    const isList = !LIST_METHODS_SINGLE.has(method);
    const params = pathParams(p, types);
    if (isList) params.push(
        { $ref: '#/components/parameters/page' },
        { $ref: '#/components/parameters/limit' },
        { $ref: '#/components/parameters/sortorder' });
    return {
        get: {
            operationId: opId(p), tags: [tag], summary,
            parameters: params,
            responses: {
                200: {
                    description: 'OK',
                    content: {
                        'application/json': {
                            schema: { $ref: isList ? '#/components/schemas/ListResponse' : '#/components/schemas/ObjectResponse' },
                        },
                    },
                },
                400: { $ref: '#/components/responses/BadRequest' },
                404: { $ref: '#/components/responses/NotFound' },
                503: { $ref: '#/components/responses/CoinUnavailable' },
            },
        },
    };
}

const paths = {};
for (const r of ROUTES) paths[r[0]] = operation(r);
for (const [p, tag, summary] of SPECIAL) {
    paths[p] = operation([p, 'special_' + opId(p), null, tag, summary]);
    paths[p]['x-registered'] = 'express';   // direct app.get(), not the urls.api table
}

const spec = {
    openapi: '3.1.0',
    info: {
        title: 'XChain Explorer API',
        version: '1.0.0',
        description: 'Read-only REST API for the XChain Platform — tokens, balances, actions, '
            + 'markets, smart contracts, staking, attestations, and state checkpoints on '
            + 'Bitcoin, Litecoin, and Dogecoin.\n\n'
            + 'Conventions: `coin` is the host chain, `tick` is a token symbol (there is no '
            + '"asset" field). Amounts are arbitrary-precision decimal strings. List responses '
            + 'are `{total, data: [...]}` with `page`/`limit`/`sortorder` query parameters '
            + '(limit max 100; balances/holders max 500). Errors are '
            + '`{error: "message", code: "STABLE_CODE"}` — see the error-code registry at '
            + 'https://docs.xchain.io/protocol/Error_Codes.md. A WebSocket API lives at '
            + '/{COIN}/api/websocket — see https://docs.xchain.io/components/explorer/WEBSOCKET.md.\n\n'
            + 'LLM-friendly docs: https://docs.xchain.io/llms.txt',
        license: { name: 'AGPL-3.0-or-later', url: 'https://docs.xchain.io/legal/LICENSING.md' },
    },
    servers: [{ url: 'https://explorer.xchain.io' }],
    tags: [
        { name: 'Core' }, { name: 'Tokens' }, { name: 'Action history' }, { name: 'Markets' },
        { name: 'Dispensers' }, { name: 'Contracts' }, { name: 'Staking' }, { name: 'Prices' },
        { name: 'Attestations' }, { name: 'Cross-chain' }, { name: 'Files' }, { name: 'Fees' },
        { name: 'Checkpoints' }, { name: 'Network' },
    ],
    paths,
    components: {
        parameters: {
            coin: {
                name: 'COIN', in: 'path', required: true,
                schema: { type: 'string', enum: COINS },
                description: 'Chain + network: BTC/LTC/DOGE mainnet; T prefix = testnet, R prefix = regtest',
            },
            page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: 'Page number' },
            limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 10 }, description: 'Rows per page (max 100; balances/holders max 500)' },
            sortorder: { name: 'sortorder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] }, description: 'Sort order' },
        },
        schemas: {
            ListResponse: {
                type: 'object',
                properties: {
                    total: { type: 'integer', description: 'Total matching rows' },
                    data: { type: 'array', items: { type: 'object' }, description: 'Result rows (fields vary per endpoint; amounts are decimal strings)' },
                },
                required: ['total', 'data'],
            },
            ObjectResponse: { type: 'object', description: 'Single result object (fields vary per endpoint; amounts are decimal strings)' },
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', description: 'Human-readable message' },
                    code: { type: 'string', description: 'Stable machine-readable code (see https://docs.xchain.io/protocol/Error_Codes.md)' },
                },
                required: ['error'],
            },
        },
        responses: {
            BadRequest: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            NotFound: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            CoinUnavailable: { description: 'Coin not configured on this explorer', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
    },
};

const out = path.join(__dirname, 'openapi.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}: ${Object.keys(paths).length} paths (${ROUTES.length} table routes + ${SPECIAL.length} special)`);
