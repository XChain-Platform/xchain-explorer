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
function xcDatatableRenderSearchRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Search

    if(type=='address'){
        let address = data[1];
        $('td', row).eq(1).html(formatLink('/' + coin + '/address/' + address, highlightSearchTerm(XC.query, address)));
        $('td', row).eq(2).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));
    }
    if(type=='broadcast'){
        let message = data[1];
        let memo    = data[2];
        $('td', row).eq(1).html(highlightSearchTerm(XC.query, message));
        $('td', row).eq(2).html(highlightSearchTerm(XC.query, memo));
        $('td', row).eq(3).html(formatLink('/' + coin + '/action/' + data[3], 'view', null, true));
    }
    if(type=='token'){
        let token       = data[1];
        let description = data[2];
        $('td', row).eq(1).html(formatLink('/' + coin + '/token/' + token, highlightSearchTerm(XC.query, token), token));
        $('td', row).eq(2).html(highlightSearchTerm(XC.query, description));
        $('td', row).eq(3).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
    }
    if(type=='transaction'){
        let transaction = data[1];
        $('td', row).eq(1).html(formatLink('/' + coin + '/transaction/' + transaction, highlightSearchTerm(XC.query, transaction)));
        $('td', row).eq(2).html(formatLink('/' + coin + '/transaction/' + transaction, 'view', null, true));
    }
    // Contract: the fifth search category, matched on the declared name or
    // description through the contracts FULLTEXT index rather than by LIKE.
    // Name and description are author-supplied on-chain text, so both are
    // hardened before the term highlighter (which escapes) sees them; the
    // derived address is served by the API and is never omitted.
    if(type=='contract'){
        let meta_name    = data[1];
        let meta_version = data[2];
        let address      = data[3];
        let snippet      = data[4];
        let idx          = data[5];
        $('td', row).eq(1).html(isNull(meta_name)
            ? '<span class="text-muted fst-italic">Unnamed contract</span>'
            : highlightSearchTerm(XC.query, hardenText(meta_name, 64)));
        $('td', row).eq(2).text(isNull(meta_version) ? '' : hardenText(meta_version, 32));
        $('td', row).eq(3).html(formatLink('/' + coin + '/contract/' + idx, escapeHtml(address)));
        $('td', row).eq(4).html(highlightSearchTerm(XC.query, hardenText(snippet, 160)));
        $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + idx, 'view', null, true));
    }

}
xcDatatableRowHandlers.search = xcDatatableRenderSearchRow;
function xcDatatableRenderContractRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Contract (DEPLOY list). The Name cell carries the contract's declared
// meta.name (spec contract-meta-manifest 2.6), hardened and escaped: it is
// author-supplied on-chain text reaching an HTML sink. A contract deployed
// before CONTRACT_META_REQUIRED has none, and reads "Unnamed contract"
// rather than blank, which would look like a missing value.

    let meta_name = data[4];
    let code_hash = data[5];
    let api       = data[6];
    let cooldown  = data[7];
    $('td', row).eq(4).html(formatContractName(meta_name, null));
    $('td', row).eq(5).html(formatHash(code_hash));
    $('td', row).eq(6).text(api);
    $('td', row).eq(7).html(isNull(cooldown) ? 'No' : ('<span class="badge text-bg-info text-white">Stakeable</span> ' + numeral(cooldown).format(fmtInteger) + ' blk'));
    $('td', row).eq(8).html(formatLink('/' + coin + '/contract/' + action_index, 'view', null, true));

}
xcDatatableRowHandlers.contract = xcDatatableRenderContractRow;
function xcDatatableRenderExecutionRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Execution (EXECUTE list)

    let contract_index = data[3];
    let caller         = data[4];
    let method         = data[5];
    let gas            = data[6];
    $('td', row).eq(3).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + caller, caller));
    // contract_executions.method_name is nullable (an EXECUTE that names no
    // method still records a row, with its gas), so blank it rather than "null".
    $('td', row).eq(5).text(nullToBlank(method));
    $('td', row).eq(6).html(numeral(gas).format(fmtInteger));
    $('td', row).eq(7).html(formatLink('/' + coin + '/execution/' + action_index, 'view', null, true));

}
xcDatatableRowHandlers.execution = xcDatatableRenderExecutionRow;
function xcDatatableRenderDepositOrWithdrawalRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Deposit / Withdrawal (contract custody)

    let contract_index = data[4];
    let token  = data[5];
    let amount = data[6];
    $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(6).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.deposit = xcDatatableRenderDepositOrWithdrawalRow;
