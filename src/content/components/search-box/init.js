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
 * search-box / init.js
 *
 * The header search form. Its coin field is filled from the page context so a search runs against the network being viewed.
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

    REG.register('search-box', {

        props: {
            coin: { type: "string" }
        },

        mount: function(el, props, ctx){
            // The form posts to /search on its own; the only thing that needs a runtime
    // is the hidden coin field, which decides WHICH network the search runs
    // against and is empty in the served markup.
        if(!el) return { rendered: 'server' };
            var coin = props.coin || (ctx && ctx.coin) || null;
            var field = el.querySelector('#coin-search');
            if(field && coin) field.value = coin;
            return { rendered: 'server', coin: coin };
        }
    });

})();
