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
var xcDatatableRowHandlers = xcDatatableRowHandlers || {};
function xcDatatableRenderFeeRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Fee

    let token  = data[4];
    let amount = data[5];
    let type2  = data[6];
    // Fee payment method
    let txt = (type2==1) ? 'Destroy' : 'Donate';
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(numeral(amount).format(fmtCoin));
    $('td', row).eq(6).text(txt);
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.fee = xcDatatableRenderFeeRow;
function xcDatatableRenderFileRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// File

    // Token-gated FILE: flag it with a lock badge on the Name cell (the
    // file renderer is shared across pages with different column counts,
    // so we annotate an existing cell rather than add a column).
    let gate = data[7];
    if(!isNull(gate))
        $('td', row).eq(4).append(' <span class="badge text-bg-warning" title="Gated by ' + escapeHtml(gate) + '"><i class="fa fa-lock"></i></span>');
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.file = xcDatatableRenderFileRow;
function xcDatatableRenderHolderRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Holder

    let address = data[1];
    let amount  = data[2];
    let percent = data[3];
    let value   = data[4];
    $('td', row).eq(1).html(formatLink('/' + coin + '/address/' + address, address));
    $('td', row).eq(2).html(formatAmount(amount));
    $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
    let html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
    html += ' <span class="badge text-bg-info text-white">$' + numeral(value * XC.coin_price).format(fmtCurrency) + '</span>';
    $('td', row).eq(4).html(html);
    $('td', row).eq(5).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));

}
xcDatatableRowHandlers.holder = xcDatatableRenderHolderRow;
function xcDatatableRenderIssueRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Issue

    let amount  = data[5];
    let amount2 = data[6];
    let locks   = data[7];
    // data[8] = ownership-transfer destination; when set, this issue
    // moved the token's ownership record (the provenance trail for
    // NFT collections (nft-standard.md#collections))
    let transfer = data[8];
    if(!isNull(transfer))
        $('td', row).eq(3).html(source_link + ' <i class="fa fa-arrow-right ps-1 pe-1" title="Token ownership transferred"></i> ' + formatLink('/' + coin + '/address/' + transfer, transfer));
    $('td', row).eq(5).text(formatZeroSentinel(amount, 'No cap declared'));
    $('td', row).eq(6).text(formatZeroSentinel(amount2, 'No per-transaction cap'));
    $('td', row).eq(7).html(formatLocks(locks));
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.issue = xcDatatableRenderIssueRow;
function xcDatatableRenderLinkRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Link

    let coin1       = data[4];
    let coin1_index = data[5];
    let coin2       = data[6];
    let coin2_index = data[7];
    let memo        = data[8];
    $('td', row).eq(4).html(formatLink('/' + networkCoin(coin1) + '/action/' + coin1_index, coin1 + '-' + coin1_index));
    $('td', row).eq(5).html(formatLink('/' + networkCoin(coin2) + '/action/' + coin2_index, coin2 + '-' + coin2_index));
    // memo reaches the feed through a LEFT JOIN on index_memos, so it is
    // null for the (common) LINK that carries no memo.
    $('td', row).eq(6).text(nullToBlank(memo));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.link = xcDatatableRenderLinkRow;
function xcDatatableRenderListRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// List

    let type2 = data[4];
    let edit  = data[5];
    // List Type
    let txt = '';
    if(type2==1) txt='Token';
    if(type2==2) txt='Address';
    $('td', row).eq(4).text(txt);
    // Edit Type
    txt = 'Create';
    if(edit==1) txt='Add';
    if(edit==2) txt='Remove';
    $('td', row).eq(5).text(txt);
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.list = xcDatatableRenderListRow;
function xcDatatableRenderMarketRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Markets

    let tick1  = data[1],
        tick2  = data[2],
        market = encodeURIComponent(String(tick1)) + '/' + encodeURIComponent(String(tick2)), // each tick is one free-text segment
        price  = data[3],
        ask    = data[4],
        bid    = data[5],
        volume = data[6],
        change = data[7];
    let html = '<img src="' + getTokenIcon(tick1) + '" class="icon-20">' +
               '<img src="' + getTokenIcon(tick2) + '" class="icon-20 ms-1 me-1">' +
               escapeHtml(tick1) + ' / ' + escapeHtml(tick2); // ticks are free text inside markup
    $('td', row).eq(1).html(formatLinkHtml('/' + coin + '/market/' + market, html));
    $('td', row).eq(2).html(formatAmount(price));
    $('td', row).eq(3).html(formatAmount(ask));
    $('td', row).eq(4).html(formatAmount(bid));
    $('td', row).eq(5).html(formatAmount(volume));
    var cls = (change && change.indexOf('-')==-1) ? 'text-success' : 'text-danger';
    $('td', row).eq(6).addClass(cls).html(formatAmount(change));
    $('td', row).eq(7).html(formatLink('/' + coin + '/market/' + market, 'view', null, true));

}
xcDatatableRowHandlers.market = xcDatatableRenderMarketRow;
function xcDatatableRenderMessageRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Message

    let destination = data[4];
    $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.message = xcDatatableRenderMessageRow;
function xcDatatableRenderMintRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Mint

    let token       = data[4];
    let amount      = data[5];
    let destination = data[6];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    // Write the cell either way: a MINT's DESTINATION is optional, and
    // skipping it leaves the raw feed value DataTables rendered, which
    // for a null column is the word "null".
    $('td', row).eq(6).html(isNull(destination)
        ? ''
        : formatLink('/' + coin + '/address/' + destination, destination));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.mint = xcDatatableRenderMintRow;
function xcDatatableRenderOrderRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Order

    let token          = data[4];
    let amount         = data[5];
    let token2         = data[6];
    let amount2        = data[7];
    let give_ownership = data[8];
    let get_ownership  = data[9];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
    $('td', row).eq(6).html(formatLink(tokenUrl(coin, token2), token2, token2));
    $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.order = xcDatatableRenderOrderRow;
function xcDatatableRenderSendRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Send

    let token       = data[4];
    let amount      = data[5];
    let destination = data[6];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(6).html(formatLink('/' + coin + '/address/' + destination, destination));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.send = xcDatatableRenderSendRow;
function xcDatatableRenderSleepRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Sleep

    let type2        = data[4];
    let token        = data[5];
    let block_index2 = data[6];
    // Sleep Type
    let txt = '';
    if(type2==1) txt='Address';
    if(type2==2) txt='Token';
    $('td', row).eq(4).text(txt);
    if(token!='')
        $('td', row).eq(5).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(6).html(formatResumeBlock(coin, block_index2));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.sleep = xcDatatableRenderSleepRow;
function xcDatatableRenderSwapRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Swap

    let token          = data[4];
    let amount         = data[5];
    let token2         = data[6];
    let amount2        = data[7];
    let give_ownership = data[8];
    let get_ownership  = data[9];
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
    $('td', row).eq(6).html(formatLink(tokenUrl(coin, token2), token2, token2));
    $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.swap = xcDatatableRenderSwapRow;
function xcDatatableRenderSweepRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Sweep

    let destination = data[4];
    $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
    let txt = (data[5]==1) ? 'True' : 'False';
    $('td', row).eq(5).text(txt);
    txt = (data[6]==1) ? 'True' : 'False';
    $('td', row).eq(6).text(txt);
    txt = (data[7]==1) ? 'True' : 'False';
    $('td', row).eq(7).text(txt);
    txt = (data[8]==1) ? 'True' : 'False';
    $('td', row).eq(8).text(txt);
    txt = (data[9]==1) ? 'True' : 'False';
    $('td', row).eq(9).text(txt);
    $('td', row).eq(10).html(action_link);

}
xcDatatableRowHandlers.sweep = xcDatatableRenderSweepRow;
function xcDatatableRenderTokenRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Tokens

    let token   = data[3];
    let amount  = data[4];
    let amount2 = data[5];
    let amount3 = data[6];
    let locks   = data[7];
    let tickHtml = formatLink(tokenUrl(coin, token), token, token);
    $('td', row).eq(3).html(tickHtml);
    $('td', row).eq(4).text(formatAmount(amount));
    $('td', row).eq(5).text(formatZeroSentinel(amount2, 'No cap declared'));
    $('td', row).eq(6).text(formatZeroSentinel(amount3, 'No per-transaction cap'));
    $('td', row).eq(7).html(formatLocks(locks));
    $('td', row).eq(8).html(formatLink(tokenUrl(coin, token), 'view', null, true));

}
xcDatatableRowHandlers.token = xcDatatableRenderTokenRow;
function xcDatatableRenderProjectRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Official Tokens (project roster; same row shape as Tokens)

    let token   = data[3];
    let amount  = data[4];
    let amount2 = data[5];
    let amount3 = data[6];
    let locks   = data[7];
    let pTickHtml = formatLink(tokenUrl(coin, token), token, token);
    $('td', row).eq(3).html(pTickHtml);
    $('td', row).eq(4).text(formatAmount(amount));
    $('td', row).eq(5).text(formatZeroSentinel(amount2, 'No cap declared'));
    $('td', row).eq(6).text(formatZeroSentinel(amount3, 'No per-transaction cap'));
    $('td', row).eq(7).html(formatLocks(locks));
    $('td', row).eq(8).html(formatLink(tokenUrl(coin, token), 'view', null, true));

}
xcDatatableRowHandlers.project = xcDatatableRenderProjectRow;
function xcDatatableRenderActionRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Raw action list: one row per action with its type name; no per-type
// details on this feed (they live on the action page). No status column
// on the actions table, so 'action' sits in the no-color list above.

    let action2 = data[4];
    $('td', row).eq(4).html('<span class="badge text-bg-info">' + escapeHtml(String(action2 || '-')) + '</span>');
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.action = xcDatatableRenderActionRow;
function xcDatatableRenderOrderMatchRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Order match: each leg links the matched ORDER's action on its own coin
// (the match row carries coins and action indexes, not ticks).

    let give_coin  = data[3];
    let give_index = data[4];
    let get_coin   = data[6];
    let get_index  = data[7];
    let settlement = data[9];
    $('td', row).eq(3).html(formatLink('/' + networkCoin(give_coin) + '/action/' + give_index, give_coin + '-' + give_index));
    $('td', row).eq(4).html(formatAmount(data[5]));
    $('td', row).eq(5).html(formatLink('/' + networkCoin(get_coin) + '/action/' + get_index, get_coin + '-' + get_index));
    $('td', row).eq(6).html(formatAmount(data[8]));
    $('td', row).eq(7).text(isNull(settlement) ? '-' : settlement);
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.order_match = xcDatatableRenderOrderMatchRow;
function xcDatatableRenderSwapMatchRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Swap match: same two-leg rendering minus the amount and settlement
// columns, which a swap match does not carry.

    let give_coin  = data[3];
    let give_index = data[4];
    let get_coin   = data[5];
    let get_index  = data[6];
    $('td', row).eq(3).html(formatLink('/' + networkCoin(give_coin) + '/action/' + give_index, give_coin + '-' + give_index));
    $('td', row).eq(4).html(formatLink('/' + networkCoin(get_coin) + '/action/' + get_index, get_coin + '-' + get_index));
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.swap_match = xcDatatableRenderSwapMatchRow;
function xcDatatableRenderHistoryRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// History

    let action2 = data[3];
    let info    = data[4];
    $('td', row).eq(3).html(action2);
    let html = getActionDetails(action2, info);
    $('td', row).eq(4).html(html);
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.history = xcDatatableRenderHistoryRow;
function xcDatatableRenderMarketHistoryRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Market History

    let marketType = data[3];
    let price      = bcformat(data[4],8);
    let amount     = bcformat(data[5],8);
    let total      = bcformat(bcmul(price, amount),8);
    $('td', row).eq(3).html(marketType);
    $('td', row).eq(4).html(formatAmount(price));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(6).html(formatAmount(total));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers['market-history'] = xcDatatableRenderMarketHistoryRow;
