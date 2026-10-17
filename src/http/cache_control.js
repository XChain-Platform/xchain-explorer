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
 * XChain Explorer - Cache-Control for the JSON API
 *
 * Every /{COIN}/api/* and /{COIN}/explorer/* answer is classified here and
 * nowhere else. The header is stamped when the status line is written, so it
 * covers every writer at once: the catch-all pipeline, the pre-wildcard
 * handlers, the bridge panel routes, and the limiter and gate refusals that
 * answer before any route runs.
 *
 * THE CLASSES
 *
 * tip: data that moves only when the indexed tip moves. The origin keys its
 * own result cache on the tip (src/db/connection/cache.js, 1 s tip memo) and
 * sees a reorg within one ChangeDetector poll (5 s), against block times of
 * 1 to 10 minutes. max-age=5 keeps an HTTP copy no longer than that poll, and
 * stale-while-revalidate=10 lets a cache answer one stale read past it while
 * it refetches, so a new block or a reorg reaches a client at most about 20 s
 * after the indexer writes it, well inside one block interval.
 *
 * config: rows that change only when an operator publishes hub config.
 *
 * document: the generated OpenAPI file, fixed for the life of a deploy.
 *
 * immutable: the stored bytes of a FILE action, addressed by action index.
 *
 * noStore: anything caller-specific, live against the mempool or a tracker,
 * a rate-limited compute or proof route whose verdict must not outlive the
 * request, every non-GET request, and every error. A 4xx or 5xx (429 and 503
 * included) is never cached by anyone, so a transient refusal cannot be
 * replayed by an edge after the cause has cleared.
 *
 * A path inside the API namespaces that no table below names is noStore, so a
 * new route is cached only once someone classifies it. Paths outside them (the
 * HTML pages, static files, icons) keep whatever their own handler sets,
 * except that an error status still becomes noStore.
 *
 ********************************************************************/

'use strict';

const CACHE_CLASSES = {
    tip:       'public, max-age=5, stale-while-revalidate=10',
    config:    'public, max-age=300, stale-while-revalidate=600',
    document:  'public, max-age=3600',
    immutable: 'public, max-age=31536000, immutable',
    noStore:   'no-store'
};

// Routes registered with their own express listener ahead of the catch-all,
// keyed by the exact path string they register with. null marks a route that
// owns its caching and sits outside the API namespaces (the one HTML redirect).
const ROUTE_CLASSES = {
    '/openapi.json'                                       : 'document',
    '/json/xchain-platform-api.json'                      : 'document',
    '/:coin/tx/:query'                                    : null,
    '/:coin/api/file/:actionIndex/raw'                    : 'immutable',
    '/:coin/api/feequote'                                 : 'noStore',
    '/:coin/api/oraclefeequote'                           : 'noStore',
    '/:coin/api/preflight'                                : 'noStore',
    '/:coin/api/feeschedule'                              : 'tip',
    '/:coin/api/checkpoints'                              : 'tip',
    '/:coin/api/checkpoints/range'                        : 'tip',
    '/:coin/api/checkpoint/:blockIndex/verify'            : 'noStore',
    '/:coin/api/hub-mirror/status'                        : 'noStore',
    '/:coin/api/proof/balance/:address/:tick'             : 'noStore',
    '/:coin/api/proof/action/:actionIndex'                : 'noStore',
    '/:coin/api/proof/validator-set'                      : 'noStore',
    '/:coin/api/proof/contract-state/:contractIndex/:key' : 'noStore',
    '/:coin/api/proof/locked-balance/:address/:tick'      : 'noStore',
    '/:coin/api/bridge-invariant/:tick'                   : 'tip',
    '/:coin/api/bridge-transfers/:tick'                   : 'tip',
    '/:coin/api/applied-policy/:tick'                     : 'tip'
};

// The listener every unclaimed request falls through to (explorer/mount.js).
const CATCH_ALL = '/{*path}';

// Route-table families answered through the catch-all, keyed by namespace and
// the resource segment after it (/{COIN}/api/<family>/...). One family, one
// class: a family whose routes need different answers gets its own express
// listener and a ROUTE_CLASSES entry instead.
const TIP_COMMON = [
    'actions', 'addresses', 'airdrops', 'anchor_reward_attestations', 'anchors',
    'attest_validator_stats', 'attestations', 'balances', 'batches', 'bet_feeds', 'bets',
    'blocks', 'broadcasts', 'callbacks', 'capability_slash_events', 'capability_snapshots',
    'coinpay_expires', 'coinpay_obligations', 'coinpays', 'collects', 'commitments',
    'consensus_state', 'contract_delegations', 'contract_stakes', 'contract_unstakes',
    'contracts', 'controllers', 'credits', 'cross_chain_matches', 'cross_chain_settlements',
    'debits', 'delegation_revocations', 'delegations', 'deploy_chunks', 'deposits',
    'destroys', 'dispenser_cancels', 'dispenser_closes', 'dispenser_edits',
    'dispenser_expires', 'dispensers', 'dispenses', 'dividends', 'emissions', 'escrows',
    'executions', 'fees', 'files', 'full_node_verifications', 'governance_proposals',
    'governance_votes', 'history', 'holders', 'issues', 'links', 'lists', 'market',
    'markets', 'messages', 'mints', 'oracle_prices', 'order_cancels', 'order_edits',
    'order_expires', 'order_matches', 'orders', 'peers', 'polls', 'price_snapshots',
    'prices', 'projects', 'reorgs', 'rewards', 'search', 'sends', 'slash_events',
    'slash_proposals', 'sleeps', 'stakes', 'swap_cancels', 'swap_edits', 'swap_expires',
    'swap_matches', 'swaps', 'sweeps', 'telemetry_pings', 'tokens', 'unstakes',
    'validator_capabilities', 'validators', 'vote_delegations', 'votes', 'withdrawals',
    'xcalls'
];

