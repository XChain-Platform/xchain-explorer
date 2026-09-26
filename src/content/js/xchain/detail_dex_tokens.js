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

// Display ISSUE action information
function showIssueDetails(data){
    $('#info-issue .issue-transfer').html(formatLink('/' + XC.coin + '/address/' + data.transfer, data.transfer));
    $('#info-issue .issue-ticker').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-issue .issue-decimals').text(data.decimals);
    $('#info-issue .issue-max-supply').text(formatAmount(data.max_supply));
    $('#info-issue .issue-max-mint').text(formatAmount(data.max_mint));
    $('#info-issue .issue-mint-supply').text(formatAmount(data.mint_supply));
    $('#info-issue .issue-transfer-supply').html(formatLink('/' + XC.coin + '/address/' + data.transfer_supply, data.transfer_supply));
    $('#info-issue .issue-callback-block').text(data.callback_block);
    $('#info-issue .issue-callback-tick').text(data.callback_tick);
    $('#info-issue .issue-callback-amount').text(formatAmount(data.callback_amount));
    $('#info-issue .issue-description').text(data.description);
    $('#info-issue .issue-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-issue .issue-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-issue .issue-memo').text(data.memo);
    $('#info-issue .issue-mint-address-max').text(formatAmount(data.mint_address_max));
    $('#info-issue .issue-mint-start-block').text(formatAmount(data.mint_start_block));
    $('#info-issue .issue-mint-stop-block').text(formatAmount(data.mint_stop_block));
    $('#info-issue .issue-lock-max-supply').text(data.lock_max_supply);
    $('#info-issue .issue-lock-max-mint').text(data.lock_max_mint);
    $('#info-issue .issue-lock-mint').text(data.lock_mint);
    $('#info-issue .issue-lock-mint-supply').text(data.lock_mint_supply);
    $('#info-issue .issue-lock-description').text(data.lock_description);
    $('#info-issue .issue-lock-sleep').text(data.lock_sleep);
    $('#info-issue .issue-lock-callback').text(data.lock_callback);
    // ISSUE v6 binds (or unbinds) a guard contract as the token's controller for one
    // action class. Those four wire fields are null on every other ISSUE format, so
    // the card is shown only for format 6 rather than adding four blank rows to the
    // v0-v5 shape; without it a v6 action page had nothing binding-specific at all.
    let isController = (Number(data.action_format) === 6);
    $('#info-issue .issue-controller-card').toggleClass('d-none', !isController);
    if(isController){
        $('#info-issue .issue-controller').html(isNull(data.controller) ? '-' :
            formatLink('/' + XC.coin + '/contract/' + data.controller, data.controller));
        $('#info-issue .issue-action-class').text(isNull(data.action_class) ? '-' : data.action_class);
        $('#info-issue .issue-cooldown-blocks').text(isNull(data.cooldown_blocks) ? '-' :
            numeral(data.cooldown_blocks).format('0,0') + ' blocks');
        // Bind and unbind are the same wire format and differ only in this flag, so it
        // is rendered as the row's headline rather than a bare 0/1.
        $('#info-issue .issue-unbind').html(Number(data.unbind) === 1
            ? '<span class="badge text-bg-warning text-dark">Unbind</span>'
            : '<span class="badge text-bg-info text-white">Bind</span>');
    }
}

// Display LINK action information
function showLinkDetails(data){
    $('#info-link .link-coin1').text(data.coin1);
    $('#info-link .link-coin1-action-index').html(formatLink('/' + networkCoin(data.coin1) + '/action/' + data.coin1_action_index, formatAmount(data.coin1_action_index)));
    $('#info-link .link-coin2').text(data.coin2);
    $('#info-link .link-coin2-action-index').html(formatLink('/' + networkCoin(data.coin2) + '/action/' + data.coin2_action_index, formatAmount(data.coin2_action_index)));
    $('#info-link .link-memo').text(data.memo);
}

