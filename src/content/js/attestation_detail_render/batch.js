/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

function attBatchMinute(value){
    if(isNull(value)) return '<span class="text-muted">-</span>';
    let seconds = Number(value);
    if(!Number.isFinite(seconds)) return '<span class="text-muted">-</span>';
    let stamp;
    try {
        stamp = new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    } catch(error) {
        return '<span class="text-muted">-</span>';
    }
    return '<span class="attestation-batch-time">' + attEsc(stamp) + '</span>';
}

function attRequestLink(requestId, coin){
    if(isNull(requestId)) return '<span class="text-muted">-</span>';
    let lifecycleCoin = isNull(coin) ? networkCoin('BTC') : networkCoin(coin);
    return formatLink('/' + lifecycleCoin + '/attestation/' + encodeURIComponent(String(requestId)), requestId);
}

function attRequestActionLink(actionIndex, coin){
    if(isNull(actionIndex)) return '<span class="text-muted">-</span>';
    let lifecycleCoin = isNull(coin) ? networkCoin('BTC') : networkCoin(coin);
    return formatLink('/' + lifecycleCoin + '/action/' + actionIndex, numeral(actionIndex).format('0,0'));
}

function attBatchOverview(b){
    let count = isNull(b.batch_row_count) ? '-' : String(b.batch_row_count);
    let html = '<table class="table table-sm table-borderless mb-2"><tbody>';
    html += attFieldRow('Batch key', attHex(isNull(b.batch_key) ? b.request_id : b.batch_key));
    html += attFieldRow('Window', attBatchMinute(b.batch_window_start) + ' to ' + attBatchMinute(b.batch_window_end));
    html += attFieldRow('Response count', '<span class="attestation-batch-response-count">' + attEsc(count) + '</span>');
    html += attFieldRow('Publisher', isNull(b.source) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/address/' + encodeURIComponent(String(b.source)), b.source));
    html += attFieldRow('Batch action', attActionLink(b.action_index));
    return html + '</tbody></table>';
}

function attBatchContinuations(rows){
    let html = '<div class="fw-bold small mt-2">Continuations</div>';
    if(!rows.length)
        return html + '<div class="text-muted small attestation-batch-continuations-empty">No continuation chunks.</div>';
    html += '<ul class="list-unstyled small mb-2 attestation-batch-continuations">';
    rows.forEach(function(row){
        let chunk = isNull(row.batch_chunk_index) ? '-' : String(Number(row.batch_chunk_index) + 1);
        let total = isNull(row.batch_total_chunks) ? '-' : String(row.batch_total_chunks);
        html += '<li class="attestation-batch-continuation">'
            + attActionLink(row.action_index) + ' chunk ' + attEsc(chunk) + ' of ' + attEsc(total) + '</li>';
    });
    return html + '</ul>';
}

function attBatchResponses(rows){
    let html = '<div class="fw-bold small mt-2">Carried responses</div>';
    if(!rows.length)
        return html + '<div class="text-muted small attestation-batch-responses-empty">No responses were carried.</div>';
    html += '<ul class="list-unstyled small mb-2 attestation-batch-responses">';
    rows.forEach(function(row){
        html += '<li class="attestation-batch-response">' + attRequestLink(row.request_id, row.coin)
            + (isNull(row.request_action_index) ? '' : ' request action ' + attRequestActionLink(row.request_action_index, row.coin))
            + (isNull(row.response_status) ? '' : ' <span class="badge text-bg-secondary">' + attEsc(row.response_status) + '</span>')
            + '</li>';
    });
    return html + '</ul>';
}

function attBatchDuplicates(rows){
    let html = '<div class="fw-bold small mt-2">Duplicate heads</div>';
    if(!rows.length)
        return html + '<div class="text-muted small attestation-batch-duplicates-empty">No duplicate heads for this window.</div>';
    html += '<ul class="list-unstyled small mb-0 attestation-batch-duplicates">';
    rows.forEach(function(row){
        html += '<li class="attestation-batch-duplicate">' + attActionLink(row.action_index)
            + (isNull(row.source) ? '' : ' published by ' + formatLink('/' + XC.coin + '/address/' + encodeURIComponent(String(row.source)), row.source))
            + (isNull(row.block_index) ? '' : ' in block ' + attBlockLink(row.block_index))
            + (isNull(row.tx_hash) ? '' : ' transaction ' + formatLink('/' + XC.coin + '/transaction/' + encodeURIComponent(String(row.tx_hash)), row.tx_hash))
            + '</li>';
    });
    return html + '</ul>';
}
