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
 * detail_anchor_price.js
 *
 * Custom javascript for xchain explorer
 */

// Display ANCHOR action information (DOGE checkpoint: v0 checkpoint, v1 +archive, v2 continuation chunk)
function showAnchorDetails(data){
    $('#info-anchor .anchor-version').text(isNull(data.version) ? '-' : ('v' + data.version));
    // A v0 ANCHOR is a BUNDLE: one action carrying every checkpointed chain, stored as
    // N sibling anchor_actions rows. The per-chain fields below belong to section 0
    // alone, so say how many chains the action commits and where the full per-chain
    // view is; presenting one section's chain, checkpoint_seq and hashes as the whole
    // anchor elides every other chain with nothing on the page to show it happened.
    // The section table itself lives on the anchor page (anchor_detail_render.js),
    // which is the single renderer for it.
    let sections = Array.isArray(data.sections) ? data.sections : [];
    if(sections.length > 1){
        let chains = sections.map(s => escapeHtml(isNull(s.chain) ? '-' : String(s.chain))).join(', ');
        $('#info-anchor .anchor-sections').html(
            sections.length + ' chains (' + chains + '); the fields below are section 0 - '
            + formatLink('/' + XC.coin + '/anchor/' + data.action_index, 'full per-chain view'));
    } else {
        $('#info-anchor .anchor-sections').text(sections.length === 1 ? '1 chain' : '-');
    }
    $('#info-anchor .anchor-chain').text(isNull(data.chain) ? '-' : data.chain);
    $('#info-anchor .anchor-network').text(isNull(data.network) ? '-' : data.network);
    $('#info-anchor .anchor-checkpoint-seq').text(isNull(data.checkpoint_seq) ? '-' : numeral(data.checkpoint_seq).format('0,0'));
    // SNAPSHOT_BLOCK is a BITCOIN height carried on the wire (xchain-indexer
    // actions/anchor/index.js: the oracle_publish capability snapshot it names is BTC-keyed),
    // while ANCHOR is only valid on DOGE. Linking it into the page coin therefore
    // resolved a DOGE block of the same number, an unrelated block. Route it through
    // the shared BTC-height renderer, which links the tier-matched BTC chain when this
    // instance serves it and otherwise prints the bare height.
    $('#info-anchor .anchor-snapshot-block').html(formatPriceAnchorHeight(data.snapshot_block));
    $('#info-anchor .anchor-block-hash').html(isNull(data.block_hash) ? '-' : formatHash(data.block_hash, 32));
    $('#info-anchor .anchor-ledger-hash').html(isNull(data.ledger_hash) ? '-' : formatHash(data.ledger_hash, 32));
    $('#info-anchor .anchor-actions-hash').html(isNull(data.actions_hash) ? '-' : formatHash(data.actions_hash, 32));
    $('#info-anchor .anchor-contract-hash').html(isNull(data.contract_hash) ? '-' : formatHash(data.contract_hash, 32));
    $('#info-anchor .anchor-match-batch').text(isNull(data.match_batch_seq) ? '-' : numeral(data.match_batch_seq).format('0,0'));
    $('#info-anchor .anchor-match-count').text(isNull(data.match_count) ? '-' : numeral(data.match_count).format('0,0'));
    $('#info-anchor .anchor-chunk').text(isNull(data.chunk_index) ? '-' : (data.chunk_index + ' of ' + data.total_chunks));
    $('#info-anchor .anchor-doge-block').text(isNull(data.block_index_doge) ? '-' : numeral(data.block_index_doge).format('0,0'));
    // SPV commitment roots (NULL pre-CHECKPOINT_COMMITMENT flag-day; populated for v3).
    let hasRoots = !isNull(data.state_root) || !isNull(data.block_merkle_root);
    $('#info-anchor .anchor-roots-row').toggleClass('d-none', !hasRoots);
    if(hasRoots){
        $('#info-anchor .anchor-state-root').html(isNull(data.state_root) ? '-' : formatHash(data.state_root, 32));
        $('#info-anchor .anchor-block-merkle-root').html(isNull(data.block_merkle_root) ? '-' : formatHash(data.block_merkle_root, 32));
    }
    // Publisher-attestation tail (v4/v5/v6 reward-derivation anchors; both NULL for
    // v0-v3, so the row stays hidden). publisher is the elected pubkey credited the
    // reward; publisher_attestations is the RAW XANCPUB quorum ([{pubkey,sig}]) carried
    // on the wire - shown for provenance, consumers re-verify against their own set.
    let pubSigs = Array.isArray(data.publisher_attestations) ? data.publisher_attestations : [];
    let hasPublisher = !isNull(data.publisher) || pubSigs.length > 0;
    $('#info-anchor .anchor-publisher-row').toggleClass('d-none', !hasPublisher);
    if(hasPublisher){
        $('#info-anchor .anchor-publisher').html(isNull(data.publisher) ? '-' : formatHash(data.publisher, 32));
        $('#info-anchor .anchor-publisher-attestation-count').text(pubSigs.length);
        $('#info-anchor .anchor-publisher-attestations').html(pubSigs.length ? pubSigs.map(s => formatHash(s.pubkey, 24)).join('<br>') : '-');
    }
}

