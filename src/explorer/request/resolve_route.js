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
 * XChain Explorer - working out what a request is asking for
 *
 * The first stage: read the coin, the kind of request and the tip freshness off
 * the path, then walk the route tables until one of them claims it and fill the
 * request config with what that route names.
 *
 * The matching itself is four tests against one route, in the order they always
 * ran: the three ways a page path can match, the market routes, the length-equal
 * data routes, and the list-all explorer tabs. Each is its own function so a
 * reader can see which shape claimed a URL, while the conditions that choose
 * between them stay together, because their order is what decides which wins.
 *
 ********************************************************************/

'use strict';

/**
 * Split the request path and read the coin and request kind off it.
 */
function readPath(explorer, req, st){
    // Drop the leading and trailing slashes, then split the path into its parts.
    let urlPath = String(req.path).substring(1).replace(/\/$/,'').split('/');

    // Turn the literal string 'null' into a real null, so isNull judges it properly.
    urlPath.forEach(function(value, idx){
        if(String(value).toLowerCase()=='null')
            urlPath[idx] = null;
    });
    st.urlPath = urlPath;

    // The first part of the path names the COIN (BTC, LTC, DOGE, and their
    // testnet and regtest forms).
    let coin = String(urlPath[0]).toUpperCase();
    st.coin  = coin;
    if(!explorer.util.isNull(st.config['COIN_SUPPORTED'][coin]))
        st.cfg.coin = coin;

    // The second part says what KIND of request this is; anything else is a page.
    let type = String(urlPath[1]).toLowerCase();
    st.cfg.type = (['api','explorer'].includes(type) && urlPath.length>2) ? type : 'html';

    // A copy of the path this method may rewrite, as the coin-unavailable
    // redirect below does.
    st.requestPath = req.path;

    // validDataRequest is false when the coin is supported but not yet configured in this instance
    st.validDataRequest = (!explorer.util.isNull(st.config['COIN_SUPPORTED'][coin]) && !explorer.util.isNull(st.config['COIN_AVAILABLE'][coin])) ? true : false;
}

/**
 * Read this coin's tip freshness and settle whether the data read may run.
 */
async function readFreshness(explorer, st){
    let coin = st.coin;
    // Freshness of this coin's indexed tip, read once per request from the
    // 15s cache in db/index.js. A stale tip does NOT refuse the read: the rows are a
    // true record of the chain up to the tip this instance holds, and refusing
    // them turned every indexer stall into a whole-coin blackout that read as
    // the network being down (see staleFailClosed in db/index.js). The snapshot is
    // stamped onto the response instead, and only the EXPLORER_STALE_FAIL_CLOSED
    // opt-in keeps the old 503.
    let freshness = null;
    let tipStale  = false;
    if(st.validDataRequest && explorer.db.pools && explorer.db.pools[coin] && typeof explorer.db.getCoinFreshness === 'function'){
        freshness = await explorer.db.getCoinFreshness(coin);
        tipStale  = !!(freshness && freshness.stale);
    } else if(st.validDataRequest && explorer.db.pools && explorer.db.pools[coin] && typeof explorer.db.isCoinTipStale === 'function'){
        // Unit doubles that stub only the boolean verdict.
        tipStale  = await explorer.db.isCoinTipStale(coin);
        freshness = { stale: tipStale, tip_block: null, tip_age_seconds: null, replica_halted: null };
    }
    if(tipStale && explorer.db.staleFailClosed && explorer.db.staleFailClosed())
        st.validDataRequest = false;

    // Force /{COIN}/api/status valid so we always return explorer config for that coin
    if(String(st.urlPath[1]).toLowerCase()=='api' && String(st.urlPath[2]).toLowerCase()=='status')
        st.validDataRequest = true;

    // If the COIN is supported but not available, return the 'COIN Unavailable' page
    if(!explorer.util.isNull(st.config['COIN_SUPPORTED'][coin]) && explorer.util.isNull(st.config['COIN_AVAILABLE'][coin]))
        st.requestPath = '/coin-unavailable';

    st.freshness = freshness;
    st.tipStale  = tipStale;
}

/**
 * The three ways a page path matches a route.
 */
function matchHtmlRoute(explorer, st, url, parts){
    let match = false;
    // The whole path is the route, spelled exactly.
    if(String(st.requestPath).toLowerCase()==String(url).toLowerCase())
        match = true;
    // A bare coin home page, /{COIN} and nothing more.
    if(parts.length==1 && st.urlPath.length==1 && parts[0]=='{COIN}' && !explorer.util.isNull(st.cfg.coin))
        match = true;
    // A coin page named by its second segment, /{COIN}/actions.
    if(parts.length > 1 && parts[1]==String(st.urlPath[1]).toLowerCase())
        match = true;
    return match;
}

/**
 * A market route, which carries its pair in the path rather than a search term.
 */
