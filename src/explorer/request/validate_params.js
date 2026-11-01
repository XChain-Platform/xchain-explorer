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
 * XChain Explorer - refusing a malformed parameter before the database sees it
 *
 * The guards between a matched route and the read it names. Three of them refuse
 * a path segment MariaDB would otherwise coerce into the wrong record; the other
 * two answer an empty result without a query at all, for a blocked mirror and for
 * a token search too short to use an index.
 *
 * It answers whether the request is already settled: true where one of the five
 * branches filled in the response or the empty result, false where the read below
 * it still has to run.
 *
 ********************************************************************/

'use strict';

const { canonicalAnyCoinAddress, canonicalCoinAddress } = require('./address_shape.js');
const { canonicalTransactionHash } = require('../../lib/transaction_hash.js');

const TICK_PATH_TYPES = new Set(['token', 'tick', 'gate']);
const ADDRESS_PATH_TYPES = new Set(['address', 'source', 'destination', 'oracle', 'delegator', 'delegate']);
// Lanes that match a column holding another chain's address on the same network:
// hub-mirrored oracle_prices.source_address, MESSAGE DESTINATION (checked against
// its COIN), SWAP GET_ADDRESS (checked against GET_COIN) behind the swap match
// lane, and XBRIDGE DEST_ADDRESS. A wallet reads its inbox on every chain's
// explorer with one address, so these accept any configured chain's address.
const MULTI_CHAIN_ADDRESS_METHODS = new Set(['getOraclePrices', 'getMessages', 'getSwapMatches', 'getXbridges']);

// Path filter types that bind an integer column, with the refusal each answers.
// MariaDB casts a string like '7junk' to 7 in a numeric comparison, so a malformed
// segment would otherwise answer another record's data.
const INTEGER_PATH_TYPES = {
    block:     ['Invalid block_index', 'INVALID_BLOCK_INDEX'],
    tx_index:  ['Invalid tx_index', 'INVALID_TX_INDEX'],
    poll:      ['Invalid poll_index', 'INVALID_POLL_INDEX'],
    feed:      ['Invalid feed_action_index', 'INVALID_FEED_INDEX'],
    round:     ['Invalid round_number', 'INVALID_ROUND_NUMBER'],
    epoch:     ['Invalid epoch_height', 'INVALID_EPOCH_HEIGHT'],
    execution: ['Invalid execution_index', 'INVALID_EXECUTION_INDEX'],
    dispenser: ['Invalid dispenser_action_index', 'INVALID_DISPENSER_INDEX'],
    contract:  ['Invalid contract_index', 'INVALID_CONTRACT_INDEX']
};

// A segment that names no record and reaches the read unchanged: an absent one, the
// literal 'null' the list pages send for a feed with no query (/explorer/blocks/null),
// and 'all' on the blocks list.
function isNoFilterSegment(method, search){
    if(search === undefined || search === null || search === '' || search === 'null')
        return true;
    return method === 'getBlocks' && search === 'all';
}

// The refusal for a malformed integer path segment on a data route, or null. The
// search route reads a contract by name, so its contract lane is free text, and
// getBlock refuses its own segment in the reader for every caller.
function integerPathRefusal(explorer, cfg){
    let type = cfg.data.type;
    if(!['api', 'explorer'].includes(cfg.type) || ['getSearch', 'getBlock'].includes(cfg.data.method))
        return null;
    if(!Object.prototype.hasOwnProperty.call(INTEGER_PATH_TYPES, type))
        return null;
    if(isNoFilterSegment(cfg.data.method, cfg.data.search))
        return null;
    if(explorer.util.isSafeIntegerParam(cfg.data.search))
        return null;
    let [error, code] = INTEGER_PATH_TYPES[type];
    return { error, code };
}

