'use strict';

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
 * Unit tests for URL matching and cfg construction in XChainExplorer.processRequest()
 *
 * Strategy: proxyquire replaces express and db/index.js so the class can be instantiated
 * without a real database or HTTP server.  A MockDB captures the cfg object passed
 * to getData(), letting each test inspect what processRequest() built from the URL.
 */

const { makeExplorer, state } = require('./explorer_routing.test/support/helpers.js');

describe('XChainExplorer.processRequest – routing', function () {

    before(function () {
        state.explorer = makeExplorer();
    });

    require('./explorer_routing.test/support/parsing.js');
    require('./explorer_routing.test/support/responses.js');
    require('./explorer_routing.test/support/freshness.js');
    require('./explorer_routing.test/support/remaining.js');
});
