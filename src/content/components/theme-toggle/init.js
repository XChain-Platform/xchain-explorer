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
 * theme-toggle / init.js
 *
 * The light/dark switch in the header gear menu. Reads and writes the same view-theme key xchain.js has always used.
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

    REG.register('theme-toggle', {

        props: {
            mode: { type: "string" }
        },

        mount: function(el, props, ctx){
            // Bound here rather than in initPage() so a theme that renders its switch
    // somewhere else - the M5 console theme puts it in a sidebar - gets the
    // behaviour by mounting the component, not by matching two hard-coded ids.
        if(!el) return { rendered: 'server' };
            var mode = props.mode;
            if(!mode && typeof localStorage !== 'undefined'){
                try { mode = localStorage.getItem('view-theme'); } catch(e){ mode = null; }
            }
            if(mode !== 'dark' && mode !== 'light') mode = 'light';
            if(typeof updateTheme === 'function') updateTheme(mode);
            return { rendered: 'server', mode: mode };
        }
    });

})();
