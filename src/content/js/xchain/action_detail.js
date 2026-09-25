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
 * action_detail.js
 *
 * Custom javascript for xchain explorer
 */

// Handle getting a quick summary of action details
function getActionDetails(action, info){
    let html = '';
    let coin = XC.coin; // TODO: update when XChain adds cross-network support
    html = actionDetail_renderBasicActions(html, action, info, coin);
    html = actionDetail_renderMarketActions(html, action, info, coin);
    html = actionDetail_renderMessageActions(html, action, info, coin);
    html = actionDetail_renderContractActions(html, action, info, coin);
    html = actionDetail_renderConsensusActions(html, action, info, coin);
    return html;
}

function actionDetail_renderBasicActions(html, action, info, coin){
    // Render summaries for the initial transaction action families.
    if(action=='ADDRESS'){
        // v1 is a controller bind, not a preferences edit: summarizing one with the preference
        // defaults described an action it never took.
        if(info.action_format==1){
            let verb = (info.unbind==1) ? 'Unbind' : 'Bind';
            html += verb + ' ' + (info.action_class || '-');
            if(info.controller != null)
                html += ' ' + formatLink('/' + coin + '/action/' + info.controller, info.controller);
        } else {
            let pref = (info.fee_preference==1) ? 'Destroy' : 'Donate';
            let memo = (info.require_memo==1) ? 'True' : 'False';
            let disp = (info.dispenser_preference) ? XC.dispenser_preferences[info.dispenser_preference] : 'Not set';
            html += 'Fee Preference: ' + pref + '; Require Memo: ' + memo + '; Dispenser Preference: ' + disp;
        }
    }
    if(action=='AIRDROP'){
        html += info.amount + formatLink(tokenUrl(coin, info.tick), info.tick, info.tick) + ' to ';
        // Route the list reference as an ACTION, not a token: airdrops.list_action_index is the
        // index of the LIST action being paid out (indexer db.js createAirdrop), so a /token/ URL
        // searched for a token named after a number. showAirdropDetails already links
        // this same field through /action/.
        html += 'List ' + formatLink('/' + coin + '/action/' + info.list_action_index, info.list_action_index);
    }
    if(action=='BROADCAST'){
        // Read the broadcast's own fee fraction from its aliased column (broadcast_fee),
        // NOT info.fee: for a BATCH child `info` is a full getActionData result whose fee
        // slot is overwritten with the protocol-fee record, and bcmul on that object threw
        // and aborted the whole member-table render (same fix applied at the other call site).
        // FEE is an OPTIONAL wire field on BROADCAST v1/v2 (xchain-indexer broadcast.js: a
        // null FEE is not an error), so a feed broadcast without one stores NULL. Emitting
        // the label anyway printed a bare `Fee: %` with nothing in front of it. Build the
        // whole clause here so it disappears when there is no fee to state, rather than
        // guessing at 0% - a fee this action never declared.
        let percent = (isNumeric(info.broadcast_fee))
            ? ' <b>Fee:</b> ' + bcmul(info.broadcast_fee, 100, 2) + '%'
            : '';
        // info.message / info.value are BROADCAST free text (on-chain,
        // attacker-controlled) and this html is injected via .html(). Escape them.
        if(info.action_format==0){
            html += escapeHtml(info.message);
        } else if(info.action_format==1){
            html += '<b>Oracle:</b> ' + escapeHtml(info.message) + ' = ' + formatAmount(info.value) + percent;
        } else if(info.action_format==2){
            html += '<b>Feed:</b> ' + escapeHtml(info.message) + percent;
        } else if(info.action_format==3){
            html += '<b>Feed Results:</b> ' + formatLink('/' + coin + '/action/' + info.broadcast_action_index, info.broadcast_action_index) + ' <b>Result:</b> ' + escapeHtml(String(info.value));
        }
    }
    if(action=='CALLBACK'){
        html += formatLink(tokenUrl(coin, info.tick), info.tick, info.tick) + ' for ' ;
        html += formatLinkAmount(tokenUrl(coin, info.callback_tick), info.callback_tick, info.callback_tick, info.callback_amount);
    }
    if(action=='DIVIDEND'){
        html += formatLinkAmount(tokenUrl(coin, info.dividend_tick), info.dividend_tick, info.dividend_tick, info.amount) + ' per ';
        html += formatLinkAmount(tokenUrl(coin, info.tick), info.tick, info.tick, 1)
    }
    return html;
}

