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
 **********************************************************************/

// ANCHOR_ACTIVATION: the DOGE height (per network) at/above which the ANCHOR wire
// set restarts at version 0. Vendored byte-identical from src/protocol/constants.js
// (this service's own canonical copy): server code reaches that file with
// require(), but content/js ships as plain static scripts with no bundler, so this
// browser-served copy is kept in sync the same way every other cross-file copy of
// this constant is - test/unit/content-client-anchor-detail.test.js pins it against
// the real module.
var ANCHOR_ACTIVATION = { mainnet: 6360000, testnet: 67858600, regtest: 0 };

function renderAnchorHeights(d){
    let row   = d || {};
    let t     = anchorTraits(row);
    let chain = isNull(row.chain) ? 'the checkpointed chain' : String(row.chain);
    let html  = '<table class="table table-sm table-borderless mb-0"><tbody>';
    if(t.bundle)
        html += anchorBundleHeightRow(row);
    else
        html += anchorHeightRow('anchor-height-checkpointed', 'Checkpointed Block', row.block_index, 'checkpointed',
            'The height on ' + chain + ' that this anchor commits to. Checkpoint and commitment lookups key off THIS height.');
    html += anchorHeightRow('anchor-height-broadcast', 'Anchor Transaction Block', row.block_index_doge, 'broadcast',
        'The DOGE block the ANCHOR transaction itself was mined in. It sits at or ahead of the checkpointed height, and looking a commitment up by this number correctly finds nothing.');
    html += '</tbody></table>';
    return html;
}

/* ------------------------------------------------------------------ *
 * Identity and payload
 * ------------------------------------------------------------------ */
function renderAnchorIdentity(d){
    let row = d || {};
    let t   = anchorTraits(row);
    let html = '';
    html += anchorFieldRow('Action', isNull(row.action_index)
        ? '-'
        : formatLink('/' + anchorCoin() + '/action/' + row.action_index, anchorNum(row.action_index)));
    html += anchorFieldRow('Version', '<span class="badge text-bg-primary anchor-version-badge">v'
        + anchorEsc(isNull(row.version) ? '?' : row.version) + '</span> <span class="anchor-kind">'
        + anchorEsc(t.label) + '</span>'
        + (t.known ? '' : anchorNote(t.legacy
            ? ('This ANCHOR was mined before the activation height for its network, so its version byte predates the current v0/v1/v2 wire set and is not read against today\'s traits table. Stored status: '
                + (isNull(t.reason) ? 'unknown' : t.reason) + '.')
            : 'This build does not recognize this ANCHOR version, so the payload legs below were read from the row itself rather than from the version.')));
    html += anchorFieldRow('Status', anchorStatusBadge(row.status));
    // A bundle's verdict is all-or-nothing across its sections, so the single
    // status above is the whole action's. Its CHAIN, though, is every chain it
    // carries: naming one would misidentify the anchor.
    if(t.bundle){
        let chains = [];
        anchorSectionRows(row).forEach(function(s){
            if(!isNull(s.chain)) chains.push(String(s.chain));
        });
        html += anchorFieldRow('Chains', '<span class="anchor-bundle-chains">'
            + anchorEsc(chains.length ? chains.join(', ') : '-') + '</span>'
            + ' <span class="badge text-bg-secondary">' + anchorEsc(isNull(row.network) ? '-' : row.network) + '</span>'
            + anchorNote('One ANCHOR per network per cycle: every chain checkpointed in this cycle rides one transaction as its own section.'),
            'anchor-bundle-chains-row');
    } else {
        html += anchorFieldRow('Chain', anchorEsc(isNull(row.chain) ? '-' : row.chain)
            + ' <span class="badge text-bg-secondary">' + anchorEsc(isNull(row.network) ? '-' : row.network) + '</span>');
    }
    html += anchorFieldRow('Transaction', isNull(row.tx_hash) ? '-'
        : formatLinkHtml('/' + anchorCoin() + '/transaction/' + row.tx_hash,
            '<span class="font-monospace small text-break">' + anchorEsc(row.tx_hash) + '</span>'));
    html += anchorFieldRow('Time', isNull(row.timestamp) ? '-' : formatLivestamp(row.timestamp));
    return html;
}