// Display PRICE action information (v0 validator COIN/FIAT snapshot, v0 validator
// BATCH of rounds, v1 user TOKEN/FIAT oracle).
//
// A batch is the shape a validator actually publishes: one signed action carrying an
// hourly window of rounds, each round a full COIN/FIAT price set. Its single-round
// columns (pair_count / pairs / sig_count) are NULL by construction, so everything
// below that is keyed on them falls back to the batch's own fields rather than
// rendering a dash over data the action plainly carries.
function showPriceDetails(data){
    let rounds = Array.isArray(data.rounds) ? data.rounds : [];
    let sigs   = Array.isArray(data.signatures) ? data.signatures : [];
    $('#info-price .price-version').html(Number(data.version)===0 ? '<span class="badge text-bg-secondary">Validator (v0)</span>' : '<span class="badge text-bg-primary">User (v1)</span>');
    $('#info-price .price-coin').text(isNull(data.coin) ? '-' : data.coin);
    // A PRICE v1 declares the CHAIN of the token it prices (V1_COIN, any supported
    // coin) independently of the chain it was published on, and it is mirrored
    // cross-chain, so a DOGE-published price can name an LTC token. Namespacing the
    // link by the page coin opened a different chain's token page - or nothing at all.
    // Link the declared coin instead, keeping the page's network tier.
    $('#info-price .price-ticker').html(isNull(data.tick) ? '-' : formatLink(tokenUrl(siblingCoin(data.coin), data.tick), data.tick, data.tick));
    $('#info-price .price-fiat').text(isNull(data.fiat) ? '-' : data.fiat);
    $('#info-price .price-value').text(isNull(data.value) ? '-' : data.value);
    // PRICE v1 carries the oracle's usage FEE as a decimal fraction (0.01 being 1%)
    // plus an optional MEMO, both selected by the detail query. The raw decimal leads
    // because it is the wire value a DISPENSER's required oracle-fee output is computed
    // from; the percent rides along for readability. v0 snapshots carry neither.
    $('#info-price .price-oracle-fee').text(isNull(data.oracle_fee) ? '-'
        : data.oracle_fee + ' (' + numeral(Number(data.oracle_fee) * 100).format('0,0.[000000]') + '%)');
    $('#info-price .price-round').text(isNull(data.round_number) ? '-' : numeral(data.round_number).format('0,0'));
    // Round window: the batch's declared FIRST_ROUND..LAST_ROUND and how many rounds
    // it actually carries. Row stays hidden on a single-round v0 row and a v1 oracle,
    // where both bounds are NULL.
    let hasWindow = !isNull(data.batch_first_round) && !isNull(data.batch_last_round);
    $('#info-price .price-window-row').toggleClass('d-none', !hasWindow);
    if(hasWindow){
        let count = isNull(data.round_count) ? rounds.length : Number(data.round_count);
        $('#info-price .price-window').text(
            numeral(data.batch_first_round).format('0,0') + ' - ' + numeral(data.batch_last_round).format('0,0') +
            ' (' + numeral(count).format('0,0') + ' round' + (count===1 ? '' : 's') + ')');
    }
    $('#info-price .price-round-timestamp').text(isNull(data.round_timestamp) ? '-' : data.round_timestamp);
    // Pair count: a batch stores none (its rounds each carry their own set), so count
    // the pairs of its first round rather than showing a dash. Every round in a batch
    // is one publisher's full snapshot, so the first round's width describes the batch.
    let pairText = '-';
    if(!isNull(data.pairs))
        pairText = String(data.pairs.length);
    else if(!isNull(data.pair_count))
        pairText = String(data.pair_count);
    else if(rounds.length && Array.isArray(rounds[0].pairs))
        pairText = rounds[0].pairs.length + ' per round';
    $('#info-price .price-pairs').text(pairText);
    // sig_count is NULL on a batch row, but sigs_json holds the signature set that
    // covers the whole window, so fall back to its length rather than to a dash.
    let sigCount = isNull(data.sig_count) ? (sigs.length || null) : Number(data.sig_count);
    $('#info-price .price-sig-count').text(isNull(sigCount) ? '-' : numeral(sigCount).format('0,0'));
    $('#info-price .price-signers-row').toggleClass('d-none', sigs.length === 0);
    if(sigs.length)
        $('#info-price .price-signers').html(sigs.map((s) => formatHash(s.pubkey, 24)).join('<br>'));
    $('#info-price .price-validation-status').text(isNull(data.validation_status) ? '-' : data.validation_status);
    $('#info-price .price-memo').text(isNull(data.memo) ? '-' : data.memo);
    showPriceRounds(rounds);
}