function actionDetail_renderMarketActions(html, action, info, coin){
    // Render market, file, issue, link, and list summaries.
    if(['DISPENSER', 'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_CANCEL', 'DISPENSER_EXPIRE', 'DISPENSER_EDIT',
        'SWAP', 'SWAP_MATCH', 'SWAP_CANCEL', 'SWAP_EXPIRE', 'SWAP_EDIT',
        'ORDER', 'ORDER_MATCH', 'ORDER_CANCEL', 'ORDER_EXPIRE', 'ORDER_EDIT'].includes(action)){
        // Namespace each leg by its OWN coin (give_coin/get_coin), never the broadcast
        // chain: a CROSS_CHAIN_DEX order/swap/dispenser puts give and get on different
        // networks, so the page coin would link a remote token into the wrong namespace
        // and label a remote native amount local. Fall back to it only where absent.
        let give_coin = info.give_coin || coin;
        let get_coin  = info.get_coin  || coin;
        html  = formatLinkAmount(tokenUrl(give_coin, info.give_tick), info.give_tick, info.give_tick, info.give_amount) + ' for ';
        if(isNull(info.get_tick)){
            let cls = getNetworkIcon();
            html += ' <i class="fa ' + cls + '"></i> ' + formatAmount(info.get_amount) + ' ' + get_coin ;
        } else {
            html  += formatLinkAmount(tokenUrl(get_coin, info.get_tick), info.get_tick, info.get_tick, info.get_amount);
        }
    }
    if(action=='FILE')
        html = info.type + ' - ' + info.name + ' - ' + info.title;
    if(action=='ISSUE')
        html = formatLink(tokenUrl(coin, info.tick), info.tick, info.tick);
    if(action=='LINK'){
        // Both link legs are ACTION indexes on their own chains (links.coin1_action_index /
        // coin2_action_index, indexer db.js createLink), not tickers, so /token/ opened a token
        // search for a number. showLinkDetails already uses /action/ for these two.
        html += info.coin1 + ' action ' + formatLink('/' + info.coin1 + '/action/' + info.coin1_action_index, info.coin1_action_index) + ' to ';
        html += info.coin2 + ' action ' + formatLink('/' + info.coin2 + '/action/' + info.coin2_action_index, info.coin2_action_index);
    }
    if(action=='LIST'){
        let action3 = (info.edit) ? (info.edit==1) ? 'Add to' : 'Remove from' : 'Create'; 
        // Read the type off the canonical XC.list_types map, never a second inline copy:
        // showListDetails consumes the map too, so this keeps one source of truth. An
        // invalid edit row can carry a null type, the parent lookup having failed while
        // the row persisted, so name that case rather than printing 'undefined'.
        let type2   = XC.list_types[info.type] || 'Unknown';
        html = action3 + ' ' + type2 + ' List';
    }
    return html;
}

