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
 * Supply-stats and holder-ranking renders for rich_list.html (spec
 * explorer-coverage-completion M5.2). Split out of the page so a test can drive
 * the shipped render path against stubbed /api/rich_list payloads.
 *
 * Three rules in here are substance rather than presentation:
 *
 *  1. THE RANKING IS A TOP-N, AND IT SAYS SO. The server caps the ranking at
 *     the request limit (100 max) while counting holders separately, so the
 *     page can say "top 100 of 4,812 holders". A truncated list rendered as if
 *     it were the whole distribution is the standard way a rich list lies.
 *
 *  2. SUPPLY DISAGREEMENT IS SHOWN, NOT SMOOTHED. The token's own `supply` and
 *     the sum of every non-zero balance should be equal. When they are not, the
 *     index has a real problem, and the page surfaces the gap instead of
 *     silently switching denominators so the percentages add to 100.
 *
 *  3. A MISSING PERCENT IS NOT ZERO. getRichList returns null for a percentage
 *     it could not compute (zero or unreadable supply). Rendering that as 0%
 *     would tell a reader the largest holder owns none of the token.
 */

// Page-local escape. Ticks, descriptions and addresses are attacker-controlled
// on-chain bytes; nothing below reaches the DOM unescaped.
function richListEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

// A percent value as text, or an explicit unmeasured marker. Never "0%".
function richListPercent(value){
    if(isNull(value)) return '<span class="text-muted rich-list-percent-unknown">n/a</span>';
    return richListEsc(numeral(Number(value)).format('0,0.0000')) + '%';
}

// Is the summed holder balance materially different from the recorded supply?
// Compared as strings through the shared numeric helper rather than by ===,
// because both arrive from VARCHAR columns with different trailing forms
// ('100' vs '100.00000000') that are the SAME number.
function richListSupplyMismatch(d){
    if(!d || isNull(d.supply) || isNull(d.held_total)) return false;
    if(!isNumeric(String(d.supply)) || !isNumeric(String(d.held_total))) return false;
    return Number(d.supply) !== Number(d.held_total);
}

// The supply/consensus panel: what exists, what is held, and how concentrated.
function renderRichListSupply(d){
    if(!d) return '<tr><td class="text-muted">No supply data.</td></tr>';
    let row = function(label, value){
        return '<tr><th class="text-muted fw-normal rich-list-label">' + richListEsc(label) + '</th>'
             + '<td>' + value + '</td></tr>';
    };
    let html = '';
    html += row('Circulating supply', richListEsc(numeral(Number(d.supply)).format('0,0[.][00000000]')));
    html += row('Maximum supply', isNull(d.max_supply)
        ? '<span class="text-muted">-</span>'
        : richListEsc(numeral(Number(d.max_supply)).format('0,0[.][00000000]'))
          + (Number(d.lock_max_supply) === 1
              ? ' <span class="badge text-bg-secondary rich-list-ceiling-locked">locked</span>'
              : ' <span class="badge text-bg-warning rich-list-ceiling-open">can still rise</span>'));
    html += row('Holders', richListEsc(numeral(Number(d.holder_count)).format('0,0'))
        + ' <span class="small text-muted">(addresses with a non-zero balance)</span>');
    html += row('Largest holder', richListPercent(d.top_holder_percent) + ' of circulating supply');
    // Null when fewer than ten holders were ranked. Saying so beats printing a
    // concentration figure computed over three addresses.
    html += row('Top 10 holders', isNull(d.top_ten_percent)
        ? '<span class="text-muted rich-list-topten-unmeasured">not measured: fewer than 10 ranked holders</span>'
        : richListPercent(d.top_ten_percent) + ' of circulating supply');
    if(richListSupplyMismatch(d))
        html += row('Balances recorded',
            '<span class="text-warning rich-list-supply-mismatch">'
            + richListEsc(numeral(Number(d.held_total)).format('0,0[.][00000000]'))
            + '</span> <span class="small text-muted">held across all addresses, which does not match'
            + ' the recorded supply above. Both figures are shown as stored.</span>');
    return html;
}

// The ranking table. Rank numbers come from the server (they carry the page
// offset), so a second page continues at 101 rather than restarting at 1.
function renderRichListHolders(d){
    let rows = (d && Array.isArray(d.holders)) ? d.holders : [];
    if(!rows.length)
        return '<div class="text-muted p-2 rich-list-empty">No address holds a non-zero balance of this token.</div>';
    let html = '<table class="table table-sm table-striped mb-0 rich-list-table"><thead><tr>'
             + '<th class="text-muted fw-normal">#</th>'
             + '<th class="text-muted fw-normal">Address</th>'
             + '<th class="text-muted fw-normal text-end">Balance</th>'
             + '<th class="text-muted fw-normal text-end">Share</th>'
             + '</tr></thead><tbody>';
    rows.forEach(function(r){
        html += '<tr class="rich-list-row" data-rank="' + richListEsc(r.rank) + '">'
              + '<td>' + richListEsc(numeral(Number(r.rank)).format('0,0')) + '</td>'
              + '<td class="rich-list-address">'
              + (isNull(r.address)
                  ? '<span class="text-muted">-</span>'
                  : formatLink('/' + XC.coin + '/address/' + r.address, richListEsc(r.address)))
              + '</td>'
              + '<td class="text-end rich-list-amount">'
              + richListEsc(numeral(Number(r.amount)).format('0,0[.][00000000]')) + '</td>'
              + '<td class="text-end rich-list-share">' + richListPercent(r.percent) + '</td>'
              + '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

// The one line that stops a truncated ranking from reading as the whole
// distribution. Rendered whenever the ranking is shorter than the census.
function renderRichListCoverage(d){
    if(!d) return '';
    let ranked = Number(d.ranked_count) || 0;
    let total  = Number(d.holder_count) || 0;
    if(!ranked) return '';
    if(ranked >= total)
        return '<div class="small text-muted rich-list-coverage">Showing all '
             + richListEsc(numeral(total).format('0,0')) + ' holders.</div>';
    return '<div class="small text-muted rich-list-coverage">Showing the top '
         + richListEsc(numeral(ranked).format('0,0')) + ' of '
         + richListEsc(numeral(total).format('0,0'))
         + ' holders. This is a ranking of the largest balances, not the full distribution.</div>';
}
