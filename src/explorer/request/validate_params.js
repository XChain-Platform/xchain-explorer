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
 * The guards between a matched route and the read it names. Two of them refuse a
 * path segment MariaDB would otherwise coerce into the wrong record; the other two
 * answer an empty result without a query at all, for a blocked mirror and for a
 * token search too short to use an index.
 *
 * It answers whether the request is already settled: true where one of the four
 * branches filled in the response or the empty result, false where the read below
 * it still has to run.
 *
 ********************************************************************/

'use strict';

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
