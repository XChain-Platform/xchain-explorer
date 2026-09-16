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
 * XChain Explorer - federation read queries
 *
 * The reads behind the five federation JSON-RPC methods the explorer serves to
 * validators that have no DOGE indexer of their own (src/federation/). Each one
 * is the indexer's own accessor, ported with its statement and its argument
 * coercion unchanged, and pointed at a coin's replicated indexer database
 * through doQuery instead of the indexer's API view.
 *
 * Why a replica can answer at all: every table read here (blocks, rollcall_signers,
 * anchor_actions, prices, actions, transactions and the index_* lookups) is
 * replicated by xchain-sync, and a replica only ever sees committed blocks, which is
 * the same committed-only isolation the indexer's API view gives its own reads.
 *
 * Authored as a class body whose prototype is exported, like every other family
 * under src/db/: `this` is the Database instance at call time.
 *
 ********************************************************************/

'use strict';

const {
    CHECKPOINT_VERSIONS, ANCHOR_ACTIONS_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_ANCHOR_BY_CONTENT_SQL, ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL
} = require('../federation_sql.js');

class FederationReaders {

    // The raw block_time at one height, or null when there is no such block. The
    // roll-call read reports it as the tip stamp, so it is never adjusted or cached.
    async getBlockTimeAtHeightOrNull(config, blockIndex) {
        let rows = await this.doQuery(config, 'SELECT block_time FROM blocks WHERE block_index = ?', [blockIndex]);
        return (rows && rows[0]) ? parseInt(rows[0].block_time) : null;
    }

    // The roll-call window cut: the highest block stamped at or before maxBlockTime.
    // Null means no block is inside the window yet, which the caller must read as
    // "defer", never as "nobody signed".
    async getRollcallWindowCut(config, maxBlockTime) {
        let t = parseInt(maxBlockTime);
        if (!Number.isFinite(t)) return null;
        let rows = await this.doQuery(config,
            'SELECT MAX(block_index) AS hcut FROM blocks WHERE block_time <= ?', [t]);
        let hcut = (rows && rows[0] && rows[0].hcut !== null && rows[0].hcut !== undefined)
                 ? parseInt(rows[0].hcut) : null;
        return Number.isFinite(hcut) ? hcut : null;
    }

    // First-seen presence signatures for an epoch, bounded by the caller's key list so
    // the answer size is set by the asker, never by how many actions landed.
    async getRollcallSignersForKeys(config, epochHeight, pubkeys, hcut) {
        let e = parseInt(epochHeight), h = parseInt(hcut);
        if (!Number.isFinite(e) || !Number.isFinite(h)) return [];
        if (!Array.isArray(pubkeys) || pubkeys.length === 0) return [];
        let keys = pubkeys.map((k) => String(k).toLowerCase());
        let query = `SELECT epoch_height, pubkey, sig, ledger_hash, publisher, action_index, block_index, gates
                       FROM rollcall_signers
                      WHERE epoch_height = ? AND block_index <= ?
                        AND pubkey IN (${keys.map(() => '?').join(', ')})`;
        return await this.doQuery(config, query, [e, h].concat(keys));
    }

    // Earliest in-window roll call each requested publisher key sent for an epoch.
    async getRollcallPublishers(config, epochHeight, publishers, hcut) {
        let e = parseInt(epochHeight), h = parseInt(hcut);
        if (!Number.isFinite(e) || !Number.isFinite(h)) return [];
        if (!Array.isArray(publishers) || publishers.length === 0) return [];
        let keys = publishers.map((k) => String(k).toLowerCase());
        let query = `SELECT publisher, MIN(action_index) AS action_index, MIN(block_index) AS block_index
                       FROM rollcall_signers
                      WHERE epoch_height = ? AND block_index <= ?
                        AND publisher IN (${keys.map(() => '?').join(', ')})
                      GROUP BY publisher`;
        return await this.doQuery(config, query, [e, h].concat(keys));
    }

    // Candidate anchor rows for one checkpoint identity (see ANCHOR_ACTIONS_SQL for
    // the family-before-recency order the row pick depends on).
    async getAnchorActionCandidates(config, chain, network, blockIndex, checkpointSeq) {
        return await this.doQuery(config, ANCHOR_ACTIONS_SQL,
            [chain, network, blockIndex, checkpointSeq, ...CHECKPOINT_VERSIONS]);
    }

    // Every anchor row one DOGE txid carries, from the first page or strictly after an
    // action_index cursor. The caller has already lowercased the txid.
    async getAnchorRowsByTxid(config, txid, afterActionIndex) {
        return (afterActionIndex === null)
            ? await this.doQuery(config, ANCHOR_BY_TXID_SQL,       [txid])
            : await this.doQuery(config, ANCHOR_BY_TXID_AFTER_SQL, [txid, afterActionIndex]);
    }

    // Archive-head candidates for one batch keyed on its content, earliest first. The
    // coercions are the indexer's: numeric identity fields, lowercase crc.
    async getArchiveAnchorHeads(config, chain, network, blockIndex, checkpointSeq, batchCrc32, matchCount) {
        return await this.doQuery(config, ARCHIVE_ANCHOR_BY_CONTENT_SQL,
            [chain, network, Number(blockIndex), Number(checkpointSeq),
             String(batchCrc32).toLowerCase(), Number(matchCount)]);
    }

    // The continuation chunks one publisher address sent under one batch seq, before
    // the caller's one-row-per-index dedupe.
    async getArchiveChunksByAuthor(config, batchSeq, author) {
        return await this.doQuery(config, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL, [batchSeq, String(author)]);
    }

    // Valid PRICE batch rows overlapping a closed round range. A batch overlaps when it
    // starts at or before the range's end and ends at or after its start, which is why
    // the two round arguments read in the opposite order to the range itself.
    async getPriceBatchesOverlappingRange(config, validationStatus, lastRound, firstRound, limit) {
        let query = `SELECT action_index, batch_first_round, batch_last_round, round_count
                     FROM prices
                     WHERE version = 0 AND validation_status = ?
                     AND batch_first_round IS NOT NULL AND batch_last_round IS NOT NULL
                     AND batch_first_round <= ? AND batch_last_round >= ?
                     ORDER BY batch_first_round ASC, action_index ASC
                     LIMIT ?`;
        return await this.doQuery(config, query, [validationStatus, lastRound, firstRound, limit]);
    }
}

module.exports = FederationReaders.prototype;
