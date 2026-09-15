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
 *
 * XChain Explorer - paging a result set into one page
 *
 * getPagingDataResults answered every list request by working out the page window,
 * walking the rows and shaping each one inline, which put the whole explorer row
 * catalogue in the middle of the method that pages it. The method still lives here
 * and still does those three things in that order; each is now a named step under
 * paging/.
 *
 * HOW THIS ATTACHES
 *
 * The method is authored as a class body and exported as that class's prototype,
 * so XChainExplorer.js can copy it onto its own prototype verbatim (see
 * explorer/install.js). Nothing here is ever instantiated: `this` is the explorer
 * instance at call time, exactly as it was when the method sat inline.
 *
 ********************************************************************/

'use strict';

const { pagingWindow } = require('./paging/window.js');
const { collectPage }  = require('./paging/page.js');

class Paging {

    // Walk the rows the database returned and hand back only the ones this
    // request asked to see, honouring its paging position and limit.
    getPagingDataResults(config, data, total){
        let cfg    = config;
        let method = cfg.data.method;
        let win    = pagingWindow(this.util, this.db, cfg);

        // A search wraps its rows one level deeper; page over those rows.
        if(method=='getSearch')
            data = data.data;

        let show = collectPage(this.util, cfg, data, total, win);

        // Paging backwards built the page in reverse, so flip it back before returning.
        if(['prev','last'].includes(win.action))
            show = show.reverse();

        return show;
    }
}

module.exports = { methods: Paging.prototype };
