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
 * Unit tests for processRequest response formatting in src/XChainExplorer.js
 *
 * Covers:
 *   - API response shape (total, data, ksort, runtime)
 *   - Explorer response shape (recordsTotal, recordsFiltered, query.total override)
 *   - Special method top-level fields (getBalances, getHolders, getSearch)
 *   - Error responses (503 unsupported coin, 400 null data, 404 no match)
 *   - Headers (XChain-Explorer-Version, Access-Control-Allow-Origin, XChain-Runtime-Ms)
 *   - JSON serialization (jsonStringify, Content-Type)
 *   - HTML responses (template + content file, {CONTENT} replacement)
 */

'use strict';

const { sinon, state } = require('./explorer_response.test/helpers.js');

// Undo every stub or spy a test installed and put the shared getData result back to
// empty, so one test's fakes cannot leak into the next and make it pass for the
// wrong reason.
afterEach(function () {
    sinon.restore();
    state.getDataResult = [[], null];
});

require('./explorer_response.test/api.js');
require('./explorer_response.test/special.js');
require('./explorer_response.test/errors.js');
require('./explorer_response.test/serialization.js');
