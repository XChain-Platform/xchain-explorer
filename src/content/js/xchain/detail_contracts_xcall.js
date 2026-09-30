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
 * detail_contracts_xcall.js
 *
 * Custom javascript for xchain explorer
 */

// Display DEPLOY action information (contract; v1 surfaces staking metadata)
function showDeployDetails(data){
    // DEPLOY v4 (action_format 4) is a chunk carrier: one base64 code slice in deploy_chunks,
    // NOT a contract. It normally has no contract row, api_version, cooldown or
    // slash_destination, so rendering the contract shape would produce a dead /contract/ link
    // and blank fields. The exception is a carrier that COMPLETED a chunked group: deferred
    // assembly runs the deployment at whichever piece completes the group, so the contract
    // really was created at this action, and deployed_contract_index is how the API says so.
    let isChunk = (Number(data.action_format) === 4);
    // Where the contract this action asked for actually landed. Null on an assembler still
    // waiting for its carriers, on one whose group failed at the completing piece, and on
    // an ordinary carrier that completed nothing.
    let deployed = isNull(data.deployed_contract_index) ? null : data.deployed_contract_index;
    $('#info-deploy .deploy-contract-row').toggleClass('d-none', isChunk && deployed === null);
    $('#info-deploy .deploy-chunk-row').toggleClass('d-none', !isChunk);
    $('#info-deploy .deploy-code-hash').html(formatHash(data.code_hash, 32));
    // A DEPLOY runs the contract's constructor, and that gas is recorded on the
    // contract_executions row rather than as a protocol fee, so a deployer's
    // cost is invisible in the Fee tab and has to render here instead. Rendered
    // before the chunk branch returns because a carrier that COMPLETED a group
    // is where the constructor actually ran, so its page is the only one that
    // carries that gas.
    let hasGas = !isNull(data.gas_used);
    $('#info-deploy .deploy-execution-row').toggleClass('d-none', !hasGas);
    if(hasGas){
        $('#info-deploy .deploy-method').text(isNull(data.method_name) ? '-' : data.method_name);
        $('#info-deploy .deploy-gas').text(numeral(data.gas_used).format('0,0') +
            (isNull(data.gas_limit) ? '' : ' / ' + numeral(data.gas_limit).format('0,0')));
    }
    if(isChunk){
        detailContractsXcall_renderDeployChunk(data, deployed);
        return;
    }
    // An assembler whose group is still incomplete has no contract to point at: link its own
    // index and the reader gets a dead /contract/ page, so the cell states the assembly status
    // instead. Once the group completes, the contract lives at the piece that completed it,
    // which is a DIFFERENT action index from this one.
    let assembly = isNull(data.assembly_status)
        ? (isNull(data.status) ? '' : String(data.status))
        : String(data.assembly_status);
    if(deployed === null && /^pending:/i.test(assembly)){
        $('#info-deploy .deploy-contract').text(assembly);
    } else {
        // Name WITH address, never instead of it (spec 2.6). The meta fields come off
        // this DEPLOY's own contracts row, so a pending assembler (whose contract lands
        // at another action) carries none and reads "Unnamed contract" until it does.
        let contractIdx = (deployed === null) ? data.action_index : deployed;
        $('#info-deploy .deploy-contract').html(formatContractIdentity(XC.coin, XC.chain, contractIdx, data.contract_meta_name, data.contract_meta_version));
    }
    $('#info-deploy .deploy-api-version').text(data.api_version);
    let stakeable = !isNull(data.cooldown_blocks);
    $('#info-deploy .deploy-stakeable').html(stakeable ? '<span class="badge text-bg-info text-white">Stakeable</span>' : 'No');
    $('#info-deploy .deploy-staking-row').toggleClass('d-none', !stakeable);
    if(stakeable){
        $('#info-deploy .deploy-cooldown').text(numeral(data.cooldown_blocks).format('0,0') + ' blocks');
        $('#info-deploy .deploy-slash').html(isNull(data.slash_destination) ? 'BURN' : formatLink('/' + XC.coin + '/address/' + data.slash_destination, data.slash_destination));
    }
}

