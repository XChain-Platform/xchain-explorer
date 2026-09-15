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
 * XChain Explorer - one request's working state
 *
 * Everything the stages of processRequest read and write about the request in
 * flight, built once at the top of the pipeline and handed from stage to stage.
 * It carries the request config the URL match fills in, the response being built,
 * the rows a reader returned, and the two flags that say a read failed or a
 * parameter was malformed, which later stages test before they fall back to a 404.
 *
 ********************************************************************/

'use strict';

/**
 * Build the state one request is served from.
 *
 * @param {object} explorer the XChainExplorer instance serving the request
 * @param {object} req the express request
 * @param {object} config the resolved explorer config
 * @returns {object} the request state every stage reads and writes
 */
function newRequestState(explorer, req, config){
    let response = structuredClone(explorer.response);

    // Times the whole request; reported back as response.time.
    let debugTimer = explorer.util.startTimer();

    let total = null;
    let data  = null;
    // Set when a data read genuinely FAILED (db/index.js now throws a DbQueryError
    // on outage/rejected query instead of swallowing it into an empty set,
    // M-4). Suppresses the empty-result assembly and the NOT_FOUND fallback
    // so the response stays a 5xx rather than a misleading empty 200 / 404.
    let dbError = false;
    // Set when a path parameter is malformed. Like dbError it suppresses the
    // NOT_FOUND fallback below, so a 400 does not get rewritten to a 404 by the
    // empty-result branch.
    let badParam = false;

    // Everything worked out about this request, filled in by the URL match below.
    let cfg = {
        coin: null, // COIN type (BTC, LTC, DOGE)
        type: null, // Request type (html, api, explorer)
        file: null, // File content to return
        data: {
            method: null, // Method to run to get data
            search: null, // Search to pass to method
            type:   null, // Search type to pass to method
            path:   req.path,  // Request URL path
            query:  req.query, // Request Query string parameters
            // SQL query specific information
            sql: {
                order:  null, // Sort order (ASC, DESC)
                limit:  null, // Record Limit (LIMIT X)
                where: {
                    data:       '', // Where data SQL
                    offset:     '', // Where offset SQL
                    offsetArgs: []  // Parameterized offset args
                }
            },
            // Offset used by explorer for paging (action: first/last/next/prev)
            offset: {
                action: null, // Action (first, last, next, prev)
                start:  null, // start value (action_index, etc)
                stop:   null, // stop value (action_index, etc)
            }
        },
    };

    return { config, response, debugTimer, total, data, dbError, badParam, cfg };
}

module.exports = { newRequestState };