// Render a PRICE batch's decoded round bodies: one table per round, listing every
// COIN/FIAT pair and its price exactly as the signers signed it.
//
// Pair names and prices are on-chain, publisher-supplied values reaching .html(), so
// both are escaped. They are already validated on the way in (the indexer refuses a
// pair that fails the network's pair pattern and a price that is not decimal digits),
// but this renderer also runs against a v1 oracle row and any future carrier, so it
// does not lean on that.
function showPriceRounds(rounds){
    let block = $('#info-price .price-rounds-block');
    block.toggleClass('d-none', rounds.length === 0);
    if(rounds.length === 0){
        $('#info-price .price-rounds').empty();
        $('#info-price .price-rounds-summary').text('');
        return;
    }
    let pairTotal = rounds.reduce((n, r) => n + (Array.isArray(r.pairs) ? r.pairs.length : 0), 0);
    $('#info-price .price-rounds-summary').text(
        '(' + numeral(rounds.length).format('0,0') + ' round' + (rounds.length===1 ? '' : 's') +
        ', ' + numeral(pairTotal).format('0,0') + ' price' + (pairTotal===1 ? '' : 's') + ')');
    let html = '';
    for(let r of rounds){
        let pairs = Array.isArray(r.pairs) ? r.pairs : [];
        html += '<table class="table table-sm table-striped table-hover table-bordered mb-3" width="100%">';
        html += '<thead><tr class="info">';
        html += '<th width="155">Round ' + numeral(r.round).format('0,0') + '</th>';
        html += '<th>' + (isNull(r.timestamp) ? '-' : formatLivestamp(r.timestamp)) + '</th>';
        // The BTC block the round is anchored to. Capability staking is BTC-only, so
        // this height is on Bitcoin whatever chain the action landed on: never link it
        // into the page coin's namespace, which would name a block that does not exist.
        html += '<th>BTC block ' + formatPriceAnchorHeight(r.btc_block_height) + '</th>';
        html += '</tr></thead><tbody>';
        for(let p of pairs){
            let parts = String(p.pair).split('/');
            html += '<tr>';
            html += '<td>' + escapeHtml(nullToBlank(parts[0])) + '</td>';
            html += '<td>' + escapeHtml(nullToBlank(parts[1])) + '</td>';
            html += '<td>' + escapeHtml(String(p.price)) + '</td>';
            html += '</tr>';
        }
        if(pairs.length === 0)
            html += '<tr><td colspan="3">-</td></tr>';
        html += '</tbody></table>';
    }
    $('#info-price .price-rounds').html(html);
}

