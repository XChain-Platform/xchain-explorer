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
 * XChain Explorer - federation read: getarchiveanchor
 *
 * "Is this exact archive batch already on chain, published by this address?",
 * keyed on the batch's content rather than the sequence it went out under. The
 * hub's archive publisher asks after a crash between broadcasting a head and
 * recording it, so it resumes the batch instead of paying for a duplicate. Ported
 * from the indexer (src/actions/anchor/anchor_action_query/archive_query.js,
 * getArchiveAnchorByContent and getAnchorChunks in src/db/database/mirror_reads.js,
 * and the handler in src/api/rpc/anchor.js) with the checks, the head pick and the
 * response shape unchanged.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability');

const log = getLogger();

// A batch CRC as the publisher formats it and the indexer stores it: 8 lowercase hex digits.
const ARCHIVE_CRC_RE = /^[0-9a-f]{8}$/;

// Dedupe a chunk-set result to one row per chunk_index, lowest action_index first
// (the statement's ORDER BY guarantees that arrival order).
function dedupeArchiveChunks(rows) {
    let byIndex = new Map();
    for (let r of (rows || []))
        if (!byIndex.has(Number(r.chunk_index))) byIndex.set(Number(r.chunk_index), r);
    return Array.from(byIndex.values());
}

// Validate a request. batch_crc32 and match_count are REQUIRED: without both the read
// degenerates into "is this checkpoint archived at all", which a different batch in the
// same checkpoint would answer yes to. `author` optionally scopes it to one publisher.
function validateArchiveAnchorParams({ chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author }) {
    // The checkpointed chain and network name the identity being asked about
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    // Height and sequence are non-negative integers
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    // The content commitment's crc is 8 hex digits
    if (typeof batch_crc32 !== 'string' || !ARCHIVE_CRC_RE.test(batch_crc32.toLowerCase()))
        return { ok: false, error: 'batch_crc32 must be an 8-character hex string' };
    let mc = Number(match_count);
    // And its match count is a non-negative integer
    if (!Number.isInteger(mc) || mc < 0)
        return { ok: false, error: 'match_count must be a non-negative integer' };
    let wantAuthor = null;
    if (author !== undefined && author !== null && author !== '') {
        // A supplied author is an address string
        if (typeof author !== 'string') return { ok: false, error: 'author must be a string address' };
        wantAuthor = author;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs,
             batch_crc32: batch_crc32.toLowerCase(), match_count: mc, author: wantAuthor };
}

// Pick the head from candidates arriving action_index ASC: the earliest wins, and a
// supplied author narrows to that publisher's own head. An unresolved author compares
// unequal (fail closed). Addresses compare exactly, since base58 is case-significant.
function selectArchiveHeadRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.author) candidates = candidates.filter(r => r.source != null && String(r.source) === String(f.author));
    return candidates.length > 0 ? candidates[0] : null;
}

// The chunk indexes present for a head, sorted. Chunk 0 rides in the head itself, so
// it is present whenever the head is.
function presentChunkIndexes(head, chunkRows) {
    let present = new Set([0]);
    for (let r of (chunkRows || [])) {
        let i = Number(r.chunk_index);
        if (Number.isInteger(i) && i > 0) present.add(i);
    }
    return Array.from(present).sort((a, b) => a - b);
}

// Map the head (or null) and its chunk set into the response. chunks_present and
// chunks_complete let a resuming publisher re-send only what is missing, in the slots
// its earlier process allocated.
function buildArchiveAnchorResponse(chain, latest, head, chunkRows) {
    let coin    = chain['COIN'];
    let network = chain['NETWORK'];
    if (!head) {
        return { coin, network, exists: false, latest_block_index: latest, confirmations: 0,
                 chunks_present: [], chunks_complete: false };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(head.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    let total   = Number(head.total_chunks);
    let present = presentChunkIndexes(head, chunkRows);
    // Complete only when every declared index is accounted for; a malformed total never is
    let complete = Number.isInteger(total) && total > 0 && present.length >= total &&
                   present[present.length - 1] === total - 1;
    return {
        coin, network,
        exists:             true,
        status:             head.status,
        version:            Number(head.version),
        txid:               head.txid ? String(head.txid).toLowerCase() : null,
        author:             head.source != null ? String(head.source) : null,
        checkpoint_chain:   head.chain,
        checkpoint_network: head.network,
        block_index:        Number(head.block_index),
        checkpoint_seq:     Number(head.checkpoint_seq),
        snapshot_block:     (head.snapshot_block != null) ? Number(head.snapshot_block) : null,
        // The seq the batch actually landed under, which the resuming caller could not know
        match_batch_seq:    (head.match_batch_seq != null) ? Number(head.match_batch_seq) : null,
        match_count:        (head.match_count != null) ? Number(head.match_count) : null,
        batch_crc32:        head.batch_crc32 != null ? String(head.batch_crc32).toLowerCase() : null,
        total_chunks:       Number.isFinite(total) ? total : null,
        chunks_present:     present,
        chunks_complete:    complete,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

// The head for a content key plus the chunks already on chain for it. Chunks are read
// under the head's OWN seq and author, never the caller's; a head whose author did not
// resolve has no attributable chunk set, so it reports none.
async function findArchiveAnchorByContent(db, dbConfig, v, chain, network) {
    let rows = await db.getArchiveAnchorHeads(dbConfig, chain, network, v.block_index,
        v.checkpoint_seq, v.batch_crc32, v.match_count);
    let head = selectArchiveHeadRow(rows, { author: (v.author != null && v.author !== '') ? v.author : null });
    if (!head) return { head: null, chunks: [] };
    let chunks = head.source != null
        ? dedupeArchiveChunks(await db.getArchiveChunksByAuthor(dbConfig, Number(head.match_batch_seq), String(head.source)))
        : [];
    return { head, chunks };
}

// The method body: validate, read the tip, find the head and its chunks, map.
async function getarchiveanchor({ db, dbConfig, chain }, {chain: cpChain, network, block_index, checkpoint_seq, batch_crc32, match_count, author}) {
    let v = validateArchiveAnchorParams({ chain: cpChain, network, block_index, checkpoint_seq, batch_crc32, match_count, author });
    if (!v.ok) return { error: v.error };
    try {
        let latest = await db.getMaxBlockIndex(dbConfig);
        let found  = await findArchiveAnchorByContent(db, dbConfig, v, cpChain, network);
        return buildArchiveAnchorResponse(chain, latest, found.head, found.chunks);
    } catch (err) {
        log.error('FEDERATION_READ_FAILED', { method: 'getarchiveanchor', coin: dbConfig.coin, err: err && err.message });
        return { error: 'failed to look up archive anchor' };
    }
}

module.exports = {
    ARCHIVE_CRC_RE, dedupeArchiveChunks, validateArchiveAnchorParams, selectArchiveHeadRow,
    presentChunkIndexes, buildArchiveAnchorResponse, getarchiveanchor
};
