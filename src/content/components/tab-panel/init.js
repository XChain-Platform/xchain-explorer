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
 * tab-panel / init.js
 *
 * The tabbed table panel with a dropdown selector: coin_home, address and token each carry one, holding a dozen or more data-table instances.
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

    REG.register('tab-panel', {

        props: {
            id: { type: "string", required: true },
            tabs: { type: "array", required: true },
            active: { type: "string" }
        },

        mount: function(el, props, ctx){
            // Bootstrap owns the tab behaviour and keeps owning it: this reorders the
    // buttons and their panes to match the config, and picks the active tab.
    // Re-implementing tab switching would trade a maintained implementation for
    // one that has to be kept in step with the classic theme's Bootstrap build.
        if(!el) throw new Error('no mount point');
            var order = REG.resolveOrder(props.tabs);
            var i, key, node;
            var list = el.ownerDocument ? el.ownerDocument.querySelector('[data-xc-tabs="' + props.id + '"]') : null;
            if(list){
                var buttons = [];
                for(i = 0; i < order.length; i++){
                    key  = props.tabs[order[i]].key;
                    node = list.querySelector('[data-xc-tab="' + key + '"]');
                    if(node) buttons.push(node);
                }
                for(i = 0; i < buttons.length; i++) list.appendChild(buttons[i]);
            }
            var active = props.active;
            if(!active && order.length) active = props.tabs[order[0]].key;
            return { id: props.id, active: active, tabs: order.map(function(i){ return props.tabs[i].key; }) };
        }
    });

})();