// Render a BTC-keyed height, linked into the BTC explorer for THIS network when this
// instance serves it. Used by a PRICE round's anchor height and by an ANCHOR action's
// SNAPSHOT_BLOCK: both name a Bitcoin height because capability staking is BTC-only,
// so the height belongs to BTC/TBTC/RBTC and never to the page coin (an ANCHOR only
// lands on DOGE, so the page coin is never right there).
// An instance that does not serve the matching BTC network
// (XC.status.available is the same map the header logo and the network-unavailable
// notice read) gets the height as plain text rather than a link to a page it has not
// got - a DOGE-only deployment is a supported configuration, not an error.
function formatPriceAnchorHeight(height){
    if(isNull(height)) return '-';
    let text   = numeral(height).format('0,0');
    // mainnet's prefix is '' by design, so an absent map and a mainnet page both
    // resolve to plain 'BTC' - which is right in the first case and correct in the second.
    let prefix = (XC.networks && XC.networks[XC.network]) ? XC.networks[XC.network] : '';
    let coin   = prefix + 'BTC';
    let served = !!(XC.status && XC.status.available && XC.status.available[coin]);
    return served ? formatLink('/' + coin + '/block/' + height, text) : text;
}

// Display NODEPROOF action information (full-node possession-proof verdict + per-validator PASS list)
function showNodeproofDetails(data){
    $('#info-nodeproof .nodeproof-challenge').html(isNull(data.challenge_id) ? '-' : formatHash(data.challenge_id, 32));
    $('#info-nodeproof .nodeproof-epoch-height').html(isNull(data.epoch_height) ? '-' : formatLink('/' + XC.coin + '/block/' + data.epoch_height, numeral(data.epoch_height).format('0,0')));
    $('#info-nodeproof .nodeproof-target-height').html(isNull(data.target_height) ? '-' : formatLink('/' + XC.coin + '/block/' + data.target_height, numeral(data.target_height).format('0,0')));
    let verifs = Array.isArray(data.verifications) ? data.verifications : [];
    $('#info-nodeproof .nodeproof-verified-count').text(verifs.length);
    let rows = '';
    for(let v of verifs){
        let badge = '<span class="badge text-bg-' + (v.passed==1 ? 'success' : 'danger') + '">' + (v.passed==1 ? 'Pass' : 'Fail') + '</span>';
        let src   = isNull(v.staking_source) ? '-' : formatLink('/' + XC.coin + '/address/' + v.staking_source, v.staking_source);
        rows += '<tr><td>' + formatHash(v.signing_pubkey, 32) + '</td><td>' + src + '</td><td>' + badge + '</td></tr>';
    }
    $('#info-nodeproof .nodeproof-verifications tbody').html(rows || '<tr><td colspan="3">-</td></tr>');
}

