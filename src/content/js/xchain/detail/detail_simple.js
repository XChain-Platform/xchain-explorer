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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Display AIRDROP action information
function showAirdropDetails(data){
    // A multi-airdrop pays one leg per `airdrops` row; render every leg. The header
    // query still carries one leg's scalars, so fall back to those for a payload
    // without `airdrops` rather than drawing an empty table.
    let legs = (data.airdrops && data.airdrops.length) ? data.airdrops
             : [{ tick: data.tick, list_action_index: data.list_action_index,
                  amount: data.amount, memo: data.memo, status: data.status }];
    showActionDatatable('airdrop', legs);
}

// Display BATCH action information
function showBatchDetails(data){
    showActionDatatable('batch',data.actions);
}

// Display BROADCAST action information
//
// This is the aliasing reader for /api/action/{idx} (mirrored in
// action_detail.js's actionDetail_renderBasicActions): it reads
// data.broadcast_fee, never data.fee. /api/broadcasts/{addr}/address is a
// different endpoint that returns fee as a plain positional column, read
// by rows_actions_a.js's xcDatatableRenderBroadcastRow - an unrelated
// renderer for an unrelated response shape, not a second copy of this key.
function showBroadcastDetails(data){
    // Read the broadcast's own fee fraction from its aliased column (broadcast_fee),
    // NOT data.fee: the reserved data.fee slot is overwritten with the protocol-fee
    // record when one exists, so reading it here rendered '[object Object]'.
    let percent = (isNumeric(data.broadcast_fee)) ? (' <span class="badge text-bg-info text-white">' + bcmul(data.broadcast_fee, 100, 2) + '%</span>') : '';
    let format = Number(data.action_format);
    let fee = nullToBlank(data.broadcast_fee);
    $('#info-broadcast .broadcast-message').text(nullToBlank(data.message));
    $('#info-broadcast .broadcast-value').text(formatAmount(data.value));
    $('#info-broadcast .broadcast-fee').html(fee === '' ? '' : fee + percent);
    $('#info-broadcast .broadcast-memo').text(nullToBlank(data.memo));
    $('#info-broadcast .broadcast-message').closest('tr').toggleClass('d-none', ![0,1,2].includes(format));
    $('#info-broadcast .broadcast-value').closest('tr').toggleClass('d-none', ![0,1,3].includes(format));
    $('#info-broadcast .broadcast-fee').closest('tr').toggleClass('d-none', ![1,2].includes(format));
    $('#info-broadcast .broadcast-memo').closest('tr').toggleClass('d-none', ![1,2,3].includes(format));
    // BROADCAST v3 references an earlier broadcast (its only meaningful payload);
    // link it and reveal the row, hidden for v0-v2 which have no reference.
    if(format === 3){
        $('#info-broadcast .broadcast-reference').html(isNull(data.broadcast_action_index) ? '' :
            formatLink('/' + XC.coin + '/action/' + data.broadcast_action_index, data.broadcast_action_index));
        $('#info-broadcast .broadcast-reference-row').removeClass('d-none');
    } else {
        $('#info-broadcast .broadcast-reference-row').addClass('d-none');
    }
}

// Display CALLBACK action information
function showCallbackDetails(data){
    $('#info-callback .callback-tick').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-callback .callback-callback-tick').html(formatLink(tokenUrl(XC.coin, data.callback_tick), data.callback_tick, data.callback_tick));
    $('#info-callback .callback-amount').html(formatAmount(data.callback_amount));
    $('#info-callback .callback-memo').text(nullToBlank(data.memo));
}

// Display DIVIDEND action information
function showDividendDetails(data){
    $('#info-dividend .dividend-tick').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-dividend .dividend-dividend-tick').html(formatLink(tokenUrl(XC.coin, data.dividend_tick), data.dividend_tick, data.dividend_tick));
    $('#info-dividend .dividend-amount').html(formatAmount(data.amount));
    $('#info-dividend .dividend-memo').text(nullToBlank(data.memo));
}

// Display DESTROY action information
function showDestroyDetails(data){
    // A multi-destroy burns one leg per `destroys` row; render every leg.
    // Fall back to the header fields (one leg) for a payload without `destroys`.
    let legs = (data.destroys && data.destroys.length) ? data.destroys
             : [{ tick: data.tick, amount: data.amount, memo: data.memo, status: data.status }];
    showActionDatatable('destroy', legs);
}

