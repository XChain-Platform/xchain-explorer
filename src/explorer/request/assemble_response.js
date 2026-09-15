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
 * XChain Explorer - turning rows into the body that goes out
 *
 * The rows a reader returned become the JSON a caller reads: a list response
 * carrying its record counts and one page of rows, or the single record itself.
 * The per-method touch-ups and the mirror-gate verdict then run over that body in
 * the order they always did, and the result is stamped onto the response.
 *
 ********************************************************************/

'use strict';

/**
 * Build a list response: the record counts plus the page of rows this request asked for.
 */
function buildListJson(explorer, st, data){
    let cfg   = st.cfg;
    let total = st.total;
    let json  = {};
    if(cfg.type=='api'){
        // How many records were found in all, not just on this page.
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
    // The same record count, named the way the explorer's tables expect it:
    // DataTables server-side format (https://datatables.net/manual/server-side#Returned-data)
    if(cfg.type=='explorer'){
        // DataTables sends back the server's own recordsTotal as ?total= to
        // avoid a re-count on paging. Validate it: total flows into
        // getPagingDataResults -> bcsub (mathjs), so an unvalidated non-numeric
        // override (e.g. ?total=abc) threw a DecimalError outside any try/catch
        // and crashed the process. Ignore a non-numeric override and keep the
        // real DB count. Mirrors the isInteger/Number guards on start/limit/length.
        if(cfg.data.query.total && explorer.util.isNumeric(cfg.data.query.total))
            total = Number(cfg.data.query.total)
        json.recordsTotal    = total;
        json.recordsFiltered = total;
    }
    json.data  = explorer.getPagingDataResults(cfg, data, total);
    st.total = total;
    return json;
}

/**
 * The per-method fixes to the body before it goes out.
 */
function applyMethodTouchups(explorer, st, json, data){
    let cfg = st.cfg;
    // Per-method touch-ups to the JSON before it goes out.

    // cfg.data.search is the raw {QUERY} path segment: only echo it back as
    // json.address once it is confirmed address-shaped, so an arbitrary
    // (and possibly script-bearing) path segment never reaches the response.
    if(cfg.data.method=='getBalances')
        json.address = explorer.util.isAddressLike(cfg.data.search) ? cfg.data.search : null;
    if(cfg.data.method=='getSearch'){
        delete data.data;
        json = Object.assign({}, json, data);
    }

    // Sort the API response and each row's properties alphabetically, so the
    // same query always comes back in the same order.
    if(cfg.type=='api' && !explorer.util.isNull(json)){
        json = explorer.util.ksort(json);
        for(let idx in json.data)
            json.data[idx] = explorer.util.ksort(json.data[idx]);
    }
    return json;
}

/**
 * Assemble the response body from what the read returned.
 */
function assembleResponse(explorer, st){
    let response = st.response;
    let data     = st.data;
    let json     = {};

    // A numeric total means this is a list of results, so return only the
    // page of them the request asked for.
    if(explorer.util.isNumeric(st.total)){
        json = buildListJson(explorer, st, data);
    } else {
        // No total means a single-record read, so the object itself is the answer.
        json = data;
    }

    json = applyMethodTouchups(explorer, st, json, data);

    response.json = json;

    if(st.mirrorGate){
        if(st.mirrorGate.blocked){
            response.code = 503;
            response.json = explorer.mirrorBlockedBody(st.mirrorGate.blocked);
        } else if(st.mirrorGate.annotate){
            Object.assign(response.json, st.mirrorGate.annotate);
        }
    }
}

module.exports = { assembleResponse };