// Render the fields carried by a chunked deployment action.
function detailContractsXcall_renderDeployChunk(data, deployed){
    let idx = isNull(data.chunk_index) ? '?' : (Number(data.chunk_index) + 1);
    let total = isNull(data.total_chunks) ? '?' : data.total_chunks;
    $('#info-deploy .deploy-chunk').text('Code chunk ' + idx + ' of ' + total);
    // The base64 code slice is the payload this carrier exists to publish, and it
    // was the one v4 wire field with nowhere to render. Shown truncated with its
    // full length: a part runs to a MEDIUMTEXT of code, and this row is a summary
    // of the chunk, not a code viewer (the assembled source lives on /contract/).
    let part = isNull(data.code_part) ? '' : String(data.code_part);
    $('#info-deploy .deploy-code-part').text(part.length > 96
        ? part.slice(0, 96) + '… (' + numeral(part.length).format('0,0') + ' chars)'
        : part);
    // The completing carrier's own deploy card, so the contract is reachable from the
    // action that created it rather than only from the assembler that asked for it.
    let carrierStakeable = (deployed !== null) && !isNull(data.cooldown_blocks);
    $('#info-deploy .deploy-staking-row').toggleClass('d-none', !carrierStakeable);
    if(deployed !== null){
        $('#info-deploy .deploy-contract').html(formatContractIdentity(XC.coin, XC.chain, deployed, data.contract_meta_name, data.contract_meta_version));
        $('#info-deploy .deploy-api-version').text(isNull(data.api_version) ? '-' : data.api_version);
        $('#info-deploy .deploy-stakeable').html(carrierStakeable ? '<span class="badge text-bg-info text-white">Stakeable</span>' : 'No');
        if(carrierStakeable){
            $('#info-deploy .deploy-cooldown').text(numeral(data.cooldown_blocks).format('0,0') + ' blocks');
            $('#info-deploy .deploy-slash').html(isNull(data.slash_destination) ? 'BURN' : formatLink('/' + XC.coin + '/address/' + data.slash_destination, data.slash_destination));
        }
    }
}

// Display EXECUTE action information (contract method call)
function showExecuteDetails(data){
    $('#info-execute .execute-contract').html(formatContractIdentity(XC.coin, XC.chain, data.contract_index, data.contract_meta_name, data.contract_meta_version));
    $('#info-execute .execute-caller').html(formatLink('/' + XC.coin + '/address/' + data.caller, data.caller));
    $('#info-execute .execute-method').text(data.method_name);
    $('#info-execute .execute-gas').text(numeral(data.gas_used).format('0,0') + ' / ' + numeral(data.gas_limit).format('0,0'));
    $('#info-execute .execute-emitted').text(data.emitted_count);
    // Emitted-children drill-down: list the actions this EXECUTE emitted (emit.execute /
    // emit.send / internal SLASH …) in emission order. Each child links by action_index;
    // internal emissions that move ledger state without minting an on-wire action (e.g. SLASH)
    // have a null action_index and render as "internal".
    let emissions = Array.isArray(data.emissions) ? data.emissions : [];
    if(emissions.length){
        let rows = '';
        emissions.forEach(function(e, idx){
            let child = isNull(e.action_index)
                ? '<span class="text-muted">internal</span>'
                : formatLink('/' + XC.coin + '/action/' + e.action_index, e.action_index);
            rows += '<tr><td class="text-center">' + (idx+1) + '</td><td>' + e.emitted_action + '</td><td>' + child + '</td></tr>';
        });
        let table = '<table class="table table-sm mb-0">'
            + '<thead><tr><th class="text-center">#</th><th>Action</th><th>Emitted</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table>';
        $('#info-execute .execute-emissions').html(table);
        $('#execute-emissions-row').removeClass('d-none');
    } else {
        $('#info-execute .execute-emissions').empty();
        $('#execute-emissions-row').addClass('d-none');
    }
    $('#info-execute .execute-error').text(isNull(data.error_message) ? '-' : data.error_message);
}