// Display DISPENSER action information
function showDispenserDetails(data){
    let isOwnershipDispenser = (Number(data.give_ownership || 0) == 1);
    $('#info-dispenser .dispenser-give-coin').text(data.give_coin);
    $('#info-dispenser .dispenser-give-tick').html(
        formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick)
        + (isOwnershipDispenser ? ' ' + ownershipBadge() : '')
    );
    $('#info-dispenser .dispenser-give-amount').html(isOwnershipDispenser ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-dispenser .dispenser-give-escrow').html(isOwnershipDispenser ? ownershipBadge() : formatAmount(data.give_escrow));
    $('#info-dispenser .dispenser-get-coin').text(data.get_coin);
    $('#info-dispenser .dispenser-get-tick').html(formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick));
    $('#info-dispenser .dispenser-get-amount').html(formatAmount(data.get_amount));
    $('#info-dispenser .dispenser-get-address').html(formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.get_address, data.get_address));
    // Fiat/oracle-priced dispensers: fiat_amount is the operative price (Get Amount is not),
    // ignored when oracle_address is set. Only show these rows when the dispenser is
    // fiat/oracle-priced so plain crypto-priced dispensers are unchanged.
    let isFiatDispenser = (!isNull(data.fiat_code) || !isNull(data.fiat_amount) || !isNull(data.oracle_address));
    $('#info-dispenser .dispenser-fiat-row').toggleClass('d-none', !isFiatDispenser);
    if(isFiatDispenser){
        $('#info-dispenser .dispenser-fiat-code').text(isNull(data.fiat_code) ? '-' : data.fiat_code);
        $('#info-dispenser .dispenser-fiat-amount').text(isNull(data.fiat_amount) ? '-' : data.fiat_amount);
        $('#info-dispenser .dispenser-oracle-address').html(isNull(data.oracle_address) ? '-' : formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.oracle_address, data.oracle_address));
    }
    if(data.expiration)
        $('#info-dispenser .dispenser-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser .dispenser-allow-list').html(formatListReference(XC.coin, data.allow_list));
    $('#info-dispenser .dispenser-block-list').html(formatListReference(XC.coin, data.block_list));
    $('#info-dispenser .dispenser-memo').text(nullToBlank(data.memo));
    // Dispenser Status Details
    // getActionData deletes state.get_remaining for DISPENSER (only give_remaining is
    // meaningful), so the data layer never carries the field; do not read it here.
    $('#info-dispenser .dispenser-state-give-remaining').html(formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-dispenser .dispenser-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser .dispenser-state-allow-list').html(formatListReference(XC.coin, data.state.allow_list));
    $('#info-dispenser .dispenser-state-block-list').html(formatListReference(XC.coin, data.state.block_list));
    $('#info-dispenser .dispenser-state').text(data.state.status);
}

// Display DISPENSER_CANCEL action information
function showDispenserCancelDetails(data){
    $('#info-dispenser-cancel .dispenser-cancel-action-index').html(formatParentActionLink(XC.coin, data.dispenser_action_index));
    $('#info-dispenser-cancel .dispenser-cancel-memo').text(nullToBlank(data.memo));
}

// Display DISPENSER_CLOSE action information
function showDispenserCloseDetails(data){
    $('#info-dispenser-close .dispenser-close-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
}

// Display DISPENSER_EDIT action information
function showDispenserEditDetails(data){
    $('#info-dispenser-edit .dispenser-edit-action-index').html(formatParentActionLink(XC.coin, data.dispenser_action_index));
    $('#info-dispenser-edit .dispenser-edit-give-escrow').html(formatAmount(data.give_escrow));
    if(!isNull(data.expiration))
        $('#info-dispenser-edit .dispenser-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser-edit .dispenser-edit-allow-list').html(formatListReference(XC.coin, data.allow_list, true));
    $('#info-dispenser-edit .dispenser-edit-block-list').html(formatListReference(XC.coin, data.block_list, true));
    $('#info-dispenser-edit .dispenser-edit-memo').text(nullToBlank(data.memo));
}

// Display DISPENSER_EXPIRE action information
function showDispenserExpireDetails(data){
    $('#info-dispenser-expire .dispenser-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
}

// Display DISPENSE action information. get_amount is what THIS fill was
// charged: when one payment fills several dispensers in the same transaction,
// it is that fill's share, not the whole payment restated per fill (mainnet
// not yet armed; testnet/regtest already this way). The "Get Amount" label
// stays as-is since it is still an accurate name for "coin received for this
// event" either way - see protocol/actions/dispenser.md.
function showDispenseDetails(data){
    let isOwnershipGive = (Number(data.give_ownership || 0) == 1);
    $('#info-dispense .dispense-give-coin').text(data.give_coin);
    $('#info-dispense .dispense-give-tick').html(formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick)
        + (isOwnershipGive ? ' ' + ownershipBadge() : ''));
    $('#info-dispense .dispense-give-amount').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-dispense .dispense-get-coin').text(data.get_coin);
    $('#info-dispense .dispense-get-tick').html(formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick));
    $('#info-dispense .dispense-get-amount').html(formatAmount(data.get_amount));
    $('#info-dispense .dispense-source').html(formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.source, data.source));
    $('#info-dispense .dispense-destination').html(formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.destination, data.destination));
}