// Display LIST action information
function showListDetails(data){
    if(!data.edit)
        data.edit = 0;
    let list_type = XC.list_types[data.type];
    let type = (data.type) ? (data.type + ' - ' + list_type) : '';
    let edit = (isNumeric(data.edit)) ? (data.edit + ' - ' + XC.list_edit_types[data.edit]) : '';
    $('#info-list .list-type').text(type);
    $('#info-list .list-edit-type').text(edit);
    $('#info-list .list-action-index').html(formatLink('/' + XC.coin + '/action/' + data.list_action_index, formatAmount(data.list_action_index)));
    $('#info-list .list-memo').text((data.memo == null) ? '' : data.memo);
    // Add header columns
    $('#datatable-list-items thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th></tr>');
    $('#datatable-list-edits thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th><th>Status</th></tr>');
    showActionDatatable('list-edits', data.edits, list_type, false);
    // `list` is what THIS action wrote; edits land under their own action
    // index, so on a create with later edits it is a create-time snapshot. Show
    // current membership (state.current_list) whenever the chain resolves the edit
    // chain, and name the action that set it, because consumers pin a list by its
    // CREATE index and this is the page a market's "who may bet" link lands on.
    let state   = data.state || {};
    let current = (state.edit_resolution_active && Array.isArray(state.current_list)) ? state.current_list : null;
    let head    = state.membership_action_index;
    let edited  = current && isNumeric(head) && Number(head) !== Number(data.action_index);
    $('#info-list .list-membership-row').toggleClass('d-none', !edited);
    if(edited)
        $('#info-list .list-membership-action-index').html(formatLink('/' + XC.coin + '/action/' + head, formatAmount(head)));
    $('#list-items-tab').html('<i class="fa fa-lg fa-list"></i> ' + (current ? 'Current List' : 'Full List'));
    showActionDatatable('list-items', current || data.list, list_type, false);

}

// Display MESSAGE action information
function showMessageDetails(data){
    let encryption_method = (XC.encryption_methods[data.encryption_method]) ? (data.encryption_method + ' - ' + XC.encryption_methods[data.encryption_method]) : '';
    $('#info-message .message-method').text(encryption_method);
    $('#info-message .message-key').text(data.encryption_key);
    $('#info-message .message-plaintext').text(data.plaintext_message);
    $('#info-message .message-encrypted').text(data.encrypted_message);
    // Link the destination on ITS own chain (messages.coin), not the broadcast chain.
    $('#info-message .message-destination').html(formatLink('/' + networkCoin(data.coin || XC.coin) + '/address/' + data.destination, data.destination));
}

// Display MINT action information
function showMintDetails(data){
    $('#info-mint .mint-tick').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-mint .mint-amount').html(formatAmount(data.amount));
    $('#info-mint .mint-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    $('#info-mint .mint-memo').text(data.memo);
}

// Display ORDER action information
// Map an offer lifecycle status (ORDER, SWAP, DISPENSER) to a badge colour.
// Separate from the bet renderer's lookalike, whose vocabulary is a market's.
// cancelling/expiring are still in flight, so they warn rather than fail.
function offerStatusClass(status){
    if(status=='complete')                       return 'success';
    if(status=='cancelled' || status=='expired') return 'danger';
    if(status=='cancelling' || status=='expiring') return 'warning text-dark';
    return 'primary';
}

function showOrderDetails(data){
    let isOwnershipGive = (Number(data.give_ownership || 0) == 1);
    let isOwnershipGet  = (Number(data.get_ownership  || 0) == 1);
    $('#info-order .order-give-coin').text(data.give_coin);
    $('#info-order .order-give-tick').html(
        formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick)
        + (isOwnershipGive ? ' ' + ownershipBadge() : '')
    );
    $('#info-order .order-give-amount').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-order .order-get-coin').text(data.get_coin);
    $('#info-order .order-get-tick').html(
        formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick)
        + (isOwnershipGet ? ' ' + ownershipBadge() : '')
    );
    $('#info-order .order-get-amount').html(isOwnershipGet ? ownershipBadge() : formatAmount(data.get_amount));
    $('#info-order .order-get-address').html(formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.get_address, data.get_address));
    if(data.expiration)
        $('#info-order .order-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order .order-allow-list').html(formatListReference(XC.coin, data.allow_list));
    $('#info-order .order-block-list').html(formatListReference(XC.coin, data.block_list));
    $('#info-order .order-memo').text(data.memo);
    // Order Status Details
    // Render the ORDER's lifecycle status; the Action Status row above is the
    // action's parse validity and reads valid for a filled order and an open one
    // alike. Dashed when absent so a missing status stays visible.
    $('#info-order .order-state-status').html(
        isNull(data.state.status)
            ? '-'
            : '<span class="badge text-bg-' + offerStatusClass(data.state.status) + '">' + escapeHtml(data.state.status) + '</span>'
    );
    $('#info-order .order-state-get-remaining').html(isOwnershipGet  ? ownershipBadge() : formatAmount(data.state.get_remaining));
    $('#info-order .order-state-give-remaining').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-order .order-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order .order-state-allow-list').html(formatListReference(XC.coin, data.state.allow_list));
    $('#info-order .order-state-block-list').html(formatListReference(XC.coin, data.state.block_list));
    $('#info-order .order-state').text(data.state.status);
}

