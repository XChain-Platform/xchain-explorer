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
 * Bridge panels for token.html and the XBRIDGE action detail card.
 *
 * Split out of the pages' inline scripts, on the xcall-timeline-render.js
 * precedent, so a test drives the real derivation with stubbed payloads.
 *
 * WHY A DERIVATION LAYER. The explorer is per-coin routed: a BTC explorer node
 * cannot read the DOGE ledger, so the per-chain supply of a bridged token is
 * not a query it can make. The numbers come from the hub's getbridgeinvariant
 * (tick -> chain -> {escrow, supply, in_flight, delta, finalized_policy_seq}),
 * and the hub is a REMOTE that can be unreachable, stale, or serving a tick it
 * has never signed a transfer for. Every one of those reads as "no rows" to a
 * naive renderer, i.e. exactly like a token with no bridged copies, which is
 * the one thing a holder must not be told by mistake. buildBridgeCopies
 * separates the three: unavailable (no payload at all), none (a payload that
 * genuinely carries no chain for this tick) and the real per-chain rows.
 *
 * The invariant is `escrow >= supply`, never equality (nothing refuses a
 * stranger's SEND to the escrow role address), so a POSITIVE delta is a surplus
 * and only a warning, while a NEGATIVE delta is a deficit and the alarm.
 ********************************************************************/

// Escape without jQuery so the module is drivable in isolation. The page also
// ships escapeHtml() in formatters.js; this is deliberately the same mapping.
function xbEsc(s){
    if(s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Presentation-only split of a rooted tick (`BTC.PEPECASH` -> origin BTC, name
// PEPECASH). NOT the consensus parse: the indexer's parseBridgedTick is the
// authority on whether a tick is bridged, and it also refuses a prefix equal to
// THIS chain's own coin. Here the caller passes the coin list it already has
// (XC.coins on the page), and a tick whose prefix is not in it is left whole,
// so an ordinary subasset such as `PEPECASH.CARD` never renders as bridged.
function bridgeOriginOf(tick, coins){
    if(tick === null || tick === undefined) return null;
    var s     = String(tick);
    var parts = s.split('.');
    if(parts.length !== 2) return null;
    if(!parts[0].length || !parts[1].length) return null;
    var known = (coins && coins.length) ? coins : [];
    var hit   = false;
    for(var i = 0; i < known.length; i++)
        if(String(known[i]).toUpperCase() === parts[0].toUpperCase()) hit = true;
    if(!hit) return null;
    return { origin: parts[0].toUpperCase(), name: parts[1] };
}

// Per-chain rows for one tick out of a getbridgeinvariant payload.
// Returns { state, rows }:
//   state 'unavailable' - no payload reached us (hub down, read refused). The
//                         caller must say so rather than render an empty table.
//   state 'none'        - a payload arrived and carries no chain for this tick.
//   state 'ok'          - rows, one per chain, sorted by chain name so two
//                         readers of the same token see the same order.
function buildBridgeCopies(invariant, tick){
    if(invariant === null || invariant === undefined) return { state: 'unavailable', rows: [] };
    var byTick = invariant[String(tick)];
    if(byTick === null || byTick === undefined) return { state: 'none', rows: [] };
    var chains = Object.keys(byTick).sort();
    var rows   = [];
    for(var i = 0; i < chains.length; i++){
        var e = byTick[chains[i]] || {};
        rows.push({
            chain:                 chains[i],
            escrow:                (e.escrow   === undefined) ? null : e.escrow,
            supply:                (e.supply   === undefined) ? null : e.supply,
            in_flight:             (e.in_flight === undefined) ? null : e.in_flight,
            delta:                 (e.delta    === undefined) ? null : e.delta,
            finalized_policy_seq:  (e.finalized_policy_seq === undefined) ? null : e.finalized_policy_seq,
            state:                 bridgeDeltaState(e.delta)
        });
    }
    if(!rows.length) return { state: 'none', rows: [] };
    return { state: 'ok', rows: rows };
}

// Sign of the invariant, read as a health state. An absent delta is 'unknown',
// never 'ok': a missing number must not paint a green badge.
function bridgeDeltaState(delta){
    if(delta === null || delta === undefined || delta === '') return 'unknown';
    var n = Number(delta);
    if(!isFinite(n)) return 'unknown';
    if(n < 0) return 'deficit';
    if(n > 0) return 'surplus';
    return 'ok';
}

// Badge chrome per state. Colour is carried by an --xc-bridge-* token in BOTH
// theme files (classic and skin-demo), never a literal here, so a skin can
// repaint it (D30).
var BRIDGE_STATE_BADGES = {
    ok:      { cls: 'xc-bridge-state-ok',      text: 'balanced' },
    surplus: { cls: 'xc-bridge-state-surplus', text: 'surplus'  },
    deficit: { cls: 'xc-bridge-state-deficit', text: 'deficit'  },
    unknown: { cls: 'xc-bridge-state-unknown', text: 'unknown'  }
};

function renderBridgeCopies(invariant, tick, thisChain){
    var built = buildBridgeCopies(invariant, tick);
    if(built.state === 'unavailable')
        return '<div class="small text-muted xc-bridge-unavailable">'
             + 'Per-chain totals come from the hub and the hub is not answering; '
             + 'this page is showing ' + xbEsc(thisChain) + ' state only.</div>';
    if(built.state === 'none')
        return '<div class="small text-muted xc-bridge-none">No bridged copies of this token.</div>';
    var html = '<table class="table table-sm table-striped table-bordered mb-0 no-outer-borders xc-bridge-copies">'
             + '<thead><tr><th>Chain</th><th>Supply</th><th>Escrow</th><th>In flight</th><th>Invariant</th><th>Policy seq</th></tr></thead><tbody>';
    for(var i = 0; i < built.rows.length; i++){
        var r  = built.rows[i];
        var st = BRIDGE_STATE_BADGES[r.state] || BRIDGE_STATE_BADGES.unknown;
        html += '<tr data-chain="' + xbEsc(r.chain) + '" data-state="' + xbEsc(r.state) + '"'
             +  ((String(r.chain) === String(thisChain)) ? ' class="xc-bridge-this-chain"' : '') + '>';
        html += '<td>' + xbEsc(r.chain) + '</td>';
        html += '<td class="xc-bridge-supply">'  + xbEsc(xbDash(r.supply))    + '</td>';
        html += '<td class="xc-bridge-escrow">'  + xbEsc(xbDash(r.escrow))    + '</td>';
        html += '<td class="xc-bridge-inflight">'+ xbEsc(xbDash(r.in_flight)) + '</td>';
        html += '<td><span class="badge xc-bridge-state ' + st.cls + '">' + xbEsc(st.text) + '</span> '
             +  '<span class="small text-muted xc-bridge-delta">' + xbEsc(xbDash(r.delta)) + '</span></td>';
        html += '<td class="xc-bridge-policy-seq">' + xbEsc(xbDash(r.finalized_policy_seq)) + '</td>';
        html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

function xbDash(v){
    return (v === null || v === undefined || v === '') ? '-' : v;
}

// The transfer list for one tick, both legs of every transfer on ONE row.
//
// WHY BOTH LEGS ON ONE ROW. A transfer is a single signed record
// (bridge_transfers, mirrored from the hub), not two: the source leg is
// src_chain/src_action_index/src_address and the destination leg is
// dest_chain/dest_address, and DIRECTION is derived from src_chain rather than
// stored. Rendering them as two rows would invent a pairing the record does not
// carry and would let a reader see half a transfer as a whole one.
//
// `status` is the retraction state: a row the federation co-signed away reads
// `retracted` and must stay visible, because a retracted transfer whose credit
// already applied on the destination is exactly the case the invariant alarm is
// about (base spec AT3c). Hiding it would hide the evidence.
function renderBridgeTransfers(rows, thisChain){
    if(rows === null || rows === undefined)
        return '<div class="small text-muted xc-bridge-transfers-unavailable">'
             + 'The bridge transfer list is not available on this node.</div>';
    if(!rows.length)
        return '<div class="small text-muted xc-bridge-transfers-none">No bridge transfers for this token.</div>';
    var html = '<table class="table table-sm table-striped table-bordered mb-0 no-outer-borders xc-bridge-transfers">'
             + '<thead><tr><th>Transfer</th><th>From</th><th>To</th><th>Amount</th>'
             + '<th>Snapshot block</th><th>Status</th></tr></thead><tbody>';
    for(var i = 0; i < rows.length; i++){
        var t         = rows[i] || {};
        var retracted = (String(t.status || '').toLowerCase() === 'retracted');
        // Direction is derived, never read from a column: an outbound row is one
        // whose source chain is the chain this page is served for.
        var outbound  = (String(t.src_chain) === String(thisChain));
        html += '<tr data-transfer="' + xbEsc(t.transfer_id) + '"'
             +  ' data-direction="' + (outbound ? 'out' : 'in') + '"'
             +  ' data-status="' + xbEsc(String(t.status || '')) + '"'
             +  (retracted ? ' class="xc-bridge-retracted"' : '') + '>';
        html += '<td class="font-monospace small xc-bridge-transfer-id">' + xbEsc(xbDash(t.transfer_id)) + '</td>';
        html += '<td class="xc-bridge-from">' + xbEsc(xbDash(t.src_chain)) + ' '
             +  '<span class="small text-muted">' + xbEsc(xbDash(t.src_address)) + '</span></td>';
        html += '<td class="xc-bridge-to">' + xbEsc(xbDash(t.dest_chain)) + ' '
             +  '<span class="small text-muted">' + xbEsc(xbDash(t.dest_address)) + '</span></td>';
        html += '<td class="xc-bridge-amount">' + xbEsc(xbDash(t.amount)) + '</td>';
        html += '<td class="xc-bridge-snapshot-block">' + xbEsc(xbDash(t.snapshot_block)) + '</td>';
        html += '<td><span class="badge xc-bridge-state '
             +  (retracted ? 'xc-bridge-state-deficit' : 'xc-bridge-state-ok') + '">'
             +  xbEsc(xbDash(t.status)) + '</span></td>';
        html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

// Origin link for a bridged row: `BTC.PEPECASH` renders as PEPECASH with a
// badge naming the origin chain, linking to the token page on that chain.
function renderBridgeOrigin(tick, coins){
    var split = bridgeOriginOf(tick, coins);
    if(!split) return '';
    return '<a class="badge xc-bridge-origin text-decoration-none" '
         + 'href="/' + xbEsc(split.origin) + '/token/' + encodeURIComponent(tick) + '">'
         + 'origin ' + xbEsc(split.origin) + '</a>';
}

// Applied policy panel for a bridged copy (getappliedpolicy). `applied` is null
// on a native row and on any chain that has applied no snapshot yet; the two
// are distinguished by the caller, which only shows this panel for a bridged
// row at all.
function renderBridgePolicy(applied){
    if(applied === null || applied === undefined)
        return '<div class="small text-muted xc-bridge-policy-none">No policy snapshot has been applied to this copy.</div>';
    var rows = [
        ['Applied seq',   applied.policy_seq],
        ['Origin block',  applied.origin_block],
        ['Policy hash',   applied.policy_hash],
        ['Allow list',    applied.allow_list_action_index],
        ['Block list',    applied.block_list_action_index],
        ['Sleeping',      (applied.sleeping === null || applied.sleeping === undefined)
                            ? null : (Number(applied.sleeping) ? 'yes' : 'no')]
    ];
    var html = '<table class="table table-sm table-striped table-bordered mb-0 no-outer-borders xc-bridge-policy"><tbody>';
    for(var i = 0; i < rows.length; i++)
        html += '<tr><th>' + xbEsc(rows[i][0]) + '</th><td>' + xbEsc(xbDash(rows[i][1])) + '</td></tr>';
    html += '</tbody></table>';
    return html;
}

// The six XBRIDGE formats, by the version each action_format carries. v2 and v5
// are mirror-injected and carry no user format at all, which is why they are
// labelled as settlements and never offered a "broadcast" reading.
var XBRIDGE_VERSIONS = {
    0: { label: 'Lock (v0)',         leg: 'lock',   injected: false, asset: 'gas'   },
    1: { label: 'Burn (v1)',         leg: 'burn',   injected: false, asset: 'gas'   },
    2: { label: 'Settle (v2)',       leg: 'settle', injected: true,  asset: 'gas'   },
    3: { label: 'Token lock (v3)',   leg: 'lock',   injected: false, asset: 'token' },
    4: { label: 'Token burn (v4)',   leg: 'burn',   injected: false, asset: 'token' },
    5: { label: 'Token settle (v5)', leg: 'settle', injected: true,  asset: 'token' }
};

function xbridgeVersionInfo(format){
    if(format === null || format === undefined) return null;
    var n = Number(format);
    if(!isFinite(n)) return null;
    return XBRIDGE_VERSIONS[n] || null;
}

// The XBRIDGE detail card. `d` is the getActionData row: action_format is the
// version, and bridge_settlement / bridge_pending come from the explorer's
// XBRIDGE handler (src/action-detail/tokens.js).
function renderXbridgeAction(d){
    var info = xbridgeVersionInfo(d ? d.action_format : null);
    if(!info)
        return '<div class="small text-muted xc-bridge-unknown-version">Unknown XBRIDGE version.</div>';
    var s    = (d && d.bridge_settlement) ? d.bridge_settlement : null;
    var html = '<table class="table table-sm table-striped table-bordered mb-0 no-outer-borders xc-bridge-action" '
             + 'data-leg="' + xbEsc(info.leg) + '" data-injected="' + (info.injected ? '1' : '0') + '"><tbody>';
    html += row('Format', xbEsc(info.label));
    html += row('Origin', info.injected
        ? 'Mirror-injected from a finalized bridge transfer'
        : 'Broadcast by the source address');
    html += row('Asset', (info.asset === 'gas') ? 'XCHAIN (gas)' : 'Bridged token');
    html += row('Token', xbEsc(xbDash(d ? d.tick : null)));
    html += row('Transfer', xbEsc(xbDash(d ? d.transfer_id : null)));
    if(s){
        html += row('Source leg', xbEsc(xbDash(s.src_chain)) + ' #' + xbEsc(xbDash(s.src_action_index)));
        html += row('Destination', xbEsc(xbDash(s.dest_chain)) + ' ' + xbEsc(xbDash(s.dest_address)));
        html += row('Settled in block', xbEsc(xbDash(s.block_index)));
    } else if(d && d.bridge_pending && !info.injected){
        // In flight, not missing: the settle for this leg is applied on the OTHER
        // chain, so this node has no record of it by construction.
        html += row('Settlement', '<span class="badge xc-bridge-state xc-bridge-state-unknown">in flight</span> '
            + '<span class="small text-muted">settles on the destination chain</span>');
    }
    html += '</tbody></table>';
    return html;

    function row(label, value){
        return '<tr><th class="text-muted fw-normal">' + xbEsc(label) + '</th>'
             + '<td class="xc-bridge-' + xbEsc(String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '">'
             + value + '</td></tr>';
    }
}

// Node-side export for the unit tier, the same shape formatters.js ships: the
// browser defines the globals above and ignores this block.
if(typeof module !== 'undefined' && module.exports){
    module.exports = {
        xbEsc: xbEsc, bridgeOriginOf: bridgeOriginOf, buildBridgeCopies: buildBridgeCopies,
        bridgeDeltaState: bridgeDeltaState, renderBridgeCopies: renderBridgeCopies, xbDash: xbDash,
        renderBridgeTransfers: renderBridgeTransfers, renderBridgeOrigin: renderBridgeOrigin,
        renderBridgePolicy: renderBridgePolicy, xbridgeVersionInfo: xbridgeVersionInfo,
        renderXbridgeAction: renderXbridgeAction
    };
}