function actionDetail_renderMessageActions(html, action, info, coin){
    // Render message, transfer, sweep, and sleep summaries.
    if(action=='MESSAGE'){
        // Link the destination on ITS own chain: MESSAGE deliberately allows a destination on
        // another network (the indexer validates DESTINATION against COIN, not the broadcast
        // chain), and messages.coin is that destination network. Building the URL from the page
        // coin sent a BTC-addressed message broadcast on DOGE to /DOGE/address/...
        let dest_coin = info.coin || coin;
        // Summarize by RECORD FORMAT, not by encryption_method: formats 0 and 1 are the key
        // exchange, 2 is the encrypted message, 3 is plaintext (indexer actions/message.js
        // formats). A v2 record carries no method on the wire and the indexer stamps method 1
        // (ECIES) onto it, so keying off the method labelled every ordinary encrypted message
        // an 'Encryption key exchange'. A row missing action_format keeps the old
        // plaintext/encrypted fallback rather than defaulting into the key-exchange branch.
        if(!isNull(info.action_format) && [0,1].includes(Number(info.action_format))){
            html = 'Encryption key exchange with ' + formatLink('/' + dest_coin + '/address/' + info.destination, info.destination);
        } else if(info.plaintext_message){
            html = info.plaintext_message;
        } else {
            html = 'Encrypted message to ' + formatLink('/' + dest_coin + '/address/' + info.destination, info.destination);
        }
    }
    if(action=='MINT')
        html = formatLinkAmount(tokenUrl(coin, info.tick), info.tick, info.tick, info.amount);
    if(action=='SEND'){
        // A SEND detail payload keeps tick/amount/destination per destination under
        // sends[]; the summary producers flatten sends[0], but tolerate the nested
        // shape too so a raw payload never renders as ' to ' plus an empty link.
        let sends = (isNull(info.tick) && isNull(info.destination) && Array.isArray(info.sends)) ? info.sends : null;
        if(sends && sends.length > 1){
            let sameTick = sends.every((s) => s.tick == sends[0].tick);
            if(sameTick){
                let total = sends.reduce((sum, s) => bcadd(sum, s.amount), '0');
                html += formatLinkAmount(tokenUrl(coin, sends[0].tick), sends[0].tick, sends[0].tick, total) + ' to ';
            } else {
                html += 'Multiple tokens to ';
            }
            html += sends.length + ' recipients';
        } else {
            let send = (sends && sends.length === 1) ? sends[0] : info;
            html += formatLinkAmount(tokenUrl(coin, send.tick), send.tick, send.tick, send.amount) + ' to ';
            html += formatLink('/' + coin + '/address/' + send.destination, send.destination);
        }
    }
    if(action=='SWEEP'){
        html += formatLink('/' + coin + '/address/' + info.source, info.source) + ' to ';
        html += formatLink('/' + coin + '/address/' + info.destination, info.destination);
    }
    if(action=='SLEEP'){
        if(info.type==1)
            html = 'Address';
        if(info.type==2)
            html = formatLink(tokenUrl(coin, info.tick), info.tick, info.tick);
        html += ' until block ' + formatAmount(info.resume_block);
    }
    return html;
}

function actionDetail_renderContractActions(html, action, info, coin){
    // Render staking and contract family summaries.
    // Compact summaries for the staking / contract families. Field names
    // mirror each type's show*Details() renderer.
    if(action=='DESTROY')
        html = formatLinkAmount(tokenUrl(coin, info.tick), info.tick, info.tick, info.amount);
    if(action=='STAKE'){
        html = formatAmount(info.amount);
        html += isNull(info.target_contract_index)
            ? ' capability stake'
            : ' on contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
    }
    if(action=='UNSTAKE'){
        html = formatAmount(info.amount);
        html += isNull(info.target_contract_index)
            ? ' capability unstake'
            : ' from contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
        if(!isNull(info.cooldown_end_block))
            html += ', cooldown until block ' + formatAmount(info.cooldown_end_block);
    }
    if(action=='DELEGATE'){
        html = isNull(info.target_contract_index)
            ? 'Capability delegation'
            : 'Delegate to contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
    }
    if(action=='COLLECT')
        html = 'Claim ' + formatAmount(info.amount) + ' validator reward';
    if(action=='SLASH')
        html = 'Slash ' + formatAmount(info.amount) + (isNull(info.capability) ? '' : ' (' + escapeHtml(String(info.capability)) + ')');
    if(action=='DEPLOY'){
        // DEPLOY v4 (action_format 4) is a chunk carrier, not a contract: no /contract/ link.
        if(Number(info.action_format) === 4){
            let idx = isNull(info.chunk_index) ? '?' : (Number(info.chunk_index) + 1);
            let total = isNull(info.total_chunks) ? '?' : info.total_chunks;
            html = 'Contract code chunk ' + idx + ' of ' + total;
        } else {
            html = 'Contract ' + formatLink('/' + coin + '/contract/' + info.action_index, info.action_index);
            if(!isNull(info.cooldown_blocks)) html += ' (stakeable)';
        }
    }
    if(action=='EXECUTE'){
        html = 'Call ' + escapeHtml(String(info.method_name || '')) + ' on contract ';
        html += formatLink('/' + coin + '/contract/' + info.contract_index, info.contract_index);
    }
    if(action=='DEPOSIT' || action=='WITHDRAW'){
        html = formatLinkAmount(tokenUrl(coin, info.tick), info.tick, info.tick, info.amount);
        html += (action=='DEPOSIT' ? ' into contract ' : ' out of contract ');
        html += formatLink('/' + coin + '/contract/' + info.contract_index, info.contract_index);
    }
    if(action=='VOTE')
        html = 'Vote' + (isNull(info.vote_kind) ? '' : ': ' + escapeHtml(String(info.vote_kind)));
    return html;
}

