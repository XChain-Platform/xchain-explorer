/*********************************************************************
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
 * Custom javascript for xchain explorer
 */
var xcDatatableRowHandlers = {};
function xcDatatableRenderAddressRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Address

    // A null here means the action does not CARRY this field at all, not
    // that the field is set to the falsy option. An ADDRESS v1 (controller
    // bind/unbind) carries NONE of the v0 preferences, and the old
    // ternaries collapsed "absent" into "Donate"/"False", so every v1 row
    // displayed preferences it had never set. That is worse than rendering
    // nothing: it is plausible and wrong, so it cannot be spotted by eye.
    // Measured on RDOGE: actions 1157 and 1159 return fee_preference null
    // and require_memo null, and both rows read "Donate"/"False".
    $('td', row).eq(4).text(isNull(data[4]) ? '-' : ((data[4]==1) ? 'Destroy' : 'Donate'));
    $('td', row).eq(5).text(isNull(data[5]) ? '-' : ((data[5]==1) ? 'True'    : 'False'));
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.address = xcDatatableRenderAddressRow;
function xcDatatableRenderAirdropRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Airdrop

    let token  = data[4];
    let amount = data[5];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.airdrop = xcDatatableRenderAirdropRow;
function xcDatatableRenderBalanceRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Balance

    let token   = data[1];
    let amount  = data[2];
    let percent = data[3];
    let value   = data[4];
    $('td', row).eq(1).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(2).html(formatAmount(amount));
    $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
    let html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
    html += ' <span class="badge text-bg-info text-white">$' + numeral(bcmul(value, XC.coin_price, 8)).format('0,0.00') + '</span>';
    $('td', row).eq(4).html(html);
    $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), 'view', null, true));

}
xcDatatableRowHandlers.balance = xcDatatableRenderBalanceRow;
function xcDatatableRenderBatchRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Batch

    $('td', row).eq(4).html(action_link);

}
xcDatatableRowHandlers.batch = xcDatatableRenderBatchRow;
function xcDatatableRenderBlockRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Blocks

    let renderedBlockIndex = data[0];
    let renderedTimestamp  = data[1];
    let actions = String(data[2]).split('|');
    let html = '';
    $('td', row).eq(0).html(formatLink('/' + coin + '/block/' + renderedBlockIndex, numeral(renderedBlockIndex).format('0,0')));
    $('td', row).eq(1).html(formatLivestamp(renderedTimestamp));
    $('td', row).eq(3).html(formatLink('/' + coin + '/block/' + renderedBlockIndex, 'view', null, true));
    actions.forEach(function(val, idx){
        if(val>0){
            var num  = numeral(val).format('0,0'),
                icon = '';
            let name = XC.actions[idx];
            if(name=='addresses')     icon='fa-gears';
            if(name=='airdrops')      icon='fa-parachute-box';
            if(name=='batches')       icon='fa-layer-group';
            if(name=='broadcasts')    icon='fa-bullhorn';
            if(name=='callbacks')     icon='fa-recycle';
            if(name=='destroys')      icon='fa-trash';
            if(name=='dispensers')    icon='fa-arrows-h';
            if(name=='dispenses')     icon='fa-hand-holding-heart';
            if(name=='dividends')     icon='fa-sitemap';
            if(name=='files')         icon='fa-file';
            if(name=='issues')        icon='fa-bank';
            if(name=='links')         icon='fa-link';
            if(name=='lists')         icon='fa-list';
            if(name=='messages')      icon='fa-message';
            if(name=='mints')         icon='fa-print';
            if(name=='orders')        icon='fa-book';
            if(name=='order_cancels') icon='fa-book';
            if(name=='order_edits')   icon='fa-book';
            if(name=='order_matches') icon='fa-book';
            if(name=='sends')         icon='fa-send';
            if(name=='sleeps')        icon='fa-bed';
            if(name=='swaps')         icon='fa-exchange';
            if(name=='swap_cancels')  icon='fa-exchange';
            if(name=='swap_edits')    icon='fa-exchange';
            if(name=='swap_matches')  icon='fa-exchange';
            if(name=='sweeps')        icon='fa-truck';
            // name/num flow into an HTML attribute via .html() below; escape
            // before it lands in markup so an attribute-breakout can't inject.
            html += '<a title="' + escapeHtml(num) + ' ' + escapeHtml(name) + '">' + escapeHtml(num) + ' <i class="fa ' + icon + ' me-3"></i></a>';
        }
    });
    if(html=='')
        html = 'No transactions found';
    $('td', row).eq(2).html(html);

}
xcDatatableRowHandlers.block = xcDatatableRenderBlockRow;
function xcDatatableRenderBroadcastRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Broadcast

    let message = data[4];
    let value   = data[5];
    let fee     = data[6];
    // broadcasts.message is nullable and BROADCAST v3 legitimately carries
    // no MESSAGE, so the cell must read empty rather than "null".
    $('td', row).eq(4).text(nullToBlank(message));
    var fmt = (String(value).indexOf('.')==-1) ? fmtInteger : fmtCoin;
    $('td', row).eq(5).html(numeral(value).format(fmt));
    $('td', row).eq(6).html(fee);
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.broadcast = xcDatatableRenderBroadcastRow;
function xcDatatableRenderPriceRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Price (PRICE oracle: v0 validator COIN/FIAT snapshot, v0 validator BATCH
// of rounds, v1 user TOKEN/FIAT oracle).
//
// A batch is the shape a validator actually publishes, and its coin, token,
// fiat, value, fee and pair_count columns are ALL NULL by construction (the
// first five are v1 oracle columns; pair_count would describe one round out
// of the window). Reading only those left every validator row a line of
// dashes over an action that carried an hour of prices. The batch's own
// fields - the round window, how many rounds it carries and how wide a round
// is - describe it instead.

    let version    = data[4];
    let pcoin      = data[5];
    let token      = data[6];
    let fiat       = data[7];
    let round      = data[8];
    let firstRound = data[9];
    let lastRound  = data[10];
    let roundCount = data[11];
    let pairCount  = data[12];
    let batchPairs = data[13];
    let value      = data[14];
    let fee        = data[15];
    // Both bounds, never one: a half-set window is not a window, and a v0
    // single-round row and a v1 oracle carry neither.
    let isBatch    = !isNull(firstRound) && !isNull(lastRound);
    let typeHtml   = (Number(version)===0 ? '<span class="badge text-bg-secondary">Validator (v0)</span>' : '<span class="badge text-bg-primary">User (v1)</span>');
    if(isBatch)
        typeHtml += ' <span class="badge text-bg-dark">Batch</span>';
    $('td', row).eq(4).html(typeHtml);
    $('td', row).eq(5).text(isNull(pcoin) ? '-' : pcoin);
    $('td', row).eq(6).html(isNull(token) ? '-' : formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(7).text(isNull(fiat) ? '-' : fiat);
    // Rounds: the batch's declared window and its round count; on every
    // other shape the single round the action is about.
    let roundText = isNull(round) ? '-' : numeral(round).format(fmtInteger);
    if(isBatch){
        roundText = numeral(firstRound).format(fmtInteger) + ' - ' + numeral(lastRound).format(fmtInteger);
        if(!isNull(roundCount))
            roundText += ' (' + numeral(roundCount).format(fmtInteger) + ' round' + (Number(roundCount)===1 ? '' : 's') + ')';
    }
    $('td', row).eq(8).text(roundText);
    // Pairs: a single-round row states its own width; a batch states the
    // width of one round in the window, since every round in a batch is one
    // publisher's full snapshot.
    let pairText = '-';
    if(!isNull(pairCount))
        pairText = numeral(pairCount).format(fmtInteger);
    else if(!isNull(batchPairs))
        pairText = numeral(batchPairs).format(fmtInteger) + ' per round';
    $('td', row).eq(9).text(pairText);
    $('td', row).eq(10).text(isNull(value) ? '-' : value);
    $('td', row).eq(11).text(isNull(fee) ? '-' : fee);
    $('td', row).eq(12).html(action_link);

}
xcDatatableRowHandlers.price = xcDatatableRenderPriceRow;
function xcDatatableRenderControllerRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Controller binding (programmable-policy guard: bind/unbind event on a token or address)

    let scope    = data[3];
    let subject  = data[4];
    let aclass   = data[5];
    let guard    = data[6];
    let isUnbind = data[7];
    let cdBlocks = data[8];
    let cdEnd    = data[9];
    // data[3] (scope) is not an address; override the generic source link cell
    $('td', row).eq(3).html(scope=='address'
        ? '<span class="badge text-bg-info">Address</span>'
        : '<span class="badge text-bg-secondary">Token</span>');
    $('td', row).eq(4).html(isNull(subject) ? '-' : (scope=='address'
        ? formatLink('/' + coin + '/address/' + subject, subject)
        : formatLink(tokenUrl(coin, subject), subject, subject)));
    $('td', row).eq(5).text(isNull(aclass) ? '-' : aclass);
    $('td', row).eq(6).html(isNull(guard) ? '-' : formatLink('/' + coin + '/contract/' + guard, guard));
    $('td', row).eq(7).html(Number(isUnbind)===1
        ? '<span class="badge text-bg-warning">Unbind</span>'
        : '<span class="badge text-bg-success">Bind</span>');
    $('td', row).eq(8).text(isNull(cdBlocks) ? '-' : numeral(cdBlocks).format('0,0'));
    $('td', row).eq(9).text(isNull(cdEnd) ? '-' : numeral(cdEnd).format('0,0'));
    $('td', row).eq(10).html(action_link);

}
xcDatatableRowHandlers.controller = xcDatatableRenderControllerRow;
function xcDatatableRenderDeployChunkRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Deploy chunk (chunked DEPLOY v4 carrier: one base64 code slice of a contract source)

    let codeHash = data[4];
    let chunkIdx = data[5];
    let total    = data[6];
    $('td', row).eq(4).html(isNull(codeHash) ? '-' : '<span class="font-monospace" title="' + codeHash + '">' + String(codeHash).substring(0,16) + '…</span>');
    $('td', row).eq(5).text(isNull(chunkIdx) ? '-' : numeral(chunkIdx).format('0,0'));
    $('td', row).eq(6).text(isNull(total) ? '-' : numeral(total).format('0,0'));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.deploy_chunk = xcDatatableRenderDeployChunkRow;
function xcDatatableRenderCallbackRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Callback

    let token  = data[4];
    let token2 = data[5];
    let amount = data[6];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatLink(tokenUrl(coin, token2), token2, token2));
    $('td', row).eq(6).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.callback = xcDatatableRenderCallbackRow;
function xcDatatableRenderCreditRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Credit

    let token  = data[4];
    let amount = data[5];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.credit = xcDatatableRenderCreditRow;
function xcDatatableRenderDebitRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Debit

    let token  = data[4];
    let amount = data[5];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.debit = xcDatatableRenderDebitRow;
function xcDatatableRenderDestroyRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Destroy

    let token  = data[4];
    let amount = data[5];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.destroy = xcDatatableRenderDestroyRow;
function xcDatatableRenderDispenserRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Dispenser

    let give_coin      = data[4];
    let give_token     = data[5];
    let give_amount    = data[6];
    let get_coin       = data[7];
    let get_token      = data[8];
    let get_amount     = data[9];
    let give_ownership = data[10];
    if(give_ownership == 1){
        $('td', row).eq(4).html(formatLink(tokenUrl(give_coin, give_token), give_token, give_token) + ' ' + ownershipBadge());
    } else {
        $('td', row).eq(4).html(formatLinkAmount(tokenUrl(give_coin, give_token), give_token, give_token, give_amount));
    }
    // Built as a LOCAL, never appended onto the shared `html` scratch variable:
    // see formatNativeCoinLeg for why that mattered.
    let getLeg = isNull(get_token)
        ? formatNativeCoinLeg(get_amount, get_coin)
        : formatLinkAmount(tokenUrl(get_coin, get_token), get_token, get_token, get_amount);
    $('td', row).eq(5).html(getLeg);
    $('td', row).eq(6).html(formatLink('/' + coin + '/dispenser/' + action_index, 'view', null, true));

}
xcDatatableRowHandlers.dispenser = xcDatatableRenderDispenserRow;
function xcDatatableRenderDispenseRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Dispense

    let give_coin   = data[4];
    let give_token  = data[5];
    let give_amount = data[6];
    let get_coin    = data[7];
    let get_token   = data[8];
    let get_amount  = data[9];
    $('td', row).eq(4).html(formatLinkAmount(tokenUrl(give_coin, give_token), give_token, give_token, give_amount));
    // Local, not the shared `html` scratch variable: see formatNativeCoinLeg.
    let getLeg = isNull(get_token)
        ? formatNativeCoinLeg(get_amount, get_coin)
        : formatLinkAmount(tokenUrl(get_coin, get_token), get_token, get_token, get_amount);
    $('td', row).eq(5).html(getLeg);
    $('td', row).eq(6).html(action_link);


}
xcDatatableRowHandlers.dispense = xcDatatableRenderDispenseRow;
function xcDatatableRenderDividendRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Dividend

    let token  = data[4];
    let token2 = data[5];
    let amount = data[6];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatLink(tokenUrl(coin, token2), token2, token2));
    $('td', row).eq(6).html(formatAmount(data[6]));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.dividend = xcDatatableRenderDividendRow;
function xcDatatableRenderEscrowRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Escrow

    let token  = data[4];
    let amount = data[5];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.escrow = xcDatatableRenderEscrowRow;
