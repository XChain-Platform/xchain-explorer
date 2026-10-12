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
 * Unit tests for XChainExplorer.getPagingDataResults(config, data, total)
 */

const { makeExplorer, state } = require('./explorer_paging.test/support/helpers.js');

describe('XChainExplorer.getPagingDataResults', function () {

    before(function () {
        state.explorer = makeExplorer();
    });

    require('./explorer_paging.test/support/pagination.js');
    require('./explorer_paging.test/support/methods.js');
    require('./explorer_paging.test/support/search.js');
});
