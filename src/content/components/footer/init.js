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
 * footer / init.js
 *
 * The site footer: copyright line and the terms/privacy links. Composed server-side into the page shell.
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

    REG.register('footer', {

        props: {
            year: { type: "number" }
        },

        mount: function(el, props, ctx){
            // The year is written at mount rather than composed, deliberately: a composed
    // year would be baked into a cached page and go stale on New Year's Day.
        if(!el) return { rendered: 'server' };
            var year = props.year || new Date().getFullYear();
            var slot = el.querySelector('#copyright-year');
            if(slot) slot.textContent = String(year);
            return { rendered: 'server', year: year };
        }
    });

})();
