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
 * action_markers.js
 *
 * Structure markers for the compact action summaries: the count badge on a
 * multi-leg SEND or DESTROY and on a BATCH parent, the in-batch mark on a
 * member, and the disclosure row that opens the legs or members under a
 * list row. Split from action_detail.js, which renders the one-line summary
 * the marker is appended to.
 */

// Mark the rows a reader cannot judge at surface level. The summary shows one
// leg of a multi-send and nothing of a BATCH's members, so without a mark a
// 4-recipient send and a single send look the same in every list. The counts
// come from the summary projection (leg_count, member_count); a member row
// carries its parent under parent_batch_action_index. The count is a toggle
// that opens the legs or members under the row (see actionDetail_toggleDisclosure).
function actionDetail_renderStructureMarkers(html, action, info, coin){
    if(!info || typeof info !== 'object') return html;
    let legs    = Number(info.leg_count);
    let members = Number(info.member_count);
    let parent  = info.parent_batch_action_index;
    if(legs > 1){
        let noun = (action=='SEND') ? 'recipients' : 'legs';
        html += ' ' + actionDetail_disclosureToggle(info.action_index, legs + ' ' + noun);
    }
    if(members > 0)
        html += ' ' + actionDetail_disclosureToggle(info.action_index, members + ' actions');
    if(!isNull(parent))
        html += ' <span class="xc-in-batch text-muted small">in batch ' + formatLink('/' + coin + '/action/' + parent, '#' + parent) + '</span>';
    return html;
}

function actionDetail_disclosureToggle(action_index, label){
    return '<a href="#" class="badge text-bg-secondary xc-legs-toggle" data-action-index="' + escapeHtml(action_index) + '" title="Show each one">'
        + escapeHtml(label) + ' <i class="fa fa-caret-down"></i></a>';
}

// Open or close the legs/members under a list row. The list feed carries only
// the count, so the first open fetches the action itself (one request, cached
// by the browser) and renders its sends[], destroys[] or actions[]. Inside a
// DataTable the content is a child row, which paging clears; elsewhere it is a
// plain sibling row.
function actionDetail_toggleDisclosure(el){
    let idx   = el.attr('data-action-index');
    let tr    = el.closest('tr');
    let table = tr.closest('table');
    let dt    = ($.fn.dataTable && $.fn.dataTable.isDataTable(table)) ? table.DataTable() : null;
    let row   = (dt) ? dt.row(tr) : null;
    if(row && row.child.isShown()){
        row.child.hide();
        tr.removeClass('xc-legs-open');
        return;
    }
    if(!row && tr.next().hasClass('xc-legs-child')){
        tr.next().remove();
        tr.removeClass('xc-legs-open');
        return;
    }
    let show = function(inner){
        let box = '<div class="xc-legs-child">' + inner + '</div>';
        if(row){
            row.child(box).show();
        } else {
            tr.next('.xc-legs-child').remove();
            tr.after('<tr class="xc-legs-child"><td colspan="' + tr.children('td').length + '">' + box + '</td></tr>');
        }
        tr.addClass('xc-legs-open');
    };
    show('<span class="text-muted">Loading...</span>');
    loadApiData(XC.coin, 'action', idx, null, function(o){
        show(actionDetail_renderDisclosure(o));
    }, function(){
        show('<span class="text-danger">Could not load action ' + escapeHtml(idx) + '</span>');
    });
}

// The table under an opened row: one line per leg or member, values escaped
// because memos are user text.
function actionDetail_renderDisclosure(o){
    let coin = XC.coin;
    let head = '';
    let rows = '';
    if(o && o.action=='SEND' && Array.isArray(o.sends)){
        head = '<th>#</th><th>Token</th><th>Amount</th><th>Destination</th><th>Memo</th><th>Status</th>';
        o.sends.forEach(function(s, i){
            rows += '<tr class="' + actionDetail_statusClass(s.status) + '">'
                + '<td>' + (i + 1) + '</td>'
                + '<td>' + formatLink(tokenUrl(coin, s.tick), s.tick, s.tick) + '</td>'
                + '<td>' + formatAmount(s.amount) + '</td>'
                + '<td>' + formatLink('/' + coin + '/address/' + s.destination, s.destination) + '</td>'
                + '<td>' + escapeHtml(s.memo) + '</td>'
                + '<td>' + escapeHtml(s.status) + '</td>'
                + '</tr>';
        });
    } else if(o && o.action=='DESTROY' && Array.isArray(o.destroys)){
        head = '<th>#</th><th>Token</th><th>Amount</th><th>Memo</th><th>Status</th>';
        o.destroys.forEach(function(d, i){
            let tick = (isNull(d.tick)) ? o.tick : d.tick;
            rows += '<tr class="' + actionDetail_statusClass(d.status) + '">'
                + '<td>' + (i + 1) + '</td>'
                + '<td>' + formatLink(tokenUrl(coin, tick), tick, tick) + '</td>'
                + '<td>' + formatAmount(d.amount) + '</td>'
                + '<td>' + escapeHtml(d.memo) + '</td>'
                + '<td>' + escapeHtml(d.status) + '</td>'
                + '</tr>';
        });
    } else if(o && o.action=='BATCH' && Array.isArray(o.actions)){
        head = '<th>#</th><th>Action</th><th>Details</th><th>Status</th><th></th>';
        o.actions.forEach(function(m, i){
            if(!m || typeof m !== 'object') return;
            // Members carry their summary under `summary` (never `details`, which a
            // BET feed member uses for its raw payload), the same rule the batch page keeps.
            let details = (m.summary && typeof m.summary === 'object') ? m.summary : m;
            rows += '<tr class="' + actionDetail_statusClass(m.status) + '">'
                + '<td>' + (i + 1) + '</td>'
                + '<td>' + escapeHtml(m.action) + '</td>'
                + '<td>' + getActionDetails(m.action, details) + '</td>'
                + '<td>' + escapeHtml(m.status) + '</td>'
                + '<td>' + formatLink('/' + coin + '/action/' + m.action_index, 'view', null, true) + '</td>'
                + '</tr>';
        });
    } else {
        return '<span class="text-muted">Nothing to expand</span>';
    }
    return '<table class="table table-sm table-borderless mb-0 xc-legs-table"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function actionDetail_statusClass(status){
    if(isNull(status)) return '';
    return (String(status)=='valid' || String(status)=='1') ? 'bg-green' : 'bg-red';
}

// One delegated listener covers every list on the page, including rows a
// DataTable draws later. stopPropagation keeps a row-level click handler from
// treating the toggle as a row open.
if(typeof $ !== 'undefined'){
    $(document).on('click', '.xc-legs-toggle', function(e){
        e.preventDefault();
        e.stopPropagation();
        actionDetail_toggleDisclosure($(this));
    });
}