// The checkpoint the anchor CARRIES on the wire. Distinct from the covering
// state_checkpoints row rendered separately: this one is what was published on
// DOGE, that one is what the hub mirror holds.
function renderAnchorCheckpointPayload(d){
    let row = d || {};
    let t   = anchorTraits(row);
    if(!t.checkpoint)
        return anchorEmpty('This anchor carries no checkpoint payload. A continuation chunk only extends an archive batch published by an earlier anchor.');
    // A bundle's checkpoint payload is per section, so this card carries only what
    // the BUNDLE owns. Rendering section 0's hashes here would read as the anchor's
    // one checkpoint and quietly hide the other chains.
    if(t.bundle) return renderAnchorBundleHeader(row);
    let sigs = Array.isArray(row.validator_signatures) ? row.validator_signatures : [];
    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += anchorFieldRow('Checkpoint Seq',  isNull(row.checkpoint_seq) ? '-' : anchorEsc(row.checkpoint_seq));
    html += anchorFieldRow('Snapshot Block',  anchorBlockLink(row.snapshot_block), 'anchor-snapshot-block');
    html += anchorFieldRow('Block Hash',      anchorHash(row.block_hash));
    html += anchorFieldRow('Ledger Hash',     anchorHash(row.ledger_hash));
    html += anchorFieldRow('Actions Hash',    anchorHash(row.actions_hash));
    html += anchorFieldRow('Contract Hash',   anchorHash(row.contract_hash));
    if(t.roots || !isNull(row.state_root) || !isNull(row.block_merkle_root)){
        html += anchorFieldRow('State Root',        anchorRootCell(row.state_root, row.state_root_version), 'anchor-state-root-row');
        html += anchorFieldRow('Block Merkle Root', anchorRootCell(row.block_merkle_root, row.block_merkle_version), 'anchor-block-merkle-row');
    }
    html += anchorFieldRow('Validator Signatures',
        '<span class="anchor-sig-count">' + sigs.length + '</span> attached'
        + anchorNote('Attached is not the same as verified. The covering checkpoint page re-checks every signature against the validator set that qualified at the snapshot block.'),
        'anchor-sig-row');
    html += '</tbody></table>';
    return html;
}

// What the BUNDLE itself owns, as opposed to what each section owns: the network
// every section was checkpointed on, the election/attestation block, and how many
// chains rode this transaction. snapshot_block here is the MAX over the sections
// (getAnchor computes it), which is the block the publisher was elected at; a
// lagging chain's section can name an older one of its own.
function renderAnchorBundleHeader(d){
    let row      = d || {};
    let sections = anchorSectionRows(row);
    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += anchorFieldRow('Network', anchorEsc(isNull(row.network) ? '-' : row.network));
    html += anchorFieldRow('Sections', '<span class="anchor-section-count">' + sections.length + '</span> chain'
        + (sections.length === 1 ? '' : 's')
        + anchorNote('A one-section bundle is normal, not a fault: a chain whose newest checkpoint is already anchored simply does not ride this cycle.'),
        'anchor-section-count-row');
    html += anchorFieldRow('Snapshot Block', anchorBlockLink(row.snapshot_block)
        + anchorNote('The bundle\'s election and attestation block, the highest of its sections\' snapshot blocks.'),
        'anchor-snapshot-block');
    html += '</tbody></table>';
    return html;
}

