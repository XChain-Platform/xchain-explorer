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
 * browser_logger.js
 *
 * The one file the first-party browser scripts log through, so the console is
 * touched in one place. Each level is the console method of the same name with
 * the caller's arguments unchanged; XC.debug === false silences log and debug.
 */

var XCLogger = (function(){

    'use strict';

    // Levels XC.debug === false silences; info, warn and error always print.
    var DEBUG_TIER = { log: true, debug: true };

    // Read per call: xchain.js defines XC after formatters.js and components.js
    // have already loaded and may have logged.
    function debugSilenced(){
        return typeof XC !== 'undefined' && XC !== null && XC.debug === false;
    }

    // Look the console method up per call so a replaced console.error (a test
    // spy, a devtools override) still receives every line.
    function level(method){
        return function(){
            if(DEBUG_TIER[method] && debugSilenced()) return;
            if(typeof console === 'undefined' || typeof console[method] !== 'function') return;
            console[method].apply(console, arguments);
        };
    }

    return {
        log:   level('log'),
        debug: level('debug'),
        info:  level('info'),
        warn:  level('warn'),
        error: level('error')
    };

})();

// Node (the unit suites) requires this file; the browser ignores this block.
if(typeof module !== 'undefined' && module.exports)
    module.exports = XCLogger;
