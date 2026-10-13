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
 * XChain Explorer - a detail path with no record named
 *
 * A detail page is declared as /{COIN}/poll/{QUERY}, but the page matcher also
 * claims the bare /{COIN}/poll because it matches on the second segment alone.
 * Served as is, the page's script has no record to ask for and requests
 * .../api/poll/undefined. The bare singular path answers a 302 to the coin's list
 * page for the same type when one exists, and the 404 page when none does.
 *
 ********************************************************************/

'use strict';

// Detail pages that show something useful with no record named, so they keep
// being served: the rich list prompts for a tick on its own.
const SERVES_BARE = new Set(['rich_list']);

/**
 * The list route key for a detail name (poll -> /{COIN}/polls, address -> /{COIN}/addresses).
 */
function listRouteFor(pages, name){
    for(const plural of [name + 's', name + 'es']){
        const key = '/{COIN}/' + plural;
        if(Object.prototype.hasOwnProperty.call(pages, key))
            return plural;
    }
    return null;
}

/**
 * Settle a bare singular detail request: redirect it to its list page, or turn it
 * into the 404 page. Leaves every other request, including a detail path that
 * names a record, untouched.
 */
function resolveBareDetail(explorer, req, st){
    const cfg = st.cfg;
    if(cfg.type != 'html' || explorer.util.isNull(cfg.coin) || explorer.util.isNull(cfg.file) || st.urlPath.length != 2)
        return;

    const pages = explorer.urls.html;
    const name  = String(st.urlPath[1]).toLowerCase();
    if(SERVES_BARE.has(name) || pages['/{COIN}/' + name + '/{QUERY}'] !== cfg.file)
        return;

    const plural = listRouteFor(pages, name);
    if(plural === null){
        cfg.file         = '404.html';
        st.response.code = 404;
        return;
    }

    // The query string rides along: the page scripts read ?coin= to pick the chain.
    const original = String(req.originalUrl || '');
    const qs       = original.indexOf('?');
    st.redirect = {
        code: 302,
        url:  '/' + encodeURIComponent(st.urlPath[0]) + '/' + plural + (qs !== -1 ? original.substring(qs) : '')
    };
}

module.exports = { resolveBareDetail };
