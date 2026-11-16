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
 * XChain Explorer - the whole-request coin gate for hand-registered reads
 *
 * The same verdict the generic data path reaches in request/resolve_route.js
 * and request/not_found.js, for a route that reads the database itself instead
 * of going through processRequest: an unconfigured coin answers 503
 * COIN_NOT_AVAILABLE, a tip stale past the fail-closed threshold answers 503
 * COIN_DATA_STALE, and every answer carries the XChain-Freshness headers.
 *
 ********************************************************************/

'use strict';

const NOT_AVAILABLE = {
    error: 'Explorer not configured to support data requests for this coin.',
    code:  'COIN_NOT_AVAILABLE'
};

const DATA_STALE = {
    error: 'Indexed data for this coin is stale beyond its maximum tip age; refusing to serve it as current.',
    code:  'COIN_DATA_STALE'
};

function stampFreshness(res, freshness){
    if(!freshness) return;
    res.set('XChain-Freshness', freshness.stale ? 'stale' : 'live');
    if(freshness.tip_block !== null && freshness.tip_block !== undefined)
        res.set('XChain-Tip-Block', String(freshness.tip_block));
    if(freshness.tip_age_seconds !== null && freshness.tip_age_seconds !== undefined)
        res.set('XChain-Tip-Age-S', String(freshness.tip_age_seconds));
}

/**
 * Decide whether `coin` may be read for this request, stamping the freshness
 * headers on `res` either way. Returns { config } when it may, or { refusal }
 * carrying the 503 body to send when it may not.
 */
async function coinReadGate(explorer, coin, res){
    const config    = await explorer.configInfo.getConfig();
    const supported = (config && config['COIN_SUPPORTED']) || {};
    const available = (config && config['COIN_AVAILABLE']) || {};
    const pools     = explorer.db && explorer.db.pools;
    if(explorer.util.isNull(supported[coin]) || explorer.util.isNull(available[coin]) || !pools || !pools[coin])
        return { config, refusal: NOT_AVAILABLE };
    let freshness = null;
    if(typeof explorer.db.getCoinFreshness === 'function')
        freshness = await explorer.db.getCoinFreshness(coin);
    stampFreshness(res, freshness);
    const failClosed = typeof explorer.db.staleFailClosed === 'function' && explorer.db.staleFailClosed();
    if(freshness && freshness.stale && failClosed)
        return { config, refusal: DATA_STALE };
    return { config };
}

module.exports = { coinReadGate };
