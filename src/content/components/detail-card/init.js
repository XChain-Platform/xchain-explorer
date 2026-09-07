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
 * detail-card / init.js
 *
 * One per-type ACTION detail block: a label/value table whose rows are config, so a theme can resequence or drop them without the page emitting different markup.
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

    REG.register('detail-card', {

        props: {
            type: { type: "string", required: true },
            rows: { type: "array" },
            reveal: { type: "boolean", default: true }
        },

        mount: function(el, props, ctx){
            // The markup stays in action.html by ruling (M2.5 says keep it and mount it),
    // so this does not render rows - it reveals the block and applies the
    // theme's row order. Rendering them here would mean reproducing 317 rows of
    // hand-tuned markup, whose only benefit would be moving the same bytes.
        if(!el) throw new Error('no mount point');
            if(props.reveal !== false) el.classList.remove('d-none');
            if(props.rows && props.rows.length)
                REG.permuteRows(el.querySelector('tbody'), props.rows);
            return { type: props.type, rows: props.rows || [] };
        }
    });

})();