// Display ROLLCALL action information (liveness roll call + the validators present at the epoch)
//
// EPOCH_HEIGHT IS A BITCOIN HEIGHT, and a ROLLCALL only ever lands on Dogecoin, so this
// page is always on a DOGE route while that number refers to another chain. It is rendered
// as plain text, deliberately NOT linked to /{COIN}/block/, because linking it would resolve
// to an unrelated Dogecoin block of the same number and read as real. The label carries the
// chain so the reader is not left to infer it.
function showRollcallDetails(data){
    let isV1 = Number(data.action_format) === 1;
    $('#info-rollcall .rollcall-version').html(isV1
        ? '<span class="badge text-bg-primary">ROLLCALL v1</span>'
        : '<span class="badge text-bg-secondary">ROLLCALL v0</span>');
    $('#info-rollcall .rollcall-epoch-height').html(isNull(data.epoch_height) ? '-' : numeral(data.epoch_height).format('0,0'));
    $('#info-rollcall .rollcall-ledger-hash').html(isNull(data.ledger_hash) ? '-' : formatHash(data.ledger_hash, 32));
    $('#info-rollcall .rollcall-publisher').html(isNull(data.publisher) ? '-' : formatHash(data.publisher, 32));
    let gates = isV1 && Array.isArray(data.gates) ? data.gates : [];
    $('#info-rollcall .rollcall-gates').html(gates.length
        ? gates.map(g => '<span class="badge text-bg-info me-1">' + escapeHtml(String(g)) + '</span>').join('')
        : '-');
    // The signer list IS the present list: presence at an epoch is recorded by having
    // signed the canonical, so there is no separate attendance flag to render.
    let signers = Array.isArray(data.signers) ? data.signers : [];
    $('#info-rollcall .rollcall-signer-count').text(signers.length);
    let rows = '';
    for(let s of signers)
        rows += '<tr><td>' + formatHash(s.pubkey, 32) + '</td><td>' + formatHash(s.sig, 32) + '</td></tr>';
    $('#info-rollcall .rollcall-signers tbody').html(rows || '<tr><td colspan="2">-</td></tr>');
}

// Display FEE details
function showActionFeeDetails(data){
    if(data){
        let method = (data.method) ? (' - ' + XC.fee_preferences[data.method]) : '';
        let tick   = (data.tick!='') ? data.tick : false;
        $('#info-fee .fee-tick').html(formatLink(tokenUrl(XC.coin, tick), tick, tick));
        $('#info-fee .fee-amount').html(formatAmount(data.amount));
        $('#info-fee .fee-method').html(data.method + method);
        $('#info-fee .fee-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    }
}

// Display action datatables
function showActionDatatable(type, data, dataType=null, autoWidth=true, ){
    var id   = 'datatable-' + type,
        body = $('#' + id + ' tbody'),
        html = '';
    if(data && data.length>=1){
        // Loop through data and add to the datatables before initialization
        data.forEach(function(info, idx){
            var cls = (info.status=='valid') ? 'bg-green' : 'bg-red';
            if(['actions','batch'].includes(type)){
                // The transaction actions table nests its summary under `.details`
                // (getActionSummaryData) and a BATCH member carries the same projection
                // under `.summary` (misc.js BATCH.afterQuery2), both built by
                // db.projectActionSummary. A BET feed member keeps the raw
                // attacker-supplied base64 DETAILS string on the `.details` key, so a
                // truthiness test handed getActionDetails a string instead of the action
                // info. Require an object on either key, else fall back to the flat row.
                let details = (info.summary && typeof info.summary === 'object') ? info.summary
                            : (info.details && typeof info.details === 'object') ? info.details
                            : info;
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.action_index, formatAmount(info.action_index)) + '</td>';
                html += '    <td>' + info.action + '</td>';
                html += '    <td>' + getActionDetails(info.action, details) + '</td>';
                html += '    <td>' + info.status + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.action_index, 'view', null, true) + '</td>';
                html += '</tr>';
            } else {
                html += detailAnchorPrice_actionRow(type, info, idx, dataType, cls);
            }
        });
        body.html(html);
    } else {
        // An empty result MUST clear the tbody before DataTables initializes. The
        // markup ships a single placeholder row ("Loading data...") whose colspan
        // stands in for the whole header, and DataTables does not expand colspan
        // when it adopts existing rows: it expects one <td> per <th>, finds one,
        // and dereferences the missing cells as undefined._DT_CellIndex. Leaving
        // the row in place therefore throws instead of rendering, which is exactly
        // the path a user hits right after broadcasting, before the tx confirms.
        // Emptying it lets DataTables draw its own zeroRecords state.
        body.empty();
    }
    initStaticDatatable(id, autoWidth);
}