const FAMILY_CLASSES = {
    tip: [
        ...TIP_COMMON.map(f => 'api/' + f),
        ...TIP_COMMON.map(f => 'explorer/' + f),
        'api/action', 'api/anchor', 'api/attestation', 'api/bet_cancels', 'api/bet_edits',
        'api/bet_expires', 'api/bet_feed', 'api/bet_resolves', 'api/block', 'api/checkpoint',
        'api/collectibles', 'api/contract', 'api/execution', 'api/network', 'api/oracle',
        'api/poll', 'api/project', 'api/pubkey', 'api/rich_list',
        'api/rollcalls', 'api/shared_lists', 'api/staking', 'api/status', 'api/token',
        'api/transaction', 'api/validator', 'api/xbridges', 'api/xcall', 'api/xexecs',
        'explorer/checkpoints'
    ],
    config: ['api/configs', 'explorer/configs'],
    // The address record carries the tracker's live UTXO and mempool figures,
    // which a wallet re-reads right after broadcasting.
    noStore: ['api/address', 'api/mempool']
};

// Reverse index the per-request lookup reads. Built once at load.
const FAMILY_INDEX = new Map();
for(const [cls, families] of Object.entries(FAMILY_CLASSES))
    for(const family of families)
        FAMILY_INDEX.set(family, cls);

const API_NAMESPACES = ['api', 'explorer'];

/**
 * The cache class for one request, or null when the request is outside the
 * API namespaces and its handler owns the header.
 *
 * @param {string} method the HTTP method
 * @param {string} path the full request path, before any mount stripped it
 * @param {string|undefined} routePath the path string of the express route that answered
 * @returns {string|null}
 */
function classifyRequest(method, path, routePath){
    if(method !== 'GET' && method !== 'HEAD')
        return 'noStore';
    if(routePath !== undefined && routePath !== CATCH_ALL &&
       Object.prototype.hasOwnProperty.call(ROUTE_CLASSES, routePath))
        return ROUTE_CLASSES[routePath];
    if(path === '/relay' || path.startsWith('/relay/'))
        return 'noStore';
    const segments = path.split('/');
    const namespace = String(segments[2] || '').toLowerCase();
    const family = String(segments[3] || '').toLowerCase();
    if(!API_NAMESPACES.includes(namespace) || family === '')
        return null;
    return FAMILY_INDEX.get(namespace + '/' + family) || 'noStore';
}

/**
 * Set Cache-Control (and Vary on a shared-cacheable answer) for a response
 * whose status line is about to be written.
 *
 * @param {object} res the express response
 * @param {string|null} cls the request's class from classifyRequest
 * @param {number} status the status being written
 */
function stampCacheHeaders(res, cls, status){
    if(status >= 400){
        res.setHeader('Cache-Control', CACHE_CLASSES.noStore);
        return;
    }
    if(cls === null || status < 200)
        return;
    // A redirect inside the API is a routing answer, not the resource. A 304
    // carries the class header because it replaces the stored copy's.
    if(status >= 300 && status !== 304){
        res.setHeader('Cache-Control', CACHE_CLASSES.noStore);
        return;
    }
    res.setHeader('Cache-Control', CACHE_CLASSES[cls]);
    if(cls !== 'noStore'){
        // CORS reflects the caller's Origin, and an allowlisted deployment
        // omits the allow header for a refused one, so a shared copy is only
        // safe keyed on Origin. Nothing at the origin compresses, so a
        // compressing hop between here and the client relies on this too.
        res.vary('Origin');
        res.vary('Accept-Encoding');
    }
}

/**
 * Mount the stamp. Must be the first middleware, so the limiter and gate
 * refusals mounted after it are stamped too.
 *
 * @param {object} app the express app
 */
function applyCacheControl(app){
    app.use((req, res, next) => {
        // Captured here, at the root mount: a handler under app.use('/relay')
        // sees req.path with its mount prefix stripped.
        const method = req.method;
        const path = req.path;
        const writeHead = res.writeHead;
        res.writeHead = function(statusCode, ...rest){
            const status = typeof statusCode === 'number' ? statusCode : res.statusCode;
            if(!res.headersSent)
                stampCacheHeaders(res, classifyRequest(method, path, req.route && req.route.path), status);
            return writeHead.call(this, statusCode, ...rest);
        };
        next();
    });
}

module.exports = {
    applyCacheControl, classifyRequest, stampCacheHeaders,
    CACHE_CLASSES, ROUTE_CLASSES, FAMILY_CLASSES, CATCH_ALL
};
