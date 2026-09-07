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
 * chart / init.js
 *
 * A Chart.js canvas with the explorer toolbar. Wraps the existing xchain-charts.js entry points so a theme can move a chart without touching the chart code.
 *
 * Declared props live in component.json beside this file; they are restated in
 * the register() call because the runtime validates against what it was given,
 * and a JSON file the browser never fetches could drift from it unnoticed. A
 * unit test holds the two in agreement.
 */

(function(){

    'use strict';

    // The registry, from wherever this file is running. In the browser it is the
    // global components.js already installed; under Node it is the same module,
    // required, so a suite can drive the SHIPPED mount rather than a copy of it.
    var REG = (typeof XCComponents !== 'undefined')
        ? XCComponents
        : ((typeof require === 'function') ? require('../../js/components.js') : null);
    if(!REG) return;

    REG.register('chart', {

        props: {
            id: { type: "string", required: true },
            kind: { type: "string", required: true },
            options: { type: "object" }
        },

        mount: function(el, props, ctx){
            // Charts already have a home in xchain-charts.js; this exists so a layout can
    // place one declaratively. It delegates rather than wrapping Chart.js again,
    // because two chart layers would drift.
        if(!el) throw new Error('no mount point');
            if(typeof XCCharts === 'undefined' || typeof XCCharts.build !== 'function')
                return { id: props.id, kind: props.kind, deferred: true };
            return XCCharts.build(el, props.kind, props.options || {});
        }
    });

})();
