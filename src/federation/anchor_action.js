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
 *
 * XChain Explorer - federation read: getanchoraction
 *
 * "Is THIS checkpoint anchored on DOGE, by which transaction, and how deep?" The
 * hub asks before it trusts an announced anchor, so a phantom or substituted txid
 * is caught against the chain rather than taken on the publisher's word. Ported
 * from the indexer (src/actions/anchor/anchor_action_query/action_query.js and the
 * handler in src/api/rpc/anchor.js) with the checks, the row pick and the
 * response shape unchanged.
 *
 * TXID_RE and normalizeVersion are shared with anchor_confirmations.js, as they are
 * in the indexer, so the two reads cannot drift on either.
 *
 ********************************************************************/

'use strict';

const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS } = require('../db/federation_sql.js');
const { getLogger } = require('../observability');

const log = getLogger();

// A DOGE txid as the hub announces it.
const TXID_RE = /^[0-9a-fA-F]{64}$/;

// Validate the request. txid and version are optional narrowing filters: without
// them the answer is only "this checkpoint is anchored", which a Byzantine publisher
// can satisfy while announcing a different txid. Returns {ok, ...} or {ok:false, error}.
function validateAnchorActionParams({ chain, network, block_index, checkpoint_seq, txid, version }) {
    // The checkpointed chain and network name the identity being asked about
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    // Height and sequence are non-negative integers
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    let wantTxid = null;
    if (txid !== undefined && txid !== null && txid !== '') {
        // A supplied txid must be a DOGE txid
        if (typeof txid !== 'string' || !TXID_RE.test(txid))
            return { ok: false, error: 'txid must be a 64-character hex string' };
        wantTxid = txid.toLowerCase();
    }
    let wantVersion = null;
    if (version !== undefined && version !== null && version !== '') {
        let ver = Number(version);
        // A supplied version must be one that carries a checkpoint identity
        if (!Number.isInteger(ver) || !CHECKPOINT_VERSIONS.includes(ver))
            return { ok: false, error: 'version must be one of ' + CHECKPOINT_VERSIONS.join(', ') };
        wantVersion = ver;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs, txid: wantTxid, version: wantVersion };
}

// Pick the requested row from candidates ordered newest-first within a family.
// FAMILY BEFORE RECENCY: whenever a bundle section survives the filters it wins, so
// an unfiltered ask is never answered with the co-located archive head's txid; with
// no section left, the whole set is used so an archive-only key still answers.
function selectAnchorRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.version !== undefined && f.version !== null)
        candidates = candidates.filter(r => Number(r.version) === Number(f.version));
    if (f.txid)
        candidates = candidates.filter(r => String(r.txid || '').toLowerCase() === String(f.txid).toLowerCase());
    let sections = candidates.filter(r => CHECKPOINT_SECTION_VERSIONS.includes(Number(r.version)));
    if (sections.length > 0) candidates = sections;
    return candidates.length > 0 ? candidates[0] : null;
}

// A stored version column as a number, with null/undefined/NaN reading as null so a
// missing version never reaches the wire as NaN.
function normalizeVersion(v) {
    if (v === null || v === undefined) return null;
    let n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Map the picked row (or null) and the tip into the response. `chain` is the anchor
// chain this replica serves ({ COIN, NETWORK }). A missing row, a non-finite tip, or a
// row above the tip reports 0 confirmations, so nothing shallow ever reads as buried.
function buildAnchorActionResponse(chain, latest, row, extra) {
    let coin    = chain['COIN'];
    let network = chain['NETWORK'];
    let anchored = (extra && extra.checkpoint_anchored !== undefined) ? !!extra.checkpoint_anchored : !!row;
    if (!row) {
        return { coin, network, exists: false, checkpoint_anchored: anchored,
                 latest_block_index: latest, confirmations: 0 };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(row.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    return {
        coin, network,
        exists:             true,
        checkpoint_anchored: anchored,
        status:             row.status,
        version:            Number(row.version),
        // Null when the tx linkage is missing; a caller binding a txid treats null as unverifiable
        txid:               row.txid ? String(row.txid).toLowerCase() : null,
        checkpoint_chain:   row.chain,
        checkpoint_network: row.network,
        block_index:        Number(row.block_index),
        block_hash:         row.block_hash,
        ledger_hash:        row.ledger_hash,
        actions_hash:       row.actions_hash,
        contract_hash:      row.contract_hash,
        checkpoint_seq:     Number(row.checkpoint_seq),
        snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
        state_root:           row.state_root || null,
        state_root_version:   row.state_root ? normalizeVersion(row.state_root_version) : null,
        block_merkle_root:    row.block_merkle_root || null,
        block_merkle_version: row.block_merkle_root ? normalizeVersion(row.block_merkle_version) : null,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

// The method body: validate, read the tip and the candidate set, pick, map.
// checkpoint_anchored lets a filtering caller tell "not anchored yet" from a forge.
async function getanchoraction({ db, dbConfig, chain }, {chain: cpChain, network, block_index, checkpoint_seq, txid, version}) {
    let v = validateAnchorActionParams({ chain: cpChain, network, block_index, checkpoint_seq, txid, version });
    if (!v.ok) return { error: v.error };
    try {
        let latest = await db.getMaxBlockIndex(dbConfig);
        let rows   = await db.getAnchorActionCandidates(dbConfig, cpChain, network, v.block_index, v.checkpoint_seq);
        let row    = selectAnchorRow(rows, { txid: v.txid, version: v.version });
        return buildAnchorActionResponse(chain, latest, row,
            { checkpoint_anchored: Array.isArray(rows) && rows.length > 0 });
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getanchoraction', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up anchor action' };
    }
}

module.exports = {
    TXID_RE, normalizeVersion,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse, getanchoraction
};
