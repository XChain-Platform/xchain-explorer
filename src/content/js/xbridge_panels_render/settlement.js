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
 * Render user-leg settlement state.
 */

// Format a protocol-time instant as UTC, or a dash when it is not one.
function xbUtc(seconds){
    var n = Number(seconds);
    return (isFinite(n) && n > 0) ? new Date(n * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-';
}

function xbridgeUserLegSettlement(d, row, esc, dash){
    var state = String(d.bridge_transfer_status || '').toLowerCase(), dest = d.dest_chain || (d.bridge_transfer || {}).dest_chain;
    var badge = function(cls, text, note){
        return row('Settlement', '<span class="badge xc-bridge-state ' + cls + '">' + text + '</span> <span class="small text-muted">' + note + '</span>');
    };
    // Refuse settlement for a leg that moved nothing.
    if(/^invalid/i.test(String(d.status || ''))) return row('Settlement', '<span class="small text-muted">none: the action was refused</span>');
    if(state === 'finalized')
        return badge('xc-bridge-state-ok', 'finalized', 'applies on ' + esc(dash(dest)) + ' at ' + esc(xbUtc(d.bridge_effective_time)));
    if(state === 'retracted') return badge('xc-bridge-state-deficit', 'retracted', 'the federation withdrew this transfer');
    return d.bridge_pending ? badge('xc-bridge-state-unknown', 'in flight', 'settles on the destination chain') : '';
}

if(typeof module !== 'undefined' && module.exports)
    module.exports = { xbridgeUserLegSettlement: xbridgeUserLegSettlement };
