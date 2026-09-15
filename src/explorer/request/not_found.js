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
 * XChain Explorer - the three answers when a request found nothing
 *
 * What a request gets when no route claimed it, when the coin it names cannot be
 * served here, and when the record it asked for does not exist. The order matters:
 * the 404 fallback runs first so an unmatched path becomes a page request, and the
 * not-found answer is skipped whenever a read failed or a parameter was refused,
 * so a 500 or a 400 is never rewritten into a 404.
 *
 ********************************************************************/

'use strict';

/**
 * Apply the not-found, unavailable and no-record answers, in that order.
 */
function applyFallbacks(explorer, st){
    // Nothing matched: no file to serve and no method to call, so answer 404.
    if(explorer.util.isNull(st.cfg.file) && explorer.util.isNull(st.cfg.data.method)){
        st.cfg.file = '404.html';
        st.cfg.type = 'html';
        st.response.code = 404;
    }

    // A data request this instance cannot serve answers 503, service unavailable.
    if(['api','explorer'].includes(st.cfg.type) && !explorer.util.isNull(st.cfg.data.method) && !st.validDataRequest){
        st.response.code = 503;
        // Separate code for the freshness gate: a client retrying a COIN_NOT_AVAILABLE
        // is misconfigured, one retrying COIN_DATA_STALE is waiting out an outage.
        st.response.json = st.tipStale ? {
            error: 'Indexed data for this coin is stale beyond its maximum tip age; refusing to serve it as current.',
            code: 'COIN_DATA_STALE'
        } : {
            error: 'Explorer not configured to support data requests for this coin.',
            code: 'COIN_NOT_AVAILABLE'
        };
    }

    // No record for a single-resource lookup: return 404 so the HTTP status agrees
    // with the body's NOT_FOUND code and matches the hand-registered routes elsewhere
    // in this service (e.g. :1071, :1133). A 400 made consumers that branch on status
    // (including xchain-sdk) treat "does not exist" as a malformed request. Empty list
    // queries are unaffected (they return 200 with total:0).
    else if(!st.dbError && !st.badParam && ['api','explorer'].includes(st.cfg.type) && explorer.util.isNull(st.data) && explorer.util.isNull(st.total)){
        st.response.code = 404;
        st.response.json = {
            error: 'The requested resource was not found.',
            code: 'NOT_FOUND'
        };
    }
}

module.exports = { applyFallbacks };
