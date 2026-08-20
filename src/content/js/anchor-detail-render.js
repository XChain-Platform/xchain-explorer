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
 * Payload, election and reward-attribution renders for anchor.html. Split out of
 * that page's inline script so a test can drive the real render path with a
 * stubbed /api/anchor/{QUERY} response instead of asserting on page source text.
 *
 * TWO BLOCK HEIGHTS, BOTH CORRECT. This is the single thing this surface exists
 * to make unambiguous:
 *
 *   anchor_actions.block_index      - the CHECKPOINTED height. The height on the
 *                                     checkpointed chain that this anchor commits
 *                                     to. state_checkpoints is keyed by it, and
 *                                     the commitments join deliberately keys off
 *                                     it too.
 *   anchor_actions.block_index_doge - the height the ANCHOR TRANSACTION ITSELF was
 *                                     mined at on DOGE. Always at or ahead of the
 *                                     checkpointed height, because the anchor is
 *                                     published after the height it commits to.
 *
 * A reader who takes the broadcast height for the checkpointed one looks up the
 * commitment leg by the wrong number, finds "not yet anchored", and reads correct
 * data as a defect. That has already happened once. Both heights are therefore
 * rendered side by side, each carrying its own label, badge and one-line
 * explanation, and NEITHER is ever rendered as a bare "Block".
 *
 * VERSION TRAITS, NOT A VERSION GUESS. Which payload legs an anchor carries is a
 * property of its wire version (anchor_actions.sql), not of which columns happen
 * to be non-NULL, so the table below is the authority and the shape fallback is
 * reserved for versions this build does not know about.
 *
 * REWARD LINKAGE IS SHOWN, NOT ASSUMED. getAnchor correlates the reward trail two
 * ways: on the mined DOGE txid this anchor landed in (proof), or on
 * snapshot_block + the round this anchor closed (inference). Those are different
 * strengths of evidence and each row says which one matched it.
 */

// Wire versions and the payload legs each one carries, per anchor_actions.sql.
// v0 checkpoint; v1 checkpoint + archive segment; v2 archive continuation chunk;
// v3 checkpoint + SPV roots; v4/v5/v6 add the publisher-attestation tail to
// v0/v3/v1 respectively.
var ANCHOR_VERSION_TRAITS = {
    0: { label: 'Checkpoint',                                  checkpoint: true,  archive: false, roots: false, publisher: false, continuation: false },
    1: { label: 'Checkpoint + match archive',                  checkpoint: true,  archive: true,  roots: false, publisher: false, continuation: false },
    2: { label: 'Archive continuation chunk',                  checkpoint: false, archive: true,  roots: false, publisher: false, continuation: true  },
    3: { label: 'Checkpoint + SPV roots',                      checkpoint: true,  archive: false, roots: true,  publisher: false, continuation: false },
    4: { label: 'Checkpoint + publisher tail',                 checkpoint: true,  archive: false, roots: false, publisher: true,  continuation: false },
    5: { label: 'Checkpoint + SPV roots + publisher tail',     checkpoint: true,  archive: false, roots: true,  publisher: true,  continuation: false },
    6: { label: 'Match archive + publisher tail',              checkpoint: true,  archive: true,  roots: false, publisher: true,  continuation: false }
};

// Page-local escape, matching the per-page pattern the other detail pages use.
// An INVALID-status anchor persists its raw wire fields verbatim, so nothing
// below reaches the DOM unescaped.
function anchorEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

function anchorCoin(){
    return (typeof XC !== 'undefined' && XC && XC.coin) ? XC.coin : '';
}

function anchorNum(v){
    return (typeof numeral === 'function') ? numeral(v).format('0,0') : anchorEsc(v);
}

function anchorBlockLink(height){
    if(isNull(height)) return '-';
    return formatLink('/' + anchorCoin() + '/block/' + height, anchorNum(height));
}

function anchorHash(v){
    if(isNull(v)) return '-';
    return '<span class="font-monospace small text-break">' + anchorEsc(v) + '</span>';
}

function anchorFieldRow(label, value, cls){
    return '<tr' + (isNull(cls) ? '' : ' class="' + cls + '"') + '>'
        + '<th class="text-muted fw-normal anchor-field-label" style="width:14rem;">' + anchorEsc(label) + '</th>'
        + '<td class="anchor-field-value">' + value + '</td></tr>';
}

function anchorNote(text){
    return '<div class="small text-muted anchor-note">' + anchorEsc(text) + '</div>';
}

function anchorEmpty(text){
    return '<div class="small text-muted anchor-empty">' + anchorEsc(text) + '</div>';
}

// Status is the indexer's own verdict on the row ('valid', 'unverified', or an
// 'invalid: reason' string). 'unverified' is a structural state (no local
// capability snapshot to check against), NOT a failure, so it is warned rather
// than alarmed.
function anchorStatusBadge(status){
    let s = isNull(status) ? 'unknown' : String(status);
    let tone = 'secondary';
    if(s === 'valid')            tone = 'success';
    else if(s === 'unverified')  tone = 'warning';
    else if(s.indexOf('invalid') === 0) tone = 'danger';
    return '<span class="badge text-bg-' + tone + ' anchor-status-badge">' + anchorEsc(s) + '</span>';
}

