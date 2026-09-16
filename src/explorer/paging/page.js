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
 * XChain Explorer - walking one page of rows
 *
 * The loop that decides which of the rows the database returned this request
 * actually sees, and what shape each one goes out in. It counts every row so the
 * display numbering stays continuous across pages, keeps the ones inside the
 * window, and hands an explorer row to the branch table that draws it.
 *
 * Split out of getPagingDataResults with its body unchanged: the counters, the
 * keep test and the push are the same statements in the same order, reading the
 * window the caller worked out instead of computing it inline.
 *
 ********************************************************************/

'use strict';

const { explorerRow } = require('./explorer_row.js');

/**
 * Walk the result set and collect the rows this page shows.
 *
 * @param {object} util the explorer's utility helper
 * @param {object} cfg the request config
 * @param {Array} data the rows the database returned
 * @param {number} total the full record count the query reported
 * @param {object} win the page window pagingWindow() worked out
 * @returns {Array} the rows to send, in the order they were collected
 */
function collectPage(util, cfg, data, total, win){
    let type   = cfg.type;
    let method = cfg.data.method;
    let { start, limit, offset, action, cursorLast } = win;

    // Placeholder for the results we will actually show
    let show          = [];
    let cnt           = (offset) ? start : 0;
    let count         = 0;
    let count_reverse = 0;

    // Loop through data and determine what to return to use
    for(let idx in data){
        cnt++;
        idx++;

        // Keep track of display count separate from actual count
        count = cnt;

        // Paging backwards returns the rows reversed, so the displayed count
        // has to be worked out from the other end.
        if(['prev','last'].includes(action))
            count = util.bcadd(start,util.bcsub(data.length, util.bcsub(idx, 1)),0);

        // Reverse-count: total minus (count-1), used because latest is first in most cases
        count_reverse = util.bcsub(total,util.bcsub(count, 1),0);

        // Keep only the rows inside the window this request asked for.
        if((cnt > start && cnt <= limit) || offset || cursorLast){
            let info   = data[idx-1];
            // API requests return each row's fields under their own names.
            if(type=='api'){
                // Holders: hoist token-level fields to top; pass only address+amount per row
                if(method=='getHolders'){
                    info = {
                        'address': info.address,
                        'amount':  info.amount
                    };
                }
            }
            info = explorerRow(util, info, { cfg, type, method, count, count_reverse });

            show.push(info);

        }
    }
    return show;
}

module.exports = { collectPage };