function lookupPathRefusal(explorer, st){
    let cfg    = st.cfg;
    let method = cfg.data.method;
    let type   = cfg.data.type;
    let search = cfg.data.search;
    // Require the exact persisted shape before a transaction hash lookup.
    if(method === 'getTransaction' && type === 'tx_hash'){
        const canonical = canonicalTransactionHash(search);
        if(canonical === false)
            return { error: 'Invalid transaction hash', code: 'INVALID_TX_HASH' };
        cfg.data.search = canonical;
    }
    // Require a safe decimal id after the compact ticker marker.
    if(TICK_PATH_TYPES.has(type) && typeof search === 'string' && search.startsWith('^') &&
       !explorer.util.isSafeIntegerParam(search.substring(1)))
        return { error: 'Invalid ticker reference', code: 'INVALID_TICK_REF' };
    if(TICK_PATH_TYPES.has(type) && typeof search === 'string' && search.startsWith('^'))
        cfg.data.search = '^' + Number(search.substring(1));
    // Require an address for the route network, across chains only for mirror rows.
    if(ADDRESS_PATH_TYPES.has(type) && method !== 'getSearch' && !isNoFilterSegment(method, search)){
        let canonical = MULTI_CHAIN_ADDRESS_METHODS.has(method)
            ? canonicalAnyCoinAddress(st.config, cfg.coin, search)
            : canonicalCoinAddress(st.config, cfg.coin, search);
        if(canonical === false)
            return { error: 'Invalid address', code: 'INVALID_ADDRESS' };
        if(canonical !== null)
            cfg.data.search = canonical;
    }
    // Require the optional market counterparty filter to name a route-network address.
    if(['getMarketHistory', 'getMarketOrders'].includes(method) && !explorer.util.isNull(cfg.data.search3)){
        let canonical = canonicalCoinAddress(st.config, cfg.coin, cfg.data.search3);
        if(canonical === false)
            return { error: 'Invalid address', code: 'INVALID_ADDRESS' };
        if(canonical !== null)
            cfg.data.search3 = canonical;
    }
    return null;
}

/**
 * Settle the request without a query where its parameters say to.
 *
 * @returns {boolean} true where this stage answered it, false to read the data
 */
function validateParams(explorer, st){
    let cfg      = st.cfg;
    let response = st.response;
    // Short token/subtoken search terms force a leading-% LIKE filesort over the
    // whole tokens table (no B-tree path) on every unauthenticated request. Return
    // an empty result before touching the DB, mirroring getSearch's SEARCH_MIN_LENGTH
    // guard.
    const TOKEN_SEARCH_MIN_LENGTH = 3;
    // Cross-chain match rows come from the checkpoint mirror; when a
    // SELF-SYNCED mirror has never bootstrapped, refuse to serve (an
    // empty mirror must read as an outage, not an empty ledger), and
    // otherwise annotate lag. Same gate as the checkpoint routes.
    st.mirrorGate = (cfg.data.method === 'getCrossChainMatches') ? explorer.mirrorGate(cfg.coin) : null;
    let mirrorGate = st.mirrorGate;
    let refusal    = integerPathRefusal(explorer, cfg) || lookupPathRefusal(explorer, st);
    // /{COIN}/api/action/{QUERY} binds its path segment against the BIGINT
    // action_index column, and MariaDB coerces the string, so `/api/action/7junk`
    // answered 200 with action 7 and `/api/action/junk` with action 0. Reject the
    // malformed id before the DB call, using the same strict shape and error code
    // as processFileRawRequest below. parseInt/sanitizeInt cannot do this job:
    // parseInt('7junk') is 7, which reproduces the bug in JS.
    if(cfg.data.method === 'getAction' && cfg.data.type === 'action_index' &&
       !explorer.util.isSafeIntegerParam(cfg.data.search)){
        st.badParam   = true;
        response.code = 400;
        response.json = { error: 'Invalid action_index', code: 'INVALID_ACTION_INDEX' };
    // /{COIN}/api/checkpoint/{QUERY} binds its path segment via db/index.js's
    // getCheckpoint as Number(config.data.search): a non-numeric segment
    // (e.g. 'zzz-no-such') becomes NaN, which the mariadb driver cannot bind
    // and throws, so the request reached the generic DB_ERROR 500 instead of
    // a clean 404/400 (D-E060). Reject it here, before the DB call, using the
    // same strict shape and the INVALID_BLOCK_INDEX code processCheckpointVerifyRequest
    // already established for a malformed block-index segment.
    } else if(cfg.data.method === 'getCheckpoint' && cfg.data.type === 'block' &&
       !explorer.util.isSafeIntegerParam(cfg.data.search)){
        st.badParam   = true;
        response.code = 400;
        response.json = { error: 'Invalid block_index', code: 'INVALID_BLOCK_INDEX' };
    } else if(refusal){
        st.badParam   = true;
        response.code = 400;
        response.json = refusal;
    } else if(mirrorGate && mirrorGate.blocked){
        st.data  = [];
        st.total = 0;
    } else if(cfg.data.method === 'getTokens' &&
       ['token','subtoken'].includes(cfg.data.type) &&
       String(cfg.data.search || '').trim().length < TOKEN_SEARCH_MIN_LENGTH){
        st.data  = [];
        st.total = 0;
    } else {
        return false;
    }
    return true;
}

module.exports = { validateParams };