// Which payload legs this anchor carries. Known versions come from the traits
// table; an unrecognized version falls back to the payload's own shape so a
// future version renders what it actually has instead of nothing at all.
function anchorTraits(d){
    let row = d || {};
    let v   = isNull(row.version) ? null : Number(row.version);
    let t   = (v !== null && ANCHOR_VERSION_TRAITS[v]) ? ANCHOR_VERSION_TRAITS[v] : null;
    if(t)
        return {
            known: true, version: v, label: t.label,
            checkpoint: t.checkpoint, archive: t.archive, roots: t.roots,
            publisher: t.publisher, continuation: t.continuation
        };
    let sigs = Array.isArray(row.publisher_attestations) ? row.publisher_attestations : [];
    return {
        known: false,
        version: v,
        label: (v === null) ? 'Anchor' : ('Unrecognized version v' + v),
        checkpoint:   !isNull(row.checkpoint_seq),
        archive:      !isNull(row.match_batch_seq),
        roots:        (!isNull(row.state_root) || !isNull(row.block_merkle_root)),
        publisher:    (!isNull(row.publisher) || sigs.length > 0),
        continuation: (!isNull(row.chunk_index) && Number(row.chunk_index) > 0)
    };
}

/* ------------------------------------------------------------------ *
 * The two heights
 * ------------------------------------------------------------------ */

function anchorHeightRow(cls, label, height, badge, note){
    return '<tr class="' + cls + '">'
        + '<th class="text-muted fw-normal" style="width:14rem;">'
        + '<span class="anchor-height-label">' + anchorEsc(label) + '</span></th>'
        + '<td><span class="anchor-height-value">' + anchorBlockLink(height) + '</span>'
        + ' <span class="badge text-bg-secondary anchor-height-badge">' + anchorEsc(badge) + '</span>'
        + anchorNote(note) + '</td></tr>';
}

function renderAnchorHeights(d){
    let row   = d || {};
    let chain = isNull(row.chain) ? 'the checkpointed chain' : String(row.chain);
    let html  = '<table class="table table-sm table-borderless mb-0"><tbody>';
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
        + (t.known ? '' : anchorNote('This build does not recognize this ANCHOR version, so the payload legs below were read from the row itself rather than from the version.')));
    html += anchorFieldRow('Status', anchorStatusBadge(row.status));
    html += anchorFieldRow('Chain', anchorEsc(isNull(row.chain) ? '-' : row.chain)
        + ' <span class="badge text-bg-secondary">' + anchorEsc(isNull(row.network) ? '-' : row.network) + '</span>');
    html += anchorFieldRow('Transaction', isNull(row.tx_hash) ? '-'
        : formatLink('/' + anchorCoin() + '/transaction/' + row.tx_hash,
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

// A root plus the merkle version that produced it. A root-bearing version that
// is missing either one cannot be checked against the current preimage, so the
// absence is shown rather than blanked.
function anchorRootCell(root, version){
    if(isNull(root))
        return '<span class="badge text-bg-warning">missing</span>';
    return anchorHash(root)
        + (isNull(version) ? ' <span class="badge text-bg-warning">version missing</span>'
                           : ' <span class="badge text-bg-secondary">v' + anchorEsc(version) + '</span>');
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

function anchorChunkLabel(d){
    let row = d || {};
    if(isNull(row.chunk_index) && isNull(row.total_chunks)) return '-';
    let idx   = isNull(row.chunk_index)  ? 0 : Number(row.chunk_index);
    let total = isNull(row.total_chunks) ? null : Number(row.total_chunks);
    return anchorEsc(idx) + (total === null ? '' : (' of ' + anchorEsc(total)));
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
    if(!cp){
        let at = isNull(row.block_index) ? 'the checkpointed height' : ('checkpointed height ' + anchorNum(row.block_index));
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
    if(!isNull(row.block_hash) && !isNull(cp.block_hash)){
        let same = String(row.block_hash).toLowerCase() === String(cp.block_hash).toLowerCase();
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

// How a reward row reached this anchor. getAnchor ORs two correlations and they
// are NOT equally strong: the txid match is proof the reward names this exact
// mined anchor transaction, while the round match only says the row shares this
// anchor's snapshot block and round reference.
function anchorRewardLinkage(rewardRow, d){
    let r   = rewardRow || {};
    let row = d || {};
    if(!isNull(r.doge_anchor_txid) && !isNull(row.tx_hash)
       && String(r.doge_anchor_txid).toLowerCase() === String(row.tx_hash).toLowerCase())
        return { tone: 'success', label: 'proven by txid' };
    return { tone: 'secondary', label: 'matched by round' };
}

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
    $('#anchor-archive-payload').html(renderAnchorArchivePayload(row));
    $('#anchor-covering-checkpoint').html(renderAnchorCoveringCheckpoint(row));
    $('#anchor-election').html(renderAnchorElection(row));
    $('#anchor-rewards').html(renderAnchorRewards(row));
    // The archive card is hidden outright on an anchor that carries no archive:
    // an empty batch table beside a populated checkpoint reads as missing data.
    $('#anchor-archive-card').toggleClass('d-none', !t.archive);
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
    $('#anchor-archive-payload').html('<span class="text-muted">-</span>');
    $('#anchor-covering-checkpoint').html('<span class="text-muted">-</span>');
    $('#anchor-election').html('<span class="text-muted">-</span>');
    $('#anchor-rewards').html('<span class="text-muted">-</span>');
    $('#anchor-archive-card').addClass('d-none');
}