// Display ORDER_CANCEL action information
function showOrderCancelDetails(data){
    $('#info-order-cancel .order-cancel-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
    $('#info-order-cancel .order-cancel-memo').text(data.memo);
}

// Display ORDER_EDIT action information
function showOrderEditDetails(data){
    $('#info-order-edit .order-edit-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
    if(!isNull(data.expiration))
        $('#info-order-edit .order-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order-edit .order-edit-allow-list').html(formatListReference(XC.coin, data.allow_list, true));
    $('#info-order-edit .order-edit-block-list').html(formatListReference(XC.coin, data.block_list, true));
    $('#info-order-edit .order-edit-memo').text(data.memo);
}

// Display ORDER_EXPIRE action information
function showOrderExpireDetails(data){
    $('#info-order-expire .order-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
}

// Display ORDER_MATCH action information
function showOrderMatchDetails(data){
    $('#info-order-match .order-match-give-action-index').html(formatLink('/' + networkCoin(data.give_coin) + '/action/' + data.give_action_index, formatAmount(data.give_action_index)));
    $('#info-order-match .order-match-get-action-index').html(formatLink('/' + networkCoin(data.get_coin) + '/action/'  + data.get_action_index,  formatAmount(data.get_action_index)));
    $('#info-order-match .order-match-give-coin').text(data.give_coin);
    $('#info-order-match .order-match-give-tick').html(formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick));
    $('#info-order-match .order-match-give-amount').text(data.give_amount);
    $('#info-order-match .order-match-get-coin').text(data.get_coin);
    $('#info-order-match .order-match-get-tick').html(formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick));
    $('#info-order-match .order-match-get-amount').text(data.get_amount);
    $('#info-order-match .order-match-settlement-type').text(isNull(data.settlement_type) ? '-' : data.settlement_type);
}

// Display SEND action information
function showSendDetails(data){
    showActionDatatable('send',data.sends);
}

// Display SLEEP action information
function showSleepDetails(data){
    let sleep_type = data.type + ' - Sleep ' + XC.sleep_types[data.type];
    $('#info-sleep .sleep-type').text(sleep_type);
    $('#info-sleep .sleep-tick').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-sleep .sleep-resume-block').html(formatLink('/' + XC.coin + '/block/' + data.resume_block, formatAmount(data.resume_block)));
    $('#info-sleep .sleep-memo').text(data.memo);
}

// Display SWAP action information
function showSwapDetails(data){
    let isOwnershipGive = (Number(data.give_ownership || 0) == 1);
    let isOwnershipGet  = (Number(data.get_ownership  || 0) == 1);
    $('#info-swap .swap-give-coin').text(data.give_coin);
    $('#info-swap .swap-give-tick').html(
        formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick)
        + (isOwnershipGive ? ' ' + ownershipBadge() : '')
    );
    $('#info-swap .swap-give-amount').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-swap .swap-get-coin').text(data.get_coin);
    $('#info-swap .swap-get-tick').html(
        formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick)
        + (isOwnershipGet ? ' ' + ownershipBadge() : '')
    );
    $('#info-swap .swap-get-amount').html(isOwnershipGet ? ownershipBadge() : formatAmount(data.get_amount));
    $('#info-swap .swap-get-address').html(formatLink('/' + networkCoin(data.get_coin) + '/address/' + data.get_address, data.get_address));
    if(!isNull(data.expiration))
        $('#info-swap .swap-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap .swap-allow-list').html(formatListReference(XC.coin, data.allow_list));
    $('#info-swap .swap-block-list').html(formatListReference(XC.coin, data.block_list));
    $('#info-swap .swap-memo').text(data.memo);
    // Swap Status Details
    $('#info-swap .swap-state-get-remaining').html(isOwnershipGet  ? ownershipBadge() : formatAmount(data.state.get_remaining));
    $('#info-swap .swap-state-give-remaining').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-swap .swap-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap .swap-state-allow-list').html(formatListReference(XC.coin, data.state.allow_list));
    $('#info-swap .swap-state-block-list').html(formatListReference(XC.coin, data.state.block_list));
    $('#info-swap .swap-state').text(data.state.status);
}

