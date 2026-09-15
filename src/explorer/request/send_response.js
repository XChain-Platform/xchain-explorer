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
 * XChain Explorer - putting the answer on the wire
 *
 * The last stage: stamp the runtime and the freshness markers on, set the headers
 * and the status, and send whichever of the JSON body, the HTML page or the
 * last-resort string this request produced. Then record what it cost, so /ping can
 * report a p95 and a slow-request count without a second measurement.
 *
 * The latency reservoir itself stays in XChainExplorer.js, because the two statics
 * that report it do: a module-level buffer here would be shared by every explorer
 * the require cache hands out rather than reset with each one. The recorder travels
 * in with the host bag instead.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not a method on the class these stages serve: the slow-request line
// reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../../observability');
const log = getLogger();

/**
 * Stamp this coin's tip freshness onto the response.
 */
function applyFreshnessHeaders(explorer, st){
    // Freshness marker on every data response for this coin, so a consumer
    // (the SDK, a wallet, the explorer's own pages) can tell served-and-current
    // from served-and-behind without a second request. Headers always; the
    // `freshness` body field only while the coin is stale, so the fresh-path
    // body stays byte-identical to what it was (the same additive convention
    // the WS WELCOME frame uses for its `stale` marker). Skipped on the 503
    // path, whose body is the refusal itself.
    if(['api','explorer'].includes(st.cfg.type) && st.freshness && st.response.json && st.response.code !== 503){
        st.response.head['XChain-Freshness'] = st.freshness.stale ? 'stale' : 'live';
        if(st.freshness.tip_block !== null && st.freshness.tip_block !== undefined)
            st.response.head['XChain-Tip-Block'] = String(st.freshness.tip_block);
        if(st.freshness.tip_age_seconds !== null && st.freshness.tip_age_seconds !== undefined)
            st.response.head['XChain-Tip-Age-S'] = String(st.freshness.tip_age_seconds);
        if(st.freshness.stale && typeof st.response.json === 'object' && !Array.isArray(st.response.json))
            st.response.json.freshness = {
                stale:           true,
                tip_block:       st.freshness.tip_block,
                tip_age_seconds: st.freshness.tip_age_seconds,
                replica_halted:  st.freshness.replica_halted
            };
    }
}

/**
 * Record what this request cost, for /ping and the slow-request log.
 */
function recordRequestCost(explorer, req, st, host){
    if(!explorer.util.isNull(st.response.time))
        host.stats.record(st.response.time);

    // Anything slower than 400 milliseconds is logged, and counted for /ping.
    if(st.response.time > 400){
        host.stats.slow();
        log.warn('SLOW_REQUEST', { path: req.path, time: st.response.time + 'ms' });
    }

    // Debug detail, logged only when the DEBUG environment variable is set.
    // The request config as fields, so the shipper's key redaction applies to the
    // client-supplied query it carries before the record reaches any log sink.
    if(host.configEnv().DEBUG){
        log.info('REQUEST_CONFIG', { coin: st.cfg.coin, type: st.cfg.type, file: st.cfg.file, data: st.cfg.data });
    }
}

/**
 * Send the response this request produced, then record what it cost.
 */
function sendResponse(explorer, req, res, st, host){
    // Total time spent on this request, in milliseconds.
    st.response.time = explorer.util.getTimer(st.debugTimer);

    // Carry that runtime into the JSON response as a readable string.
    if(st.response.json)
        st.response.json.runtime = explorer.util.getTimerString(st.response.time);

    st.response.head = structuredClone(explorer.headers);

    applyFreshnessHeaders(explorer, st);

    if(host.configEnv().DEBUG && !explorer.util.isNull(st.response.time))
        st.response.head['XChain-Runtime-Ms'] = st.response.time;

    if(!explorer.util.isNull(st.response.head))
        res.set(st.response.head);

    res.status(st.response.code);

    if(!explorer.util.isNull(st.response.json)){
        // Explicit header, not res.type('json'): a browser that ever received this
        // body as text/html would let a reflected value execute as markup, so the
        // JSON content type is set directly rather than through a helper whose
        // effect a static analyzer (or a future refactor) could lose track of.
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.send(explorer.util.jsonStringify(st.response.json));
    } else if(!explorer.util.isNull(st.response.html)){
        res.send(st.response.html);
    } else {
        res.send('response of last resort...');
    }

    recordRequestCost(explorer, req, st, host);
}

module.exports = { sendResponse };