// The per-chain table: one row per section, in section_index order, each with the
// height, sequence and roots that section alone commits to. This is the whole
// payload of a bundle, so an empty one is a broken read rather than an absence.
function renderAnchorSections(d){
    let row      = d || {};
    let t        = anchorTraits(row);
    let sections = anchorSectionRows(row);
    if(!t.bundle)
        return anchorEmpty('This anchor carries a single checkpoint rather than a bundle of per-chain sections.');
    if(!sections.length)
        return anchorEmpty('This bundle reports no sections. A v7 anchor always carries at least one, so this is an incomplete read rather than an empty cycle.');

    let html = '<div class="small text-muted mb-1">' + sections.length + ' chain'
        + (sections.length === 1 ? '' : 's') + ' committed by this anchor:</div>';
    html += '<table class="table table-sm mb-0 anchor-sections-table"><thead><tr>'
        + '<th>#</th><th>Chain</th><th>Checkpointed Block</th><th>Checkpoint Seq</th><th>Snapshot Block</th>'
        + '<th>State Root</th><th>Block Merkle Root</th><th>Signatures</th>'
        + '</tr></thead><tbody>';
    html += anchorSectionRowsHtml(sections, row);
    html += '</tbody></table>';
    // Each section carries its OWN quorum over its own per-chain canonical, so the
    // counts above are per chain and are attached signatures, not verified ones.
    html += anchorNote('Each section carries its own quorum signatures over its own chain\'s checkpoint canonical. Attached is not verified: the covering checkpoint page re-checks them.');
    return html;
}


// The cross-chain match archive. archive_b64 itself is never fetched: it is a
// gzip chunk with nothing legible in it, so its LENGTH and the batch CRC32 are
// what a reader can actually check an archive against.
function renderAnchorArchivePayload(d){
    let row = d || {};
    let t   = anchorTraits(row);
    if(!t.archive)
        return anchorEmpty('This anchor carries no match archive.');
    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += anchorFieldRow('Batch Seq',    isNull(row.match_batch_seq) ? '-' : anchorEsc(row.match_batch_seq), 'anchor-batch-seq');
    html += anchorFieldRow('Match Count',  isNull(row.match_count) ? '-' : anchorNum(row.match_count));
    html += anchorFieldRow('Batch CRC32',  isNull(row.batch_crc32) ? '-' : '<span class="font-monospace small">' + anchorEsc(row.batch_crc32) + '</span>');
    html += anchorFieldRow('Chunk',        anchorChunkLabel(row));
    html += anchorFieldRow('Archive Size',
        isNull(row.archive_b64_length) ? '-' : (anchorNum(row.archive_b64_length) + ' base64 characters')
            + anchorNote('The compressed archive body itself is not served here; check a copy against the batch CRC32 above.'),
        'anchor-archive-size');
    html += '</tbody></table>';
    html += renderAnchorChunks(row);
    return html;
}