// Display DEPOSIT / WITHDRAW action information (contract custody)
function showDepositDetails(data){  showCustodyDetails('deposit', data);  }
function showWithdrawDetails(data){ showCustodyDetails('withdraw', data); }
function showCustodyDetails(kind, data){
    $('#info-' + kind + ' .' + kind + '-contract').html(formatContractIdentity(XC.coin, XC.chain, data.contract_index, data.contract_meta_name, data.contract_meta_version));
    $('#info-' + kind + ' .' + kind + '-tick').html(formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
    $('#info-' + kind + ' .' + kind + '-amount').html(formatAmount(data.amount));
}

// Display XCALL action information (cross-chain call request v0 / expire v2, VM-emitted,
// read-only). Surfaces the request plus, when present, the target-chain execution outcome
// and the source-chain callback delivery.
function showXcallDetails(data){
    let statusBadge = function(s){ let cls = (s=='completed') ? 'success' : (s=='expired') ? 'danger' : (s=='pending') ? 'warning text-dark' : 'secondary';
        return '<span class="badge text-bg-' + cls + '">' + (s || '-') + '</span>';
    };
    $('#info-xcall .xcall-call-id').html(formatHash(data.call_id, 32));
    // Version badge: v0 is the cross-chain call request, v1 the result-delivery marker
    // (its data living in cross_chain_call_callbacks, surfaced as callback_delivery
    // below), v2 the expire. All three need a branch; v1 has no request row of its own.
    let xcallV = Number(data.version);
    $('#info-xcall .xcall-version').html(
        xcallV === 2 ? '<span class="badge text-bg-secondary">Expire (v2)</span>' :
        xcallV === 1 ? '<span class="badge text-bg-info">Result delivery (v1)</span>' :
                       '<span class="badge text-bg-primary">Request (v0)</span>');
    $('#info-xcall .xcall-contract').html(isNull(data.contract_index) ? '-' : formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    $('#info-xcall .xcall-target-chain').text(isNull(data.target_chain) ? '-' : data.target_chain);
    $('#info-xcall .xcall-target-contract').text(isNull(data.target_contract_index) ? '-' : data.target_contract_index);
    $('#info-xcall .xcall-method').text(isNull(data.method) ? '-' : data.method);
    $('#info-xcall .xcall-params').text(Array.isArray(data.params) ? JSON.stringify(data.params) : (isNull(data.params) ? '-' : String(data.params)));
    $('#info-xcall .xcall-gas-limit').text(isNull(data.gas_limit) ? '-' : numeral(data.gas_limit).format('0,0'));
    $('#info-xcall .xcall-cross-hops').text(isNull(data.cross_hops) ? '-' : data.cross_hops);
    $('#info-xcall .xcall-callback-method').text(isNull(data.callback_method) ? '-' : data.callback_method);
    $('#info-xcall .xcall-deadline').html(isNull(data.deadline_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deadline_block, numeral(data.deadline_block).format('0,0')));
    $('#info-xcall .xcall-request-status').html(statusBadge(data.request_status));
    // The outcome as RECORDED ON THIS CHAIN (xcalls.result_status / result_payload /
    // resolved_block), not a duplicate of the execution block below: the indexer writes
    // these three when it flips the request terminal, and they are what the VM's
    // xchain.crossChain.getCallResult reads, so this is the value a contract sees.
    // Hidden as a group while the call is pending, none of the three being set then.
    let resolved = !isNull(data.result_status) || !isNull(data.resolved_block);
    $('#info-xcall .xcall-resolved-row').toggleClass('d-none', !resolved);
    if(resolved){
        // Plain text, like the execution's own Result Status: these values are
        // delivered result codes, not the request lifecycle the badge colours.
        $('#info-xcall .xcall-recorded-status').text(isNull(data.result_status) ? '-' : data.result_status);
        $('#info-xcall .xcall-recorded-payload').html(isNull(data.result_payload) ? '-' : formatHash(data.result_payload, 32));
        $('#info-xcall .xcall-resolved-block').html(isNull(data.resolved_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.resolved_block, numeral(data.resolved_block).format('0,0')));
    }
    // Target-chain execution outcome (present once the call has executed on the far chain).
    let exec = data.execution || null;
    $('#info-xcall .xcall-execution-row').toggleClass('d-none', !exec);
    if(exec){
        // Namespace the executed action by the TARGET chain: action indexes are chain-local and
        // this one was minted by XEXEC on the far chain, so XC.coin pointed the link at whatever
        // unrelated action shares that index here. The callback link below keeps
        // XC.coin because the callback is delivered back on this chain. Fall back to the page
        // coin only if target_chain is missing.
        let exec_coin = data.target_chain || XC.coin;
        $('#info-xcall .xcall-execute-action').html(isNull(exec.execute_action_index) ? '-' : formatLink('/' + networkCoin(exec_coin) + '/action/' + exec.execute_action_index, exec.execute_action_index));
        $('#info-xcall .xcall-result-status').text(isNull(exec.result_status) ? '-' : exec.result_status);
        $('#info-xcall .xcall-return-payload').html(isNull(exec.return_payload_b64) ? '-' : formatHash(exec.return_payload_b64, 32));
        $('#info-xcall .xcall-gas-used').text(isNull(exec.gas_used) ? '-' : numeral(exec.gas_used).format('0,0'));
    }
    // Source-chain callback delivery (present once the result has been delivered back).
    let cb = data.callback_delivery || null;
    $('#info-xcall .xcall-callback-row').toggleClass('d-none', !cb);
    if(cb){
        $('#info-xcall .xcall-callback-result').text(isNull(cb.callback_result_status) ? '-' : cb.callback_result_status);
        $('#info-xcall .xcall-callback-action').html(isNull(data.callback_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.callback_action_index, data.callback_action_index));
    }
}

// Display XEXEC action information (mirror-injected cross-chain call execution:
// the outcome of running a quorum-signed cross-chain dispatch on this chain).
function showXexecDetails(data){
    $('#info-xexec .xexec-call-id').html(isNull(data.call_id) ? '-' : formatHash(data.call_id, 32));
    $('#info-xexec .xexec-execute-action').html(isNull(data.execute_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.execute_action_index, data.execute_action_index));
    $('#info-xexec .xexec-result-status').text(isNull(data.result_status) ? '-' : data.result_status);
    $('#info-xexec .xexec-gas-used').text(isNull(data.gas_used) ? '-' : numeral(data.gas_used).format('0,0'));
    $('#info-xexec .xexec-return-payload').html(isNull(data.return_payload_b64) ? '-' : formatHash(data.return_payload_b64, 32));
    $('#info-xexec .xexec-block').html(isNull(data.block_index) ? '-' : formatLink('/' + XC.coin + '/block/' + data.block_index, numeral(data.block_index).format('0,0')));
}

// Display CROSS_SETTLE action information (mirror-injected cross-chain DEX
// settlement leg: the release of a local ORDER/SWAP against a signed match).
function showCrossSettleDetails(data){
    $('#info-cross-settle .cross-settle-match-id').html(isNull(data.match_id) ? '-' : formatHash(data.match_id, 32));
    $('#info-cross-settle .cross-settle-local-action').html(isNull(data.local_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.local_action_index, data.local_action_index));
    $('#info-cross-settle .cross-settle-a-chain').text(isNull(data.a_chain) ? '-' : data.a_chain);
    $('#info-cross-settle .cross-settle-a-action').text(isNull(data.a_action_index) ? '-' : data.a_action_index);
    $('#info-cross-settle .cross-settle-b-chain').text(isNull(data.b_chain) ? '-' : data.b_chain);
    $('#info-cross-settle .cross-settle-b-action').text(isNull(data.b_action_index) ? '-' : data.b_action_index);
    $('#info-cross-settle .cross-settle-block').html(isNull(data.block_index) ? '-' : formatLink('/' + XC.coin + '/block/' + data.block_index, numeral(data.block_index).format('0,0')));
}
