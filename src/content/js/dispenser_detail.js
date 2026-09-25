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
 * One dispenser's page, /{COIN}/dispenser/{action_index}: what it sells, at what
 * price, what is left in escrow and how many fills that buys, read from the
 * DISPENSER action (its `state` block is the live remainder). The action page
 * shows the transaction; this page shows the dispenser, and its dispenses table
 * below is the fills feed scoped to this one dispenser.
 *
 * Every on-chain string reaches .html() through escapeHtml or a formatter that
 * escapes, and the row builder is a plain function of the record so it can be
 * tested without a page.
 *
 ********************************************************************/

// floor(remaining / perFill) on plain decimal strings, exactly: the two are
// scaled to a common number of places and divided as integers, so 0.3 / 0.1 is
// 3 and not the 2 a float division floors to. Null when either is unusable.
function dispenserFillsLeft(remaining, perFill){
    const re = /^\d+(\.\d+)?$/;
    if(!re.test(String(remaining)) || !re.test(String(perFill))) return null;
    const [rw, rf = ''] = String(remaining).split('.');
    const [pw, pf = ''] = String(perFill).split('.');
    const scale = Math.max(rf.length, pf.length);
    const r = BigInt(rw + rf.padEnd(scale, '0'));
    const p = BigInt(pw + pf.padEnd(scale, '0'));
    if(p === 0n) return null;
    return (r / p).toString();
}

// The price one fill costs: a fiat amount (oracle- or validator-priced), a
// token amount, or the native coin.
function dispenserPriceHtml(coin, d){
    if(!isNull(d.fiat_code) && !isNull(d.fiat_amount)){
        const how = isNull(d.oracle_address) ? 'validator-priced' : 'oracle-priced';
        return escapeHtml(d.fiat_amount) + ' ' + escapeHtml(d.fiat_code) + ' <span class="text-muted">(' + how + ')</span>';
    }
    if(!isNull(d.get_tick))
        return formatLinkAmount(tokenUrl(isNull(d.get_coin) ? coin : d.get_coin, d.get_tick), d.get_tick, d.get_tick, d.get_amount);
    return formatNativeCoinLeg(d.get_amount, d.get_coin);
}

// Status as the reader needs it: an invalid DISPENSER never opened, so its
// consensus reason wins over any state; otherwise the live state (open, closed,
// expired...).
function dispenserStatusHtml(d){
    const status = String(d.status || '');
    if(status && status !== 'valid')
        return '<span class="text-danger">' + escapeHtml(status) + '</span>';
    const live = d.state && d.state.status ? String(d.state.status) : 'unknown';
    const cls  = (live === 'open') ? 'text-success' : 'text-muted';
    return '<span class="' + cls + ' fw-bold">' + escapeHtml(live) + '</span>';
}

/**
 * The detail card's rows for one DISPENSER action record, as [label, html]
 * pairs in display order.
 */
function dispenserDetailRows(coin, d){
    const state     = d.state || {};
    const ownership = Number(d.give_ownership) === 1;
    const remaining = isNull(state.give_remaining) ? null : String(state.give_remaining);
    const selling   = ownership
        ? formatLink(tokenUrl(coin, d.give_tick), d.give_tick, d.give_tick) + ' ' + ownershipBadge()
        : formatLinkAmount(tokenUrl(coin, d.give_tick), d.give_tick, d.give_tick, d.give_amount) + ' <span class="text-muted">per fill</span>';
    const fills = ownership ? (remaining === '1' ? '1' : '0') : dispenserFillsLeft(remaining, d.give_amount);
    const addr  = (a) => isNull(a) ? '-' : formatLink('/' + coin + '/address/' + a, a);
    const expiration = isNull(state.expiration || d.expiration) ? '-' : formatLivestamp(state.expiration || d.expiration);
    const list = (idx) => isNull(idx) ? 'none' : formatLink('/' + coin + '/action/' + idx, 'list #' + idx);
    return [
        ['Status',            dispenserStatusHtml(d)],
        ['Selling',           selling],
        ['Price per fill',    dispenserPriceHtml(coin, d)],
        ['Left in escrow',    ownership ? '-' : (isNull(remaining) ? '-' : formatAmount(remaining) + ' ' + escapeHtml(d.give_tick)
                                + ' <span class="text-muted">of ' + formatAmount(d.give_escrow) + ' escrowed</span>')],
        ['Fills remaining',   isNull(fills) ? '-' : formatAmount(fills)],
        ['Dispenses',         '<span id="dispenser-index-dispense-count">0</span>'],
        ['Pay-to address',    addr(d.get_address)],
        ['Owner',             addr(d.source)],
        ['Opened',            formatLink('/' + coin + '/block/' + d.block_index, formatAmount(d.block_index)) + ' ' + formatLivestamp(d.timestamp)],
        ['Expiration',        expiration],
        ['Allow / block list', list(d.allow_list) + ' / ' + list(d.block_list)],
        ['Transaction',       formatLink('/' + coin + '/action/' + d.action_index, 'DISPENSER action #' + d.action_index)],
    ];
}

// Fill the card, or say why there is nothing to show.
function renderDispenserDetail(coin, d){
    const rows = dispenserDetailRows(coin, d)
        .map(([label, html]) => '<tr><th class="w-25">' + escapeHtml(label) + '</th><td>' + html + '</td></tr>')
        .join('');
    $('#dispenser-detail-rows').html(rows);
}

function renderDispenserMessage(msg, tone){
    $('#dispenser-detail-rows').html('<tr><td colspan="2" class="text-' + tone + '">' + escapeHtml(msg) + '</td></tr>');
}
