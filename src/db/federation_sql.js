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
 * XChain Explorer - Database statements: federation reads
 *
 * The anchor_actions statements and version sets behind the federation reads
 * the explorer serves over JSON-RPC (getanchoraction, getanchorconfirmations,
 * getarchiveanchor), ported from the indexer's src/db/anchor_sql.js. They are
 * named constants, not mixin methods, because the version sets are also read by
 * the request checks in src/federation/, and because a parity suite compares
 * each statement against the indexer's text.
 *
 * The explorer answers these reads for a validator that has no DOGE indexer of
 * its own, off the replicated indexer database. Every statement here must stay
 * byte-for-byte the indexer's after its interpolations resolve: a validator's
 * BTC close binds rewards and evictions to what these return, so an answer that
 * differs from the indexer's is a consensus hazard, not a presentation choice.
 *
 * Not a Database mixin: nothing here belongs on Database.prototype, so this file
 * is required by src/db/readers/federation_reads.js and never by db/index.js.
 *
 ********************************************************************/

'use strict';

// The archive-head version set (the indexer's ARCHIVE_HEAD_VERSIONS in
// stateHash.js). Version 1 is the archive head, which carries its wrapper
// checkpoint's identity.
const ARCHIVE_HEAD_VERSIONS     = [1];
const ARCHIVE_HEAD_VERSIONS_SQL = 'IN (' + ARCHIVE_HEAD_VERSIONS.join(', ') + ')';

// ANCHOR versions that carry a full checkpoint identity: 0 is a bundle section,
// 1 the archive head. Version 2 is a continuation chunk with no identity of its
// own, so it is never a getanchoraction match.
const CHECKPOINT_VERSIONS = [0, 1];

// The members of CHECKPOINT_VERSIONS that are checkpoints in their own right (bundle
// sections). Ranked ahead of archive heads, because both can share one checkpoint key
// and "newest wins" would answer with the archive head's transaction instead.
const CHECKPOINT_SECTION_VERSIONS     = CHECKPOINT_VERSIONS.filter(v => !ARCHIVE_HEAD_VERSIONS.includes(v));
const CHECKPOINT_SECTION_VERSIONS_SQL = 'IN (' + CHECKPOINT_SECTION_VERSIONS.join(', ') + ')';

// Hard per-response row cap for the checkpoint-identity and txid-keyed anchor reads.
const ANCHOR_ROW_LIMIT = 20;

// Candidate anchor rows for one checkpoint identity: sections before archive heads,
// newest first within each family, each with the DOGE txid it landed in. LEFT JOINs
// so a row with missing tx linkage still returns (txid null) instead of vanishing
// into a false "absent". Params: [chain, network, block_index, checkpoint_seq, ...CHECKPOINT_VERSIONS].
const ANCHOR_ACTIONS_SQL =
    `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
            a.block_hash, a.ledger_hash, a.actions_hash, a.contract_hash,
            a.checkpoint_seq, a.snapshot_block, a.state_root, a.state_root_version,
            a.block_merkle_root, a.block_merkle_version, a.block_index_doge, s.status,
            it.hash AS txid
     FROM anchor_actions a
     JOIN index_statuses s ON s.id = a.status_id
     LEFT JOIN actions ac            ON ac.action_index = a.action_index
     LEFT JOIN transactions t        ON t.tx_index      = ac.tx_index
     LEFT JOIN index_transactions it ON it.id           = t.tx_hash_id
     WHERE a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
       AND a.version IN (${CHECKPOINT_VERSIONS.map(() => '?').join(', ')})
     ORDER BY (a.version ${CHECKPOINT_SECTION_VERSIONS_SQL}) DESC, a.action_index DESC
     LIMIT ${ANCHOR_ROW_LIMIT}`;

// The usable continuation chunks one publisher sent for one archive batch: rejected
// rows out, 'orphan' rows kept (a chunk can land before its head), ordered so the
// caller's one-row-per-index dedupe is deterministic. Params: [batchSeq, author].
const ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL =
    `SELECT c.*, cadr.address AS source
     FROM anchor_actions c
     JOIN index_statuses s ON s.id = c.status_id
     LEFT JOIN actions         cact ON cact.action_index = c.action_index
     LEFT JOIN index_addresses cadr ON cadr.id           = cact.source_id
     WHERE c.version = 2 AND c.match_batch_seq = ? AND s.status NOT LIKE 'invalid:%'
       AND cadr.address = ?
     ORDER BY c.chunk_index ASC, c.action_index ASC`;

// Bound on the content-addressed head candidate set. Larger than ANCHOR_ROW_LIMIT
// because copies and re-broadcasts land extra rows under the same content key and
// the caller's own head must still be inside the window after its author filter.
const ARCHIVE_ANCHOR_ROW_LIMIT = 50;

// Archive heads for one batch identified by its content (checkpoint identity plus
// batch_crc32 and match_count), earliest first. Status is returned, never filtered,
// because an invalid head still spent the fee. Params: [chain, network, block_index,
// checkpoint_seq, batch_crc32, match_count].
const ARCHIVE_ANCHOR_BY_CONTENT_SQL =
    `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
            a.checkpoint_seq, a.snapshot_block, a.match_batch_seq, a.match_count,
            a.batch_crc32, a.total_chunks, a.block_index_doge, s.status,
            adr.address AS source, it.hash AS txid
     FROM anchor_actions a
     JOIN index_statuses s ON s.id = a.status_id
     LEFT JOIN actions            act ON act.action_index = a.action_index
     LEFT JOIN index_addresses    adr ON adr.id           = act.source_id
     LEFT JOIN transactions       t   ON t.tx_index       = act.tx_index
     LEFT JOIN index_transactions it  ON it.id            = t.tx_hash_id
     WHERE a.version ${ARCHIVE_HEAD_VERSIONS_SQL}
       AND a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
       AND a.batch_crc32 = ? AND a.match_count = ?
     ORDER BY a.action_index ASC
     LIMIT ${ARCHIVE_ANCHOR_ROW_LIMIT}`;

// The columns and joins the txid-keyed anchor read shares with its page-resumed twin.
// section_index is selected and ordered so rows inside one action come back in a
// fixed order and two anchors riding one transaction stay distinguishable.
const ANCHOR_BY_TXID_COLUMNS =
    `SELECT a.action_index, a.section_index, a.version, a.chain, a.network, a.block_index,
            a.checkpoint_seq, a.snapshot_block, a.publisher, a.match_batch_seq,
            a.block_index_doge, s.status, it.hash AS txid
     FROM index_transactions it
     JOIN transactions t   ON t.tx_hash_id  = it.id
     JOIN actions ac       ON ac.tx_index   = t.tx_index
     JOIN anchor_actions a ON a.action_index = ac.action_index
     JOIN index_statuses s ON s.id          = a.status_id`;

// Every anchor row a txid carries, first page. One row past the cap is fetched as a
// truncation probe. Params: [txid].
const ANCHOR_BY_TXID_SQL =
    `${ANCHOR_BY_TXID_COLUMNS}
     WHERE it.hash = ?
     ORDER BY a.action_index ASC, a.section_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

// The same read resumed after a page boundary. Params: [txid, after_action_index].
const ANCHOR_BY_TXID_AFTER_SQL =
    `${ANCHOR_BY_TXID_COLUMNS}
     WHERE it.hash = ? AND a.action_index > ?
     ORDER BY a.action_index ASC, a.section_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

module.exports = {
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL,
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_ANCHOR_ROW_LIMIT, ARCHIVE_ANCHOR_BY_CONTENT_SQL,
    ANCHOR_BY_TXID_COLUMNS, ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL
};
