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
 * XChain Explorer - serving one request end to end
 *
 * The stages processRequest runs, in the order it ran them inline: build the state,
 * resolve the route, read the data the route names, assemble the body, apply the
 * not-found answers, render a page where the request is for one, and send it.
 *
 * The host bag carries what only XChainExplorer.js can supply: the config-env view,
 * which the suites replace in that file's require map, and the latency recorder,
 * whose buffer stays there with the statics that report it.
 *
 ********************************************************************/

'use strict';

const { newRequestState }  = require('./state.js');
const { resolveRoute }     = require('./resolve_route.js');
const { validateParams }   = require('./validate_params.js');
const { loadData }         = require('./load_data.js');
const { assembleResponse } = require('./assemble_response.js');
const { applyFallbacks }   = require('./not_found.js');
const { renderPage }       = require('./render_page.js');
const { sendResponse }     = require('./send_response.js');

/**
 * Serve one request end to end.
 *
 * @param {object} explorer the XChainExplorer instance serving it
 * @param {object} req the express request
 * @param {object} res the express response
 * @param {object} host the entry file's own bindings: configEnv and the latency recorder
 */
async function runRequest(explorer, req, res, host){
    let config = await explorer.configInfo.getConfig()

    let st = newRequestState(explorer, req, config);

    await resolveRoute(explorer, req, st);

    // With a method named and the coin available, read the data from the database.
    if(!explorer.util.isNull(st.cfg.data.method) && st.validDataRequest){
        if(!validateParams(explorer, st))
            await loadData(explorer, req, st);

        if(!st.dbError && !st.badParam)
            assembleResponse(explorer, st);
    }

    applyFallbacks(explorer, st);

    await renderPage(explorer, st);

    sendResponse(explorer, req, res, st, host);
}

module.exports = { runRequest };