function renderFilePartDetails(data){
    let part = data.file_part, manifest = part.manifest_action_index;
    $('#info-file .file-meta-row, #info-file .file-gated-row, #info-file .file-threshold-row, #info-file .file-multipart-row').addClass('d-none');
    $('#info-file .file-part-row').removeClass('d-none');
    $('#info-file .file-part-hash').text(part.file_hash);
    $('#info-file .file-part-index').text(formatAmount(part.part_index));
    $('#info-file .file-part-manifest').html(isNull(manifest)
        ? 'No valid manifest indexed yet'
        : formatLink('/' + XC.coin + '/action/' + manifest, String(manifest)));
    $('#info-file .file-raw').empty();
    $('#info-file .file-viewer').text('This is one part of a multi-part file. The assembled file is available from its manifest.');
}

function renderMultipartProgress(data){
    let multipart = data.multipart;
    let labels = {
        pending: 'Pending',
        complete: 'Complete',
        mismatch: 'Mismatch: assembled file does not match the manifest'
    };
    $('#info-file .file-multipart-row').removeClass('d-none');
    $('#info-file .file-multipart-hash').text(multipart.file_hash);
    $('#info-file .file-multipart-status').text(labels[multipart.status] || multipart.status);
    $('#info-file .file-multipart-parts').text(formatAmount(multipart.parts_received) + ' of ' + formatAmount(multipart.total_parts));
    $('#info-file .file-multipart-bytes').text(formatAmount(multipart.total_bytes) + ' bytes');
    return multipart.status === 'complete';
}

function renderFileGate(data, rawReady){
    if(isNull(data.gate_ticker)){
        $('#info-file .file-gated-row, #info-file .file-threshold-row').addClass('d-none');
        $('#info-file .file-raw').empty();
        return;
    }
    let method = (data.encryption_method == 1) ? 'AES-256-GCM' : data.encryption_method;
    $('#info-file .file-gate-ticker').html(formatLink(tokenUrl(XC.coin, data.gate_ticker), data.gate_ticker, data.gate_ticker));
    $('#info-file .file-encryption').text(method);
    $('#info-file .file-key-hash').html(formatHash(data.key_hash, 24));
    $('#info-file .file-raw').html(rawReady
        ? formatLink('/' + XC.coin + '/api/file/' + data.action_index + '/raw', 'download ciphertext')
        : 'Ciphertext is unavailable until assembly completes');
    $('#info-file .file-gated-row').removeClass('d-none');
    let threshold = !isNull(data.gate_min_amount) && data.gate_min_amount !== '';
    $('#info-file .file-threshold-row').toggleClass('d-none', !threshold);
    if(threshold)
        $('#info-file .file-gate-min-amount').html(formatAmount(data.gate_min_amount) + ' ' +
            formatLink(tokenUrl(XC.coin, data.gate_ticker), data.gate_ticker, data.gate_ticker));
}

function renderFileViewer(data, rawReady){
    let viewer = $('#info-file .file-viewer');
    if(!rawReady){
        let message = data.multipart.status === 'mismatch'
            ? 'The assembled file does not match the manifest.'
            : 'The file is still being assembled.';
        viewer.text(message);
        return;
    }
    let rawUrl = '/' + XC.coin + '/api/file/' + data.action_index + '/raw';
    let type = String(data.type || '').toLowerCase(), html = '';
    if(!isNull(data.gate_ticker)){
        html = '<i class="fa-solid fa-lock pe-1"></i> Token-gated content &mdash; holders decrypt client-side with their unlock key';
        if(!isNull(data.gate_min_amount) && data.gate_min_amount !== '')
            html += ', delivered to holders of at least ' + escapeHtml(String(data.gate_min_amount)) +
                    ' ' + escapeHtml(String(data.gate_ticker));
    } else if(type.substring(0,6)=='image/' && type!='image/svg+xml'){
        html = '<img src="' + rawUrl + '" class="img-fluid" style="max-width:400px" alt="">';
    } else if(type.substring(0,6)=='video/'){
        html = '<video controls playsinline class="img-fluid" style="max-width:400px"><source src="' + rawUrl + '" type="' + escapeHtml(type) + '"></video>';
    } else if(type.substring(0,6)=='audio/'){
        html = '<audio src="' + rawUrl + '" controls preload="none"></audio>';
    } else {
        html = formatLink(rawUrl, 'download file');
    }
    viewer.html(html);
}

// Display FILE action information
function showFileDetails(data){
    if(data.file_part){
        renderFilePartDetails(data);
        return;
    }
    $('#info-file .file-part-row').addClass('d-none');
    $('#info-file .file-meta-row').removeClass('d-none');
    $('#info-file .file-name').text(data.name);
    $('#info-file .file-title').text(data.title);
    $('#info-file .file-type').text(data.type);
    $('#info-file .file-memo').text(nullToBlank(data.memo));
    let rawReady = data.multipart ? renderMultipartProgress(data) : true;
    if(!data.multipart) $('#info-file .file-multipart-row').addClass('d-none');
    renderFileGate(data, rawReady);
    renderFileViewer(data, rawReady);
}