// Display SWAP_CANCEL action information
function showSwapCancelDetails(data){
    $('#info-swap-cancel .swap-cancel-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
    $('#info-swap-cancel .swap-cancel-memo').text(data.memo);
}

// Display SWAP_EDIT action information
function showSwapEditDetails(data){
    $('#info-swap-edit .swap-edit-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
    if(!isNull(data.expiration))
        $('#info-swap-edit .swap-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap-edit .swap-edit-allow-list').html(formatListReference(XC.coin, data.allow_list, true));
    $('#info-swap-edit .swap-edit-block-list').html(formatListReference(XC.coin, data.block_list, true));
    $('#info-swap-edit .swap-edit-memo').text(data.memo);
}

// Display SWAP_EXPIRE action information
function showSwapExpireDetails(data){
    $('#info-swap-expire .swap-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
}


// Display SWAP_MATCH action information
function showSwapMatchDetails(data){
    $('#info-swap-match .swap-match-give-action-index').html(formatLink('/' + networkCoin(data.give_coin) + '/action/' + data.give_action_index, formatAmount(data.give_action_index)));
    $('#info-swap-match .swap-match-get-action-index').html(formatLink('/' + networkCoin(data.get_coin) + '/action/'  + data.get_action_index,  formatAmount(data.get_action_index)));
    $('#info-swap-match .swap-match-give-coin').text(data.give_coin);
    $('#info-swap-match .swap-match-give-tick').html(formatCoinLegTicker(XC.coin, data.give_coin, data.give_tick));
    $('#info-swap-match .swap-match-give-amount').text(data.give_amount);
    $('#info-swap-match .swap-match-get-coin').text(data.get_coin);
    $('#info-swap-match .swap-match-get-tick').html(formatCoinLegTicker(XC.coin, data.get_coin, data.get_tick));
    $('#info-swap-match .swap-match-get-amount').text(data.get_amount);
}

// Display SWEEP action information
function showSweepDetails(data){
    $('#info-sweep .sweep-balances').html(data.balances);
    $('#info-sweep .sweep-ownerships').html(data.ownerships);
    $('#info-sweep .sweep-orders').html(data.orders);
    $('#info-sweep .sweep-swaps').html(data.swaps);
    $('#info-sweep .sweep-dispensers').html(data.dispensers);
    $('#info-sweep .sweep-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    $('#info-sweep .sweep-memo').text(data.memo);
}

// Display COINPAY action information (native-coin settlement payment for an
// obligation). coin_amount/vout name the specific output that paid THIS
// obligation: when one transaction pays more than one obligation, they no
// longer default to the transaction's first output (mainnet not yet armed;
// testnet/regtest already this way). Labels stay as-is since "Coin Amount" /
// "Vout" remain accurate names either way - see components/indexer/database.md.
function showCoinpayDetails(data){
    $('#info-coinpay .coinpay-obligation').html(isNull(data.obligation_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.obligation_action_index, numeral(data.obligation_action_index).format('0,0')));
    $('#info-coinpay .coinpay-coin-amount').html(isNull(data.coin_amount) ? '-' : formatAmount(data.coin_amount));
    $('#info-coinpay .coinpay-txid').html(isNull(data.txid) ? '-' : formatHash(data.txid, 32));
    $('#info-coinpay .coinpay-vout').text(isNull(data.vout) ? '-' : data.vout);
    $('#info-coinpay .coinpay-status').text(isNull(data.status) ? '-' : data.status);
}

// Display COINPAY_EXPIRE action information (obligation settlement window lapsed)
function showCoinpayExpireDetails(data){
    $('#info-coinpay-expire .coinpay-expire-obligation').html(isNull(data.obligation_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.obligation_action_index, numeral(data.obligation_action_index).format('0,0')));
    $('#info-coinpay-expire .coinpay-expire-status').text(isNull(data.status) ? '-' : data.status);
}
