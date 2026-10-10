/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * action_system_summaries.js
 *
 * Compact summaries for system actions that refer to feeds, epochs, bridges,
 * and expired obligations. Split from action_detail.js to keep that page part
 * within its size limit.
 */

function actionDetail_renderSystemActions(html, action, info, coin){
    if(!info || typeof info !== 'object') return html;
    if(action=='BET_EXPIRE'){
        if(isNull(info.feed_action_index)) return html;
        html = 'Expired bet feed ' + formatLink('/' + coin + '/action/' + info.feed_action_index, info.feed_action_index);
        if(!isNull(info.refund_count)){
            let n = Number(info.refund_count);
            html += ', ' + n + ' refund' + (n === 1 ? '' : 's');
            if(n > 0 && !isNull(info.tick) && !isNull(info.refund_amount))
                html += ' totalling ' + formatLinkAmount(tokenUrl(coin, info.tick), info.tick, info.tick, info.refund_amount);
        }
        return html;
    }
    if(action=='ROLLCALL'){
        if(isNull(info.epoch_height)) return html;
        return 'Roll call for epoch ' + numeral(info.epoch_height).format('0,0');
    }
    if(action=='XBRIDGE'){
        if(isNull(info.dest_chain)) return html;
        html = 'Bridge ';
        if(!isNull(info.tick))
            html += formatLink(tokenUrl(coin, info.tick), info.tick, info.tick) + ' ';
        html += 'to ' + escapeHtml(String(info.dest_chain));
        if(!isNull(info.dest_address)) html += ' ' + escapeHtml(String(info.dest_address));
        if(!isNull(info.bridge_kind)) html += ' (' + escapeHtml(String(info.bridge_kind)) + ')';
        return html;
    }
    if(action=='COINPAY_EXPIRE'){
        if(isNull(info.obligation_action_index)) return html;
        return 'Expired obligation ' + formatLink('/' + coin + '/action/' + info.obligation_action_index, info.obligation_action_index);
    }
    return html;
}
