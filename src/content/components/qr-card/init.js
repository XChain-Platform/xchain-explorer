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
 * qr-card / init.js
 *
 * The address QR panel. Renders into an existing mount point using the page jquery.qrcode build.
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

    REG.register('qr-card', {

        props: {
            id: { type: "string", required: true },
            text: { type: "string", required: true },
            size: { type: "number", default: 180 }
        },

        mount: function(el, props, ctx){
            // The QR is drawn by the vendored jquery.qrcode plugin, so this mount is a
    // guard and a size policy rather than a renderer: it refuses loudly when the
    // plugin is absent, which otherwise shows as an empty square.
        if(!el) throw new Error('no mount point');
            if(typeof jQuery === 'undefined' || typeof jQuery.fn.qrcode !== 'function')
                throw new Error('jquery.qrcode is not loaded');
            jQuery(el).empty().qrcode({ width: props.size, height: props.size, text: props.text });
            return { id: props.id, size: props.size };
        }
    });

})();
