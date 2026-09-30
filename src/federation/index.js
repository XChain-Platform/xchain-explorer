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
 * XChain Explorer - federation reads over JSON-RPC
 *
 * A validator's BTC indexer and hub read a DOGE indexer for roll-call presence,
 * anchor depth, archive batches and landed price batches. A validator that runs
 * no DOGE indexer points DOGE_INDEXER_API_URL at this explorer instead
 * (https://<explorer>/TDOGE/api/ or /DOGE/api/), and the explorer answers the same
 * five methods, with the same result shapes, off its replicated copy of that
 * indexer's database.
 *
 * The coin comes from the request path, because the dispatcher is root-mounted
 * and POST /{COIN}/api/ is how it is reached. Each read refuses with the indexer's
 * own "not ready" answer when this explorer has no pool for the coin or when the
 * coin's replica carries an active sync halt, and writes one log line saying what it
 * answered and off which tip. No key stands in front of them: the rows are the
 * replica's, public through the explorer pages already, and the per-IP rate limit
 * bounds a client that retries every block.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability');
const { getrollcallsigners }     = require('./rollcall_signers.js');
const { getanchoraction }        = require('./anchor_action.js');
const { getanchorconfirmations } = require('./anchor_confirmations.js');
const { getarchiveanchor }       = require('./archive_anchor.js');
const { getpricebatches }        = require('./price_batches.js');

const log = getLogger();

// The method bodies, by the name the dispatcher routes on.
const HANDLERS = { getrollcallsigners, getanchoraction, getanchorconfirmations, getarchiveanchor, getpricebatches };

// The federation method set, lowercase, exactly the handler names; the tests pin it.
const FEDERATION_READ_METHODS = new Set(Object.keys(HANDLERS));

// The indexer's answer when it cannot serve a read yet; the clients read any error as "defer".
const NOT_READY = 'indexer database not ready';

// The route a federation read must arrive on: /{COIN}/api or /{COIN}/api/.
const ROUTE_RE = /^\/([A-Za-z]+)\/api\/?$/;

// Split the request path's coin code (TDOGE, RBTC, DOGE) into the pool key and its
// base coin and network, using the loaded config's prefix tables. Null when the path
// is not a federation route or the code names no coin XChain knows.
async function resolveRouteCoin(configInfo, req) {
    const m = ROUTE_RE.exec(String((req && req.path) || ''));
    if (!m) return null;
    const code = m[1].toUpperCase();
    let full;
    try { full = await configInfo.getConfig(); } catch (e) { return null; }
    const networks = (full && full['COIN_NETWORKS']) || {};
    const prefixes = (full && full['COIN_PREFIXES']) || { mainnet: '', testnet: 'T', regtest: 'R' };
    // Prefixed networks first, so TBTC is never read as a mainnet coin named TBTC
    for (const network in prefixes) {
        const p = prefixes[network];
        if (p && code.startsWith(p) && networks[code.slice(p.length)])
            return { code, coin: code.slice(p.length), network };
    }
    if (networks[code]) return { code, coin: code, network: 'mainnet' };
    return null;
}

// Whether an answer is one a caller can act on. Any error is a refusal, and a roll-call
// answer with no window cut yet is the method's own "defer".
function readVerdict(method, result) {
    if (!result || typeof result !== 'object' || result.error) return 'undecided';
    if (method === 'getrollcallsigners' && result.hcut === null) return 'undecided';
    return 'decided';
}

// The replica tip an answer was read off, from whichever field the method carries it in.
function answeredTip(result) {
    if (!result || typeof result !== 'object') return null;
    for (const field of ['tip_block_index', 'latest_block_index', 'block_index'])
        if (result[field] !== undefined && result[field] !== null) return result[field];
    return null;
}

// Everything a read needs before its body runs: the routed coin, a pool for it, and a
// replica that is not halted. Returns { ctx } to proceed or { result } to answer now.
async function prepareRead(method, raw, getExplorer, configInfo) {
    const route = await resolveRouteCoin(configInfo, raw && raw.req);
    // A federation read must name a coin in its path
    if (!route) return { result: { error: 'unknown coin' }, coin: null };
    const explorer = getExplorer();
    const db = explorer && explorer.db;
    // This explorer serves no replica for that coin
    if (!db || !db.pools || !db.pools[route.code]) return { result: { error: NOT_READY }, coin: route.code };
    // A replica halted on divergence from its source may hold rows the chain does not
    if (await db.getReplicaHaltStatus(route.code) === true)
        return { result: { error: NOT_READY }, coin: route.code, halted: true };
    const ctx = { db, dbConfig: { coin: route.code, data: {} }, chain: { COIN: route.coin, NETWORK: route.network } };
    return { ctx, coin: route.code };
}

// Run one federation read end to end and log it. Params go to the handler untouched,
// so a missing or odd params value fails exactly as it does on the indexer.
async function runFederationRead(method, params, raw, getExplorer, configInfo) {
    const started = Date.now();
    const prep = await prepareRead(method, raw, getExplorer, configInfo);
    const result = prep.ctx ? await HANDLERS[method](prep.ctx, params) : prep.result;
    log.info('FEDERATION_READ', {
        coin: prep.coin, method, verdict: readVerdict(method, result), tip: answeredTip(result),
        halted: prep.halted === true, error: (result && result.error) || undefined, ms: Date.now() - started
    });
    return result;
}

/**
 * Build the five federation methods for the JSON-RPC controller.
 *
 * @param {function(): object|null} getExplorer returns the explorer once it exists
 * @param {object} configInfo src/config.js, for the coin prefix tables
 * @returns {object} method name -> (params, {req, res}) handler
 */
function buildFederationRpc(getExplorer, configInfo) {
    const methods = {};
    for (const method of Object.keys(HANDLERS))
        methods[method] = (params, raw) => runFederationRead(method, params, raw, getExplorer, configInfo);
    return methods;
}

module.exports = { FEDERATION_READ_METHODS, NOT_READY, resolveRouteCoin, readVerdict, answeredTip, buildFederationRpc };