xcDatatableRowHandlers.withdrawal = xcDatatableRenderDepositOrWithdrawalRow;
function xcDatatableRenderValidatorRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Validator / capability stake. eq(7)-eq(9) are the hub federation registry's
// view of the SAME signing pubkey (addr / served chains / registration
// status), folded onto the on-chain active set so one page covers both.

// Registry strings are hub-supplied free text and render as TEXT, never
// markup. A null status means no registry was reachable (unknown);
// 'peered' means the hub has heard this pubkey over P2P but no capability
// is active yet; 'unregistered' means the hub answered and has never
// heard from this pubkey.

    let pubkey     = data[4];
    let version    = data[5];
    let amount     = data[6];
    let hub_addr   = data[7];
    let hub_chains = data[8];
    let hub_status = data[9];
    let reg_cls    = (hub_status=='active')     ? 'success'
                   : (hub_status=='peered')     ? 'info'
                   : (hub_status=='suspended')  ? 'warning text-dark'
                   : (hub_status=='removed')    ? 'danger'
                   : (hub_status=='unregistered') ? 'secondary'
                   : 'light text-dark';
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).text('v' + version);
    $('td', row).eq(6).html(formatAmount(amount));
    $('td', row).eq(7).text(isNull(hub_addr) ? '-' : hub_addr);
    $('td', row).eq(8).text(isNull(hub_chains) ? '-' : hub_chains);
    $('td', row).eq(9).html($('<span>')
        .addClass('badge text-bg-' + reg_cls)
        .text(isNull(hub_status) ? 'unknown' : hub_status));
    $('td', row).eq(10).html(action_link);

}
xcDatatableRowHandlers.validator = xcDatatableRenderValidatorRow;
function xcDatatableRenderStakeRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Raw stake list (all STAKE actions, any status; getStakes shaper, action_index last)

    let pubkey  = data[4];
    let version = data[5];
    let amount  = data[6];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).text('v' + version);
    $('td', row).eq(6).html(formatAmount(amount));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.stake = xcDatatableRenderStakeRow;
function xcDatatableRenderContractStakeRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Contract-targeted stake (STAKE v3)

    let pubkey         = data[4];
    let contract_index = data[5];
    let token  = data[6];
    let amount = data[7];
    let version = data[8];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(7).html(formatAmount(amount));
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.contract_stake = xcDatatableRenderContractStakeRow;
function xcDatatableRenderContractUnstakeRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Contract-targeted unstake (UNSTAKE v1)

    let pubkey         = data[4];
    let contract_index = data[5];
    let token  = data[6];
    let amount = data[7];
    let cooldown_end = data[8];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(7).html(formatAmount(amount));
    $('td', row).eq(8).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
    $('td', row).eq(9).html(action_link);

}
xcDatatableRowHandlers.contract_unstake = xcDatatableRenderContractUnstakeRow;
function xcDatatableRenderSlashEventRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Slash event (xchain.contract.slash emission; no own action_index; links to the EXECUTE)

    let pubkey         = data[3];
    let contract_index = data[4];
    let token       = data[5];
    let amount      = data[6];
    let destination = data[7];
    let execution_index = data[8];
    $('td', row).eq(3).html(formatHash(pubkey));
    $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(6).html(formatAmount(amount));
    $('td', row).eq(7).html(formatLink('/' + coin + '/address/' + destination, destination));
    $('td', row).eq(8).html(formatLink('/' + coin + '/action/' + execution_index, 'view', null, true));

}
xcDatatableRowHandlers.slash_event = xcDatatableRenderSlashEventRow;
function xcDatatableRenderAttestationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Attestation (ATTEST v0 request / v1 response from the `attests` table)
//
// TWO status fields ride this feed and they answer different questions.
// Rendering only the attester's HTTP result, under a heading a reader uses
// to ask whether the action COUNTED, shows an ATTEST the chain rejected as
// `ok`. They get a column each: Response is the attester's result (or the
// request's lifecycle state), Action Status is the chain's verdict on the
// action itself.
//
// Both the verdict and the action index are read POSITIONALLY here rather
// than through createdRow's generic data[length-1]/data[length-2] tail parse.
// The getAttestations feed appends payload, callback_params_json and
// fee_payer AFTER action_index, so on this page alone that parse reads
// fee_payer as the action index and callback_params_json as the verdict.

    let version         = data[4];
    let provider        = data[5];
    let request_id      = data[6];
    let request_status  = data[7];
    let response_status = data[8];
    $('td', row).eq(4).html((version == 0) ? '<span class="badge text-bg-secondary">Request</span>' : '<span class="badge text-bg-primary">Response</span>');
    $('td', row).eq(5).text(provider);
    let att_status      = data[9];
    let att_index       = data[10];
    let att_valid       = (att_status==1);
    let att_verdict     = att_valid ? 'valid' : 'invalid';
    $(row).removeClass('bg-green bg-red').addClass(att_valid ? 'bg-green' : 'bg-red');
    $('td', row).eq(6).html(formatLink('/' + coin + '/action/' + att_index, formatHash(request_id)));
    // Both attests.request_status and attests.response_status are nullable
    // ENUMs with no default; each row fills only the one for its version, and
    // an unresolved row leaves even that one NULL.
    $('td', row).eq(7).text(nullToBlank((version == 0) ? request_status : response_status));
    $('td', row).eq(8).html('<span class="badge text-bg-' + (att_valid ? 'success' : 'danger')
        + ' attestation-action-status" data-action-status="' + att_verdict + '">' + att_verdict + '</span>');
    $('td', row).eq(9).html(formatLink('/' + coin + '/action/' + att_index, 'view', null, true));

}
xcDatatableRowHandlers.attestation = xcDatatableRenderAttestationRow;
function xcDatatableRenderPollRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// VOTE poll (polls table; token-weighted governance, VOTE v0). eq(4) token,
// eq(5) question, eq(6) lifecycle-status badge (open/finalized/failed_quorum),
// eq(7) close block, eq(8) binding badge (a non-null callback contract means
// the poll result fires a contract method, i.e. it can move real value),
// eq(9) the WINNER: winning_option is an INDEX into the poll's options, so
// option 0 is a real winner and only a null reads as "no outcome recorded".
// The feed carries the index and the label resolved off the options JSON
// (getPagingDataResults), because a bare index names nothing to a reader.
// Option labels are attacker-controlled on-chain bytes, so the cell is
// written with .text(), exactly like the question above it.

    let token         = data[4];
    let question      = data[5];
    let poll_status   = data[6];
    let end_block     = data[7];
    let binding       = data[8];
    let winner_index  = data[9];
    let winner_label  = data[10];
    let pcls = (poll_status=='finalized') ? 'success' : (poll_status=='failed_quorum') ? 'danger' : 'warning text-dark';
    $('td', row).eq(4).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(5).text(isNull(question) ? '-' : question);
    $('td', row).eq(6).html('<span class="badge text-bg-' + pcls + '">' + (poll_status || '-') + '</span>');
    $('td', row).eq(7).html(isNull(end_block) ? '-' : formatLink('/' + coin + '/block/' + end_block, numeral(end_block).format(fmtInteger)));
    $('td', row).eq(8).html(isNull(binding) ? '-' : formatLink('/' + coin + '/contract/' + binding, '<span class="badge text-bg-danger">Binding</span>', 'Binding poll: finalization calls contract ' + binding));
    $('td', row).eq(9).text(isNull(winner_index) ? '-' : (winner_index + (isNull(winner_label) ? '' : ': ' + winner_label)));
    $('td', row).eq(10).html(action_link);

}
xcDatatableRowHandlers.poll = xcDatatableRenderPollRow;
function xcDatatableRenderVoteRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// VOTE ballot (votes table; one row per voter choice, VOTE v1). eq(4) links the
// poll it voted on, eq(5) the chosen option index, eq(6) the split-mode share.

    let poll_index = data[4];
    let choice     = data[5];
    let share      = data[6];
    $('td', row).eq(4).html(isNull(poll_index) ? '-' : formatLink('/' + coin + '/action/' + poll_index, poll_index));
    $('td', row).eq(5).text(isNull(choice) ? '-' : choice);
    $('td', row).eq(6).text(isNull(share) ? '-' : share);
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.vote = xcDatatableRenderVoteRow;
function xcDatatableRenderBetFeedRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// BET market (bet_feeds; BET format 0). eq(5) is the market LABEL, which is
// attacker-controlled on-chain text, so it goes in with .text() and never
// as markup. The status shown is the STORED feed status.

    let token        = data[4];
    let label        = data[5];
    let feed_status  = data[6];
    let deadline     = data[7];
    let fcls = (feed_status=='resolved') ? 'success'
             : (feed_status=='cancelled' || feed_status=='expired') ? 'danger'
             : (feed_status=='resolved_void') ? 'secondary'
             : (feed_status=='closed') ? 'warning text-dark' : 'primary';
    $('td', row).eq(4).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(5).text(isNull(label) ? '-' : label);
    $('td', row).eq(6).html('<span class="badge text-bg-' + fcls + '">' + escapeHtml(String(feed_status || '-')) + '</span>');
    $('td', row).eq(7).html(isNull(deadline) ? '-' : formatLivestamp(deadline));
    // The view button targets the MARKET page, not the raw action page.
    $('td', row).eq(8).html(formatLink('/' + coin + '/bet_feed/' + data[9], '<i class="fa fa-eye"></i>', 'View market'));

}
xcDatatableRowHandlers.bet_feed = xcDatatableRenderBetFeedRow;
function xcDatatableRenderBetRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// BET wager (bets; BET format 2). eq(4) links the market it was placed on.

    let feed_index = data[4];
    let outcome    = data[5];
    let token      = data[6];
    let amount     = data[7];
    let bet_status = data[8];
    let bcls = (bet_status=='won') ? 'success' : (bet_status=='lost') ? 'danger'
             : (bet_status=='refunded') ? 'secondary' : 'primary';
    $('td', row).eq(4).html(isNull(feed_index) ? '-' : formatLink('/' + coin + '/bet_feed/' + feed_index, feed_index));
    $('td', row).eq(5).text(isNull(outcome) ? '-' : outcome);
    $('td', row).eq(6).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
    $('td', row).eq(7).html(formatAmount(amount));
    $('td', row).eq(8).html('<span class="badge text-bg-' + bcls + '">' + escapeHtml(String(bet_status || '-')) + '</span>');
    $('td', row).eq(9).html(action_link);

}
xcDatatableRowHandlers.bet = xcDatatableRenderBetRow;
function xcDatatableRenderXcallRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// XCALL (cross-chain call, source-chain request row). eq(3) overrides the
// generic source-address link with the emitting contract.

    let contract_index        = data[3];
    let target_chain          = data[4];
    let target_contract_index = data[5];
    let method                = data[6];
    let request_status        = data[7];
    let cls = (request_status=='completed') ? 'success' : (request_status=='expired') ? 'danger' : (request_status=='pending') ? 'warning text-dark' : 'secondary';
    $('td', row).eq(3).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(4).text(isNull(target_chain) ? '-' : target_chain);
    $('td', row).eq(5).text(isNull(target_contract_index) ? '-' : target_contract_index);
    $('td', row).eq(6).text(isNull(method) ? '-' : method);
    $('td', row).eq(7).html('<span class="badge text-bg-' + cls + '">' + (request_status || '-') + '</span>');
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.xcall = xcDatatableRenderXcallRow;
function xcDatatableRenderCollectRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, timestamp, source, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Collect (validator reward claim; reward_claims)

    let amount = data[4];
    $('td', row).eq(4).html(formatAmount(amount));
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.collect = xcDatatableRenderCollectRow;