function matchMarketRoute(explorer, st, parts){
    let match      = false;
    let searchType = false;
    if(!explorer.util.isNull(st.urlPath[3]))
        searchType = 'token';
    if(String(st.urlPath[2]).toLowerCase()=='markets'){
        match = true;
    } else if(String(st.urlPath[2]).toLowerCase()=='market'){
        if(!explorer.util.isNull(parts[3]) && !explorer.util.isNull(parts[4]) && !explorer.util.isNull(st.urlPath[3]) && !explorer.util.isNull(st.urlPath[4])){
            if(explorer.util.isNull(parts[5])){
                if(explorer.util.isNull(st.urlPath[5]))
                    match = true;
            } else {
                if(parts[5]==String(st.urlPath[5]).toLowerCase())
                    match = true;

            }
        }
    }
    // Carry the extra market search terms forward.
    if(match){
        st.cfg.data.search2 = st.urlPath[4];
        st.cfg.data.search3 = st.urlPath[6];
    }
    return { match, searchType };
}

/**
 * A data route whose segment count and literals line up with the request path.
 */
function matchDataRoute(explorer, st, parts, info){
    let match      = false;
    let searchType = false;
    // An explorer route with no search term of its own.
    if(st.cfg.type=='explorer' && st.urlPath.length==3)
        match = true;
    // Otherwise the 5th segment names the search type, and must be one
    // the route declares.
    if(!match){
        let infoType = typeof info[1];
        let search = String(st.urlPath[4]).toLowerCase();
        if(infoType=='string')
            searchType = info[1];
        if(infoType=='object' && info[1].includes(search))
            searchType = search;
        if(searchType || infoType=='undefined')
            match = true;
    }
    return { match, searchType };
}

/**
 * Test one route table entry against the request path.
 */
function matchUrl(explorer, st, url, parts, info){
    let match      = false;
    let searchType = false;

    // Page requests match on the path itself, in three ways.
    if(st.cfg.type=='html')
        match = matchHtmlRoute(explorer, st, url, parts);

    // Market routes carry the pair in the path, so they match on their own terms.
    if(!match && !explorer.util.isNull(parts[2]) && parts[2].includes('market') && String(st.urlPath[2]).toLowerCase().includes('market')){
        ({ match, searchType } = matchMarketRoute(explorer, st, parts));
    // Require the route's segment COUNT to match the request path, so a shorter
    // route cannot swallow a deeper one: /contract/{QUERY} must not match
    // /contract/{QUERY}/state.

    // The 5th-segment literal must match too when the route declares one
    // (.../state vs .../balance): without it, two same-length routes sharing
    // parts[1]/parts[2] are indistinguishable and the first-defined one wins,
    // shadowing the other.
    } else if(!match && parts.length==st.urlPath.length && parts[1]==String(st.urlPath[1]).toLowerCase() &&
        parts[2]==String(st.urlPath[2]).toLowerCase() &&
        (explorer.util.isNull(parts[4]) || String(parts[4]).startsWith('{') || String(parts[4]).toLowerCase()==String(st.urlPath[4]).toLowerCase())){
        ({ match, searchType } = matchDataRoute(explorer, st, parts, info));
    }

    // List-all explorer requests (the home-page tabs) carry no QUERY/TYPE, so the
    // request path is exactly 3 segments (/{COIN}/explorer/{ACTION}) while the route
    // declares optional {QUERY}/{TYPE} placeholders and is longer. The length-equality
    // gate above rejects that pairing, so match it here: action segment lines up and
    // every remaining route segment is a placeholder. Limited to 3-segment paths, so it
    // can't swallow a deeper route (the shadowing case the length check guards against).
    if(!match && st.cfg.type=='explorer' && st.urlPath.length==3 &&
        parts[1]==String(st.urlPath[1]).toLowerCase() &&
        parts[2]==String(st.urlPath[2]).toLowerCase() &&
        parts.slice(3).every(p => String(p).startsWith('{'))){
        match = true;
    }

    return { match, searchType };
}

/**
 * Fill the request config from the route that claimed this path.
 */
function applyRouteMatch(explorer, req, st, info, searchType){
    let cfg = st.cfg;
    if(cfg.type=='html')
        cfg.file = info;
    if(['api','explorer'].includes(cfg.type)){
        cfg.data.method = info[0];
        cfg.data.search = st.urlPath[3];
        cfg.data.type   = searchType;
        // Explorer requests carry the paging position in the query string.
        if(cfg.type=='explorer'){
            let q      = (req.query) ? req.query : false;
            let offset = (q && !explorer.util.isNull(q.offset)) ? q.offset : false;
            let action = (q && !explorer.util.isNull(q.action)) ? q.action : false;
            cfg.data.offset.start  = offset;
            cfg.data.offset.action = action;
        }
    }
}

/**
 * Walk the route table for this request kind and stop at the first match.
 */
function matchRoute(explorer, req, st){
    // Set type / file / info config info using url matching
    for(const url in explorer.urls[st.cfg.type]){
        let parts = String(url).substring(1).split('/');
        let info  = explorer.urls[st.cfg.type][url];
        let { match, searchType } = matchUrl(explorer, st, url, parts, info);

        // A matched route fills the request config with what it names.
        if(match){
            applyRouteMatch(explorer, req, st, info, searchType);
            break;
        }
    }
}

/**
 * Resolve which route answers this request, and whether its data may be read.
 */
async function resolveRoute(explorer, req, st){
    readPath(explorer, req, st);
    await readFreshness(explorer, st);
    matchRoute(explorer, req, st);
}

module.exports = { resolveRoute };