function actionDetail_renderConsensusActions(html, action, info, coin){
    // Render consensus summaries and the generic action fallback.
    // Consensus actions. These reach the history feed on every network (and are the
    // ONLY actions on a chain that carries no user traffic yet), so the humanized
    // fallback below would leave a whole feed reading "Anchor / Anchor / Price".
    if(action=='ANCHOR'){
        // Which chain+network this checkpoint is FOR, then what it pins. chain/network
        // are indexer-written enum-ish columns; escaped because they still reach .html().
        let scope = [info.chain, info.network].filter((v) => !isNull(v)).map((v) => escapeHtml(String(v))).join(' ');
        html = (scope ? scope + ' ' : '') + 'checkpoint';
        if(!isNull(info.checkpoint_seq))
            html += ' #' + numeral(info.checkpoint_seq).format('0,0');
        // anchored_block_index is the height being checkpointed on info.chain, which is
        // NOT the page coin, so it is stated rather than linked (the /block/ route would
        // resolve it against the wrong network).
        if(!isNull(info.anchored_block_index))
            html += ' at block ' + numeral(info.anchored_block_index).format('0,0');
        // The archive-continuation variants carry no checkpoint of their own.
        if(!isNull(info.chunk_index) && !isNull(info.total_chunks))
            html += ' (chunk ' + (Number(info.chunk_index) + 1) + ' of ' + info.total_chunks + ')';
    }
    if(action=='PRICE'){
        if(!isNull(info.batch_first_round) && !isNull(info.batch_last_round)){
            // A validator batch: name the window, not a single round, and say how wide
            // each round is so the row shows the action carried real price data.
            let n = isNull(info.round_count) ? null : Number(info.round_count);
            html  = 'Rounds ' + numeral(info.batch_first_round).format('0,0') + '-' + numeral(info.batch_last_round).format('0,0');
            if(n !== null)
                html += ' (' + numeral(n).format('0,0') + ' round' + (n===1 ? '' : 's') + ')';
        } else if(!isNull(info.tick) || !isNull(info.fiat)){
            // A v1 user oracle: TOKEN/FIAT and the published value.
            html  = formatLink(tokenUrl(coin, info.tick), info.tick, info.tick);
            html += '/' + escapeHtml(nullToBlank(info.fiat)) + ' = ' + formatAmount(info.value);
        } else if(!isNull(info.round_number)){
            html = 'Round ' + numeral(info.round_number).format('0,0');
            if(!isNull(info.pair_count))
                html += ' (' + numeral(info.pair_count).format('0,0') + ' pairs)';
        }
    }
    // Never render a blank Details cell: any type without an explicit summary
    // above (BATCH, XCALL, XEXEC, CROSS_SETTLE, NODEPROOF, ATTEST, COINPAY,
    // ... and any FUTURE type) falls back to a humanized action name, so a new
    // action type can no longer silently summarize as empty while being fully
    // supported everywhere else.
    if(html === ''){
        let words = String(action).toLowerCase().split('_');
        html = words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
    }
    return html;
}
