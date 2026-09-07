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
 * stat-card / init.js
 *
 * A collapsible card holding a label/value table. The repeating summary block on coin_home, address, token, market and dispenser.
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

    REG.register('stat-card', {

        props: {
            id: { type: "string", required: true },
            title: { type: "string", required: true },
            icon: { type: "string", default: "fa-info-circle" },
            open: { type: "boolean", default: true },
            rows: { type: "array" }
        },

        mount: function(el, props, ctx){
            // A stat card is markup the page already carries; what the mount adds is the
    // row ORDER and the collapse state. It never rewrites the row cells: the
    // per-page render functions address them by class, and regenerating them
    // here would break every one of those call sites at once.
        var el2 = el;
            if(!el2) throw new Error('no mount point');
            el2.classList.remove('d-none');
            if(props.rows && props.rows.length)
                REG.permuteRows(el2.querySelector('tbody'), props.rows);
            return { id: props.id, rows: props.rows || [] };
        }
    });

})();