// Select the markup shape for an action detail table entry.
function detailAnchorPrice_actionRow(type, info, idx, dataType, cls){
    var html = '';
    if(type=='list-items'){
        html += '<tr>'
        html += '    <td>' + (idx+1) + '</td>';
        if(dataType=='Address')
            html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info, info) + '</td>';
        if(dataType=='Token')
            html += '    <td>' + formatLink(tokenUrl(XC.coin, info), info) + '</td>';
        html += '</tr>';
    } else if(type=='list-edits'){
        html += '<tr class="' + cls + '">'
        html += '    <td>' + (idx+1) + '</td>';
        if(dataType=='Address')
            html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.address, info.address) + '</td>';
        if(dataType=='Token')
            html += '    <td>' + formatLink(tokenUrl(XC.coin, info.tick), info.tick, info.tick) + '</td>';
        html += '    <td>' + info.status + '</td>';
        html += '</tr>';
    } else if(['send','airdrop','destroy'].includes(type)){
        return detailAnchorPrice_transferRow(type, info, idx, cls);
    } else {
        html += '<tr>'
        html += '    <td>' + (idx+1) + '</td>';
        html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.address, info.address) + '</td>';
        html += '    <td>' + formatLink(tokenUrl(XC.coin, info.tick), info.tick, info.tick) + '</td>';
        html += '    <td>' + formatAmount(info.amount) + '</td>';
        html += '</tr>';
    }
    return html;
}

// Build token movement markup for the action-specific columns.
function detailAnchorPrice_transferRow(type, info, idx, cls){
    let html = '<tr class="' + cls + '">'
    html += '    <td>' + (idx+1) + '</td>';
    if(type=='send'){
        html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.destination, info.destination) + '</td>';
        html += '    <td>' + formatLink(tokenUrl(XC.coin, info.tick), info.tick, info.tick) + '</td>';
        html += '    <td>' + formatAmount(info.amount) + '</td>';
        // SEND v3 carries a MEMO per leg, so it belongs beside the leg it
        // describes rather than only inside the raw transaction data.
        // Escaped and null-guarded exactly as the destroy legs are.
        html += '    <td>' + escapeHtml(isNull(info.memo) ? '' : info.memo) + '</td>';
        html += '    <td>' + (isNull(info.status) ? '' : info.status) + '</td>';
    } else if(type=='airdrop'){
        // The list is an ACTION index (airdrops.list_action_index names the LIST
        // action that defined the recipients), not a token.
        html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.list_action_index, formatAmount(info.list_action_index)) + '</td>';
        html += '    <td>' + formatLink(tokenUrl(XC.coin, info.tick), info.tick, info.tick) + '</td>';
        html += '    <td>' + formatAmount(info.amount) + '</td>';
        html += '    <td>' + escapeHtml(isNull(info.memo) ? '' : info.memo) + '</td>';
        html += '    <td>' + (isNull(info.status) ? '' : info.status) + '</td>';
    } else {
        html += '    <td>' + formatLink(tokenUrl(XC.coin, info.tick), info.tick, info.tick) + '</td>';
        html += '    <td>' + formatAmount(info.amount) + '</td>';
        html += '    <td>' + escapeHtml(isNull(info.memo) ? '' : info.memo) + '</td>';
        html += '    <td>' + (isNull(info.status) ? '' : info.status) + '</td>';
    }
    html += '</tr>';
    return html;
}

// Display lock status text and icon
function showLockStatus(locked){
    var icon = (locked) ? 'fa-lock' : 'fa-lock-open',
        text = (locked) ? 'Locked' : 'Unlocked',
        html = '<i class="fa pe-1 ' + icon + '"></i>' + text;
    return html;
}
