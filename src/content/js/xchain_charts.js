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
 * XChain chart layer (XCC)
 *
 * Thin adapter between the explorer's market data and Chart.js (MIT). It exists
 * because the explorer previously drove Highstock, which is proprietary and
 * cannot be redistributed from a public AGPL repo. Chart.js has no stock-chart
 * preset, so the pieces Highstock gave us for free - the zoom range selector,
 * the HTML tooltip tables, the PNG export button, the price-over-volume pane
 * split - are rebuilt here once and shared by all three market chart views.
 *
 * Everything above the "browser layer" marker is pure and runs under Node, so
 * the range math, tooltip markup and chart configs are unit tested without a
 * DOM. See test/unit/content-charts.test.js.
 */
'use strict';

var xcChartsDataModule = (typeof module === 'object' && module.exports)
    ? require('./xchain_charts/data.js') : null;
var xcChartsConfigsModule = (typeof module === 'object' && module.exports)
    ? require('./xchain_charts/configs.js') : null;

function xcChartsCreateApi(data, configs){
    return Object.assign({}, data, configs);
}

(function(root, factory){
    if(typeof module === 'object' && module.exports)
        module.exports = factory(xcChartsDataModule, xcChartsConfigsModule);
    else
        root.XCC = factory(root.XCC || {}, {});
})(typeof self !== 'undefined' ? self : this, xcChartsCreateApi);