// Every anchor sharing this archive batch id, chunk 0 first. The batch is only
// complete once each chunk has landed, so the list is the reader's way of seeing
// a half-published archive.
function renderAnchorChunks(d){
    let row  = d || {};
    let rows = Array.isArray(row.chunks) ? row.chunks : [];
    if(!rows.length)
        return anchorEmpty('No sibling chunks are recorded for this batch.');
    let html = '<div class="small text-muted mt-2 mb-1">' + rows.length + ' chunk'
        + (rows.length === 1 ? '' : 's') + ' recorded for this batch:</div>';
    html += '<table class="table table-sm mb-0 anchor-chunks-table"><thead><tr>'
        + '<th>Chunk</th><th>Action</th><th>Version</th><th>Anchor Tx Block</th><th>Size</th><th>Status</th>'
        + '</tr></thead><tbody>';
    rows.forEach(function(c){
        let self = (!isNull(c.action_index) && !isNull(row.action_index)
                    && String(c.action_index) === String(row.action_index));
        html += '<tr class="anchor-chunk-row' + (self ? ' anchor-chunk-self table-active' : '') + '">'
            + '<td>' + anchorChunkLabel(c) + '</td>'
            + '<td>' + (isNull(c.action_index) ? '-' : formatLink('/' + anchorCoin() + '/anchor/' + c.action_index, anchorNum(c.action_index))) + '</td>'
            + '<td>v' + anchorEsc(isNull(c.version) ? '?' : c.version) + '</td>'
            + '<td>' + anchorBlockLink(c.block_index_doge) + '</td>'
            + '<td>' + (isNull(c.archive_b64_length) ? '-' : anchorNum(c.archive_b64_length)) + '</td>'
            + '<td>' + anchorStatusBadge(c.status) + '</td>'
            + '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

/* ------------------------------------------------------------------ *
 * Covering checkpoint (hub mirror)
 * ------------------------------------------------------------------ */

// The state_checkpoints row covering the CHECKPOINTED height. Absence here is a
// normal state on a chain whose mirror has not caught up, not an error, and the
// message says which height was looked up so the miss is not mistaken for the
// anchor being unpublished.
function renderAnchorCoveringCheckpoint(d){
    let row = d || {};
    let cp  = row.checkpoint;
    // On a bundle the mirror is filtered to THIS coin's chain, so the height that
    // was looked up, and the payload the mirror is compared against, both come from
    // this coin's own section. Another section's height would name a lookup that was
    // never made and compare two chains' hashes.
    let payload = anchorLocalSection(row) || row;
    if(!cp){
        let at = isNull(payload.block_index) ? 'the checkpointed height' : ('checkpointed height ' + anchorNum(payload.block_index));
        return anchorEmpty('No mirrored checkpoint covers ' + at + ' yet. This lookup uses the CHECKPOINTED height, not the block the anchor transaction landed in.');
    }
    let sigs = Array.isArray(cp.validator_signatures) ? cp.validator_signatures : [];
    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += anchorFieldRow('Checkpoint', isNull(cp.block_index) ? '-'
        : formatLink('/' + anchorCoin() + '/checkpoint/' + cp.block_index, anchorNum(cp.block_index) + ' (verify)'), 'anchor-covering-link');
    html += anchorFieldRow('Checkpoint Seq', isNull(cp.checkpoint_seq) ? '-' : anchorEsc(cp.checkpoint_seq));
    html += anchorFieldRow('Snapshot Block', anchorBlockLink(cp.snapshot_block));
    html += anchorFieldRow('State Root',     anchorRootCell(cp.state_root, cp.state_root_version));
    html += anchorFieldRow('Signatures',     '<span class="anchor-covering-sig-count">' + sigs.length + '</span> attached');
    html += anchorFieldRow('Created',        isNull(cp.created_at) ? '-' : formatLivestamp(cp.created_at));
    html += '</tbody></table>';
    // Agreement between what was published on DOGE and what the mirror holds is
    // the one cross-check this page can make on its own, so it is stated rather
    // than left for the reader to eyeball two hex strings.
    if(!isNull(payload.block_hash) && !isNull(cp.block_hash)){
        let same = String(payload.block_hash).toLowerCase() === String(cp.block_hash).toLowerCase();
        html += '<div class="mt-2 anchor-mirror-agreement">'
            + '<span class="badge text-bg-' + (same ? 'success' : 'danger') + '">'
            + (same ? 'Mirror agrees with the on-chain payload' : 'Mirror DISAGREES with the on-chain payload')
            + '</span></div>';
    }
    return html;
}

/* ------------------------------------------------------------------ *
 * Publisher election
 * ------------------------------------------------------------------ */

// The oracle_publish electorate at this anchor's snapshot_block, plus which
// member the anchor names as the elected publisher. capability_snapshots is
// chain-agnostic, so this set is the platform-wide one at that snapshot block.
function renderAnchorElection(d){
    let row   = d || {};
    let t     = anchorTraits(row);
    let set   = Array.isArray(row.publisher_election) ? row.publisher_election : [];
    let tail  = Array.isArray(row.publisher_attestations) ? row.publisher_attestations : [];
    let html  = '';

    if(!t.publisher && isNull(row.publisher))
        html += anchorEmpty('This ANCHOR version carries no publisher tail, so no publisher was elected for it.');

    html += '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += anchorFieldRow('Publisher', isNull(row.publisher)
        ? '<span class="text-muted">-</span>'
        : '<span class="font-monospace small text-break anchor-publisher">' + anchorEsc(row.publisher) + '</span>', 'anchor-publisher-row');
    html += anchorFieldRow('Elected At', anchorBlockLink(row.snapshot_block)
        + anchorNote('The BTC snapshot block whose oracle_publish set the publisher was drawn from.'));
    html += anchorFieldRow('Wire Attestations',
        '<span class="anchor-tail-count">' + tail.length + '</span> carried'
        + anchorNote('Raw XANCPUB transport, not a verified quorum. Consumers re-verify these against their own validator set.'),
        'anchor-tail-row');
    html += '</tbody></table>';

    if(!set.length){
        html += anchorEmpty('No oracle_publish electorate is recorded at that snapshot block.');
        return html;
    }

    html += '<div class="small text-muted mt-2 mb-1">' + set.length + ' member'
        + (set.length === 1 ? '' : 's') + ' in the oracle_publish set:</div>';
    html += '<table class="table table-sm mb-0 anchor-election-table"><thead><tr>'
        + '<th>Signing Pubkey</th><th>Amount</th><th>Source</th>'
        + '</tr></thead><tbody>';
    set.forEach(function(m){
        let elected = (!isNull(m.signing_pubkey) && !isNull(row.publisher)
                       && String(m.signing_pubkey).toLowerCase() === String(row.publisher).toLowerCase());
        html += '<tr class="anchor-elector-row' + (elected ? ' anchor-elector-elected table-active' : '') + '">'
            + '<td class="font-monospace small text-break">' + anchorEsc(isNull(m.signing_pubkey) ? '-' : m.signing_pubkey)
            + (elected ? ' <span class="badge text-bg-success">elected publisher</span>' : '') + '</td>'
            + '<td>' + (isNull(m.amount) ? '-' : formatAmount(m.amount)) + '</td>'
            + '<td>' + anchorEsc(isNull(m.source) ? '-' : m.source) + '</td>'
            + '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

/* ------------------------------------------------------------------ *
 * Reward attestation trail
 * ------------------------------------------------------------------ */


// An empty trail is a NORMAL state: rewards are attested after the anchor is
// mined, and pre-reward-era anchors never get one at all. It is rendered as an
// absence, never as an error, so a page with no rewards does not read as broken.
function renderAnchorRewards(d){
    let row  = d || {};
    let rows = Array.isArray(row.reward_attestations) ? row.reward_attestations : [];
    if(!rows.length)
        return anchorEmpty('No reward attestation is recorded for this anchor. Rewards are attested after the anchor is mined, and anchors published before the reward era never receive one.');

    let html = '<div class="small text-muted mb-1">' + rows.length + ' reward attestation'
        + (rows.length === 1 ? '' : 's') + ' attributed to this anchor:</div>';
    html += '<table class="table table-sm mb-0 anchor-rewards-table"><thead><tr>'
        + '<th>#</th><th>Type</th><th>Round</th><th>Snapshot Block</th>'
        + '<th>Publisher</th><th>Amount</th><th>Linkage</th><th>Recorded</th>'
        + '</tr></thead><tbody>';
    rows.forEach(function(r){
        let link = anchorRewardLinkage(r, row);
        html += '<tr class="anchor-reward-row">'
            + '<td class="anchor-reward-id">' + anchorEsc(isNull(r.id) ? '-' : r.id) + '</td>'
            + '<td class="anchor-reward-type">' + anchorEsc(isNull(r.reward_type) ? '-' : r.reward_type) + '</td>'
            + '<td class="anchor-reward-round">' + anchorEsc(isNull(r.round_reference) ? '-' : r.round_reference) + '</td>'
            + '<td>' + anchorBlockLink(r.snapshot_block) + '</td>'
            + '<td class="font-monospace small text-break">' + anchorEsc(isNull(r.publisher) ? '-' : r.publisher) + '</td>'
            + '<td class="anchor-reward-amount">' + (isNull(r.reward_amount) ? '-' : formatAmount(r.reward_amount)) + '</td>'
            + '<td><span class="badge text-bg-' + link.tone + ' anchor-reward-linkage">' + anchorEsc(link.label) + '</span>'
            + '<div class="small text-muted font-monospace text-break anchor-reward-txid">'
            + anchorEsc(isNull(r.doge_anchor_txid) ? '-' : r.doge_anchor_txid) + '</div></td>'
            + '<td>' + (isNull(r.created_at) ? '-' : formatLivestamp(r.created_at)) + '</td>'
            + '</tr>';
    });
    html += '</tbody></table>';
    // The reward rows carry their own chain/network, which is the scope the
    // trail was queried under; showing it keeps a cross-chain row from being
    // read as belonging to this coin.
    let scopes = [];
    rows.forEach(function(r){
        let s = (isNull(r.chain) ? '-' : String(r.chain)) + '/' + (isNull(r.network) ? '-' : String(r.network));
        if(scopes.indexOf(s) < 0) scopes.push(s);
    });
    html += '<div class="small text-muted mt-1 anchor-reward-scope">Reward scope: ' + anchorEsc(scopes.join(', ')) + '</div>';
    return html;
}

/* ------------------------------------------------------------------ *
 * Page assembly
 * ------------------------------------------------------------------ */

// Every panel gets a value on every path, so no panel is ever left showing the
// loading placeholder after a response has been handled.
function renderAnchorPage(d){
    let row = d || {};
    let t   = anchorTraits(row);
    $('#anchor-heading').html('<span class="anchor-heading-index">'
        + anchorEsc(isNull(row.action_index) ? '' : row.action_index) + '</span>');
    $('#anchor-identity').html(renderAnchorIdentity(row));
    $('#anchor-heights').html(renderAnchorHeights(row));
    $('#anchor-checkpoint-payload').html(renderAnchorCheckpointPayload(row));
    $('#anchor-sections').html(renderAnchorSections(row));
    $('#anchor-archive-payload').html(renderAnchorArchivePayload(row));
    $('#anchor-covering-checkpoint').html(renderAnchorCoveringCheckpoint(row));
    $('#anchor-election').html(renderAnchorElection(row));
    $('#anchor-rewards').html(renderAnchorRewards(row));
    // The archive card is hidden outright on an anchor that carries no archive:
    // an empty batch table beside a populated checkpoint reads as missing data.
    // The sections card follows the same rule for a non-bundle anchor.
    $('#anchor-archive-card').toggleClass('d-none', !t.archive);
    $('#anchor-sections-card').toggleClass('d-none', !t.bundle);
}

// One shared terminal state for "no such anchor" and for a failed request. Both
// are explicit: a detail page of blank placeholders cannot be told apart from a
// page whose data did not arrive.
function renderAnchorMessage(message, tone){
    let cls  = (tone === 'danger') ? 'text-danger' : 'text-muted';
    let cell = '<span class="' + cls + ' anchor-message">' + anchorEsc(message) + '</span>';
    $('#anchor-identity').html('<tr><td>' + cell + '</td></tr>');
    $('#anchor-heights').html(cell);
    $('#anchor-checkpoint-payload').html(cell);
    $('#anchor-sections').html('<span class="text-muted">-</span>');
    $('#anchor-archive-payload').html('<span class="text-muted">-</span>');
    $('#anchor-covering-checkpoint').html('<span class="text-muted">-</span>');
    $('#anchor-election').html('<span class="text-muted">-</span>');
    $('#anchor-rewards').html('<span class="text-muted">-</span>');
    $('#anchor-archive-card').addClass('d-none');
    $('#anchor-sections-card').addClass('d-none');
}
