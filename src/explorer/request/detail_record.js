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
 * XChain Explorer - a detail page for a record that cannot exist
 *
 * A detail page renders its record client-side, so a URL naming no record would
 * answer 200 and show a not-found state, which a crawler reads as a real page.
 * Where the server can tell cheaply that no record can be behind the URL, the
 * same page is answered with a 404 instead:
 *
 *   block        a height that is not a decimal integer, or one above the indexed
 *                tip (the freshness snapshot every request already has, confirmed
 *                by one MAX over the primary key only when the snapshot says above)
 *   action       an index that is not a decimal integer, or one above the highest
 *                action index (one MAX over the primary key)
 *   transaction  neither a 64-hex hash nor a decimal tx_index
 *   address      not an address on this coin and network
 *
 * Anything the server cannot settle that cheaply stays a 200: a block height while
 * the tip is unknown or stale, an action index when the read fails, a well-formed
 * hash that may or may not be indexed.
 *
 ********************************************************************/

'use strict';

const { isCoinAddress } = require('./address_shape.js');

const DECIMAL_RE = /^[0-9]+$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * A block height that is malformed, or above an indexed tip this instance can
 * vouch for.
 */
async function blockIsMissing(explorer, st, query){
    if(!DECIMAL_RE.test(query))
        return true;
    const freshness = st.freshness;
    if(!freshness || freshness.stale || freshness.tip_block === null || freshness.tip_block === undefined)
        return false;
    if(BigInt(query) <= BigInt(freshness.tip_block))
        return false;
    // The snapshot can trail the indexer by its cache window, so a block indexed
    // inside it is confirmed against the live tip before the page answers 404.
    if(typeof explorer.db.getMaxBlockIndex !== 'function')
        return false;
    try {
        const tip = await explorer.db.getMaxBlockIndex({ coin: st.cfg.coin, data: {} });
        return BigInt(query) > BigInt(tip);
    } catch(e){
        return false;
    }
}

/**
 * An action index that is malformed, or above the highest one indexed.
 */
async function actionIsMissing(explorer, st, query){
    if(!explorer.util.isSafeIntegerParam(query))
        return true;
    if(typeof explorer.db.getMaxActionIndex !== 'function')
        return false;
    try {
        const max = await explorer.db.getMaxActionIndex({ coin: st.cfg.coin, data: {} });
        return BigInt(query) > BigInt(max);
    } catch(e){
        return false;
    }
}

function transactionIsMissing(explorer, st, query){
    return !TX_HASH_RE.test(query) && !DECIMAL_RE.test(query);
}

function addressIsMissing(explorer, st, query){
    return isCoinAddress(st.config, st.cfg.coin, query) === false;
}

// The detail pages this stage judges, by the content file the route names.
const CHECKS = {
    'block.html':       blockIsMissing,
    'action.html':      actionIsMissing,
    'transaction.html': transactionIsMissing,
    'address.html':     addressIsMissing
};

/**
 * Answer a detail page with a 404 when the record it names cannot exist. Leaves
 * every other request untouched, including a detail path with extra segments.
 */
async function checkDetailRecord(explorer, st){
    const cfg = st.cfg;
    if(cfg.type !== 'html' || explorer.util.isNull(cfg.coin) || !st.validDataRequest || !st.urlPath || st.urlPath.length !== 3)
        return;
    if(!Object.prototype.hasOwnProperty.call(CHECKS, cfg.file))
        return;
    if(await CHECKS[cfg.file](explorer, st, String(st.urlPath[2])))
        st.response.code = 404;
}

module.exports = { checkDetailRecord };
