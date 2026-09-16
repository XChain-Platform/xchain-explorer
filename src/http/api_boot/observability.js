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
 * XChain Explorer - the /metrics endpoint and the structured log shim
 *
 * One boot step of src/api.js, mounted after the shedding guards so an enabled
 * scrape endpoint is governed by them like any other route. The observability
 * module itself is vendored (src/observability/); this step is only the
 * explorer's wiring of it.
 *
 ********************************************************************/

'use strict';

const { installObservability } = require('../../observability');   // default-off /metrics + structured log shim

/**
 * Wire metrics and log shipping, both DEFAULT OFF.
 *
 * Nothing registers or starts a timer unless METRICS_ENABLED (and, for log
 * shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) is set. Wired after the rate limiter and
 * concurrency gate so an enabled scrape endpoint sheds like any other route;
 * gate it with METRICS_TOKEN or a proxy ACL on a public box. The
 * request-timing middleware hoists itself to the front of the stack, so it
 * still measures the routes registered above. See src/observability/README.md.
 *
 * @param {object} app the express app
 * @param {object} configInfo src/config.js, for its live env view
 */
function applyObservability(app, configInfo){
    let version = '';
    try { version = require('../../../package.json').version; } catch { /* version label is cosmetic */ }
    installObservability(app, {
        service: 'xchain-explorer',
        version: version,
        network: configInfo.env.NETWORK || ''
    });
}

module.exports = { applyObservability };
