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
 * XChain Explorer - the route table
 *
 * One place the three table modules are joined, in the order setupUrls() declared
 * them, so the `urls` object a caller reads has the same keys in the same order it
 * always had. A fresh object per call: `this.urls` is per-instance state and two
 * explorers in one process (every suite that builds more than one) must not be
 * able to reach each other through it.
 *
 ********************************************************************/

'use strict';

const staticAndHtml = require('./static_and_html.js');
const apiMethods    = require('./api_methods.js');
const explorerFeeds = require('./explorer_feeds.js');

/**
 * Every URL the explorer answers, grouped by how each group is served.
 * @returns {{static: string[], html: object, api: object, explorer: object}}
 */
function routeTables(){
    return Object.assign({}, staticAndHtml, apiMethods, explorerFeeds);
}

module.exports = { routeTables };
