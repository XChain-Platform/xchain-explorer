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
 *
 * A v0 IS A BUNDLE, NOT A CHECKPOINT. One v0 action carries EVERY checkpointed
 * chain of one network, stored as sibling rows sharing an action_index. It
 * therefore has no single chain, no single checkpointed height and no single set
 * of roots, and rendering it through the single-row layout would silently present
 * one arbitrary section as the whole anchor. Every per-chain field a bundle owns
 * is rendered in the sections table instead, and the single-row layout is kept
 * verbatim for the archive versions that really do carry exactly one.
 *
 * ACTIVATION GATES THE TRAITS TABLE, NOT JUST THE VERSION BYTE. The ANCHOR wire
 * set restarted at v0: every row mined below ANCHOR_ACTIVATION for its
 * network reused version BYTES 0-7 under an OLDER, unrelated meaning (v1 used to
 * mean "checkpoint + match archive"; today's v1 means "archive head + publisher
 * tail"). Looking such a row up in ANCHOR_VERSION_TRAITS would render the WRONG
 * shape under a plausible-looking label, so anchorTraits checks the activation
 * height FIRST and renders every legacy row through the known:false path with a
 * dedicated "Legacy (before activation)" label, never through the version table.
 */

// Wire versions and the payload legs each one carries, per anchor_actions.sql, for
// any row AT OR ABOVE its network's ANCHOR_ACTIVATION height. v0 is the
// per-network checkpoint BUNDLE, root-bearing by construction, one section per
// chain; v1 is the archive head, carrying both its own checkpoint fields and the
// match archive, with a publisher-attestation tail that may legitimately be empty
// (ATTEST_SIG_COUNT 0, D4); v2 is the archive continuation chunk. A row below
// activation never reaches this table - see the ACTIVATION GATE note above.
var ANCHOR_VERSION_TRAITS = {
    0: { label: 'Checkpoint bundle (one per network)',         checkpoint: true,  archive: false, roots: true,  publisher: true,  continuation: false, bundle: true  },
    1: { label: 'Archive head + publisher tail',               checkpoint: true,  archive: true,  roots: false, publisher: true,  continuation: false, bundle: false },
    2: { label: 'Archive continuation chunk',                  checkpoint: false, archive: true,  roots: false, publisher: false, continuation: true,  bundle: false }
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
//
// The activation gate runs BEFORE the version lookup (D7): a row mined below
// ANCHOR_ACTIVATION for its network is legacy regardless of its version byte,
// because that byte was reused under an older meaning before the v0/v1/v2
// restart. Routing it through today's traits table would render the wrong
// shape under a plausible-looking label (a legacy v1 "checkpoint + match
// archive" would read as today's v1 "archive head"), so it renders through the
// same known:false path an unrecognized version does, tagged legacy instead.
function anchorTraits(d){
    let row = d || {};
    let v   = isNull(row.version) ? null : Number(row.version);

    let net    = isNull(row.network) ? null : String(row.network);
    let cutoff = (net !== null && Object.prototype.hasOwnProperty.call(ANCHOR_ACTIVATION, net))
        ? ANCHOR_ACTIVATION[net] : null;
    let doge   = isNull(row.block_index_doge) ? null : Number(row.block_index_doge);
    let legacy = (cutoff !== null && doge !== null && doge < cutoff);

    let t = (!legacy && v !== null && ANCHOR_VERSION_TRAITS[v]) ? ANCHOR_VERSION_TRAITS[v] : null;
    if(t)
        return {
            known: true, version: v, label: t.label,
            checkpoint: t.checkpoint, archive: t.archive, roots: t.roots,
            publisher: t.publisher, continuation: t.continuation,
            bundle: (t.bundle === true)
        };
    let sigs = Array.isArray(row.publisher_attestations) ? row.publisher_attestations : [];
    return {
        known: false,
        version: v,
        legacy: legacy,
        // The row's OWN stored verdict, carried through verbatim rather than
        // guessed at: the Status field renders it separately too, but the
        // legacy note names it inline so the "why" sits next to the label.
        reason: legacy ? (isNull(row.status) ? null : String(row.status)) : null,
        label: legacy ? 'Legacy (before activation)' : ((v === null) ? 'Anchor' : ('Unrecognized version v' + v)),
        checkpoint:   !isNull(row.checkpoint_seq),
        archive:      !isNull(row.match_batch_seq),
        roots:        (!isNull(row.state_root) || !isNull(row.block_merkle_root)),
        publisher:    (!isNull(row.publisher) || sigs.length > 0),
        continuation: (!isNull(row.chunk_index) && Number(row.chunk_index) > 0),
        // A future bundling version is recognizable from the payload itself: more
        // than one section row came back for this action.
        bundle:       (anchorSectionRows(row).length > 1)
    };
}

/* ------------------------------------------------------------------ *
 * Bundle sections
 * ------------------------------------------------------------------ */

// The sibling section rows getAnchor composed onto the header, already ordered by
// section_index. Absent on every non-bundle anchor, so this is the one accessor
// the rest of the file goes through rather than touching row.sections directly.
function anchorSectionRows(d){
    let row = d || {};
    return Array.isArray(row.sections) ? row.sections : [];
}

// THIS coin's own section of a bundle, named by getAnchor (local_section_index).
// It is the section whose chain the covering-checkpoint mirror is filtered to, so
// it is the only section this explorer can cross-check against its mirror.
function anchorLocalSection(d){
    let row = d || {};
    if(isNull(row.local_section_index)) return null;
    let hit = null;
    anchorSectionRows(row).forEach(function(s){
        if(!isNull(s.section_index) && String(s.section_index) === String(row.local_section_index)) hit = s;
    });
    return hit;
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

// A bundle commits a DIFFERENT height on every chain it carries, so there is no
// single checkpointed height to put opposite the broadcast one. The per-chain
// heights are listed in place of the single value rather than picking one section
// to stand for all of them, and the row keeps its label and class so the
// broadcast height is still never the only height on the page.
function anchorBundleHeightRow(d){
    let sections = anchorSectionRows(d);
    let parts    = [];
    sections.forEach(function(s){
        parts.push('<span class="anchor-section-height">'
            + anchorEsc(isNull(s.chain) ? '-' : s.chain) + ' ' + anchorBlockLink(s.block_index) + '</span>');
    });
    return '<tr class="anchor-height-checkpointed">'
        + '<th class="text-muted fw-normal" style="width:14rem;">'
        + '<span class="anchor-height-label">Checkpointed Blocks</span></th>'
        + '<td><span class="anchor-height-value">' + (parts.length ? parts.join(' &middot; ') : '-') + '</span>'
        + ' <span class="badge text-bg-secondary anchor-height-badge">checkpointed</span>'
        + anchorNote('One height per chain in this bundle. Checkpoint and commitment lookups key off THIS chain\'s height, not the bundle.')
        + '</td></tr>';
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

function anchorChunkLabel(d){
    let row = d || {};
    if(isNull(row.chunk_index) && isNull(row.total_chunks)) return '-';
    let idx   = isNull(row.chunk_index)  ? 0 : Number(row.chunk_index);
    let total = isNull(row.total_chunks) ? null : Number(row.total_chunks);
    return anchorEsc(idx) + (total === null ? '' : (' of ' + anchorEsc(total)));
}

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

function anchorSectionRowsHtml(sections, row){
    let html = '';
    sections.forEach(function(s){
        let sigs  = Array.isArray(s.validator_signatures) ? s.validator_signatures : [];
        let local = (!isNull(row.local_section_index) && !isNull(s.section_index)
                     && String(s.section_index) === String(row.local_section_index));
        html += '<tr class="anchor-section-row' + (local ? ' anchor-section-local table-active' : '') + '">'
            + '<td class="anchor-section-index">' + anchorEsc(isNull(s.section_index) ? '-' : s.section_index) + '</td>'
            + '<td class="anchor-section-chain">' + anchorEsc(isNull(s.chain) ? '-' : s.chain)
            + (local ? ' <span class="badge text-bg-primary">this explorer</span>' : '') + '</td>'
            + '<td class="anchor-section-block">' + anchorBlockLink(s.block_index) + '</td>'
            + '<td class="anchor-section-seq">' + (isNull(s.checkpoint_seq) ? '-' : anchorEsc(s.checkpoint_seq)) + '</td>'
            + '<td class="anchor-section-snapshot">' + anchorBlockLink(s.snapshot_block) + '</td>'
            + '<td class="anchor-section-state-root">' + anchorRootCell(s.state_root, s.state_root_version) + '</td>'
            + '<td class="anchor-section-merkle-root">' + anchorRootCell(s.block_merkle_root, s.block_merkle_version) + '</td>'
            + '<td><span class="anchor-section-sig-count">' + sigs.length + '</span></td>'
            + '</tr>';
    });
    return html;
}
