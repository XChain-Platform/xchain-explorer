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
 * XChain Explorer - one ANCHOR's composed detail
 *
 * One part of src/db/readers/xcall.js (the entry composes it through
 * composeReaderParts). getAnchor and the reads it is cut into, one per section
 * anchor_detail_render.js renders: identity, payload, bundle sections, archive
 * chunks, the covering checkpoint, the publisher election and the reward trail.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The anchor spine: the one anchor_actions row the QUERY names, or null. `db` is the
// Database instance getAnchor runs on, passed in because each section below is a plain
// function rather than a method, so cutting the reader up adds no name to
// Database.prototype.
async function readAnchorIdentity(db, config){
    let search = config.data.search;
    let numeric   = db.util.isNumeric(search);
    let predicate = numeric ? 'm.action_index=?' : 't2.hash=?';
    let key       = numeric ? Number(search) : String(search || '').toLowerCase();
    let rows = await db.doQuery(config,
        `SELECT
                a4.action,
                m.action_index,
                m.section_index,
                a1.action_format,
                m.version,
                m.chain,
                m.network,
                m.block_index,
                m.block_hash,
                m.ledger_hash,
                m.actions_hash,
                m.contract_hash,
                m.checkpoint_seq,
                m.snapshot_block,
                m.state_root,
                m.state_root_version,
                m.block_merkle_root,
                m.block_merkle_version,
                m.match_batch_seq,
                m.match_count,
                m.batch_crc32,
                m.total_chunks,
                m.chunk_index,
                CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                m.validator_signatures,
                m.publisher,
                m.publisher_attestations,
                m.block_index_doge,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                anchor_actions m
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
            WHERE ` + predicate + `
            ORDER BY m.action_index DESC, m.section_index ASC
            LIMIT 1`, [key]);
    return (rows && rows.length) ? rows[0] : null;
}

// The signature payload, parsed onto the spine row.
function parseAnchorPayload(db, row){
    row.validator_signatures   = db.parseSignaturesArray(row.validator_signatures);
    // The v4/v5/v6 XANCPUB tail is RAW WIRE transport, not the quorum-verified subset
    // (anchor_actions.sql), so it is parsed for display and named as attestations to
    // re-verify, never presented as a verified quorum.
    row.publisher_attestations = db.parseSignaturesArray(row.publisher_attestations);
}

// The bundle sections a v0 carries, and the bundle-level snapshot_block they fix.
async function readAnchorSections(db, config, row, limit){
    // A v0 ANCHOR is a BUNDLE: one action carrying every checkpointed chain, stored as
    // N sibling rows sharing one action_index at section_index 0..N-1. Each row holds
    // its OWN chain, block_index, checkpoint_seq, roots and validator signatures; the
    // bundle-level fields (version, network, publisher, publisher_attestations, status,
    // txid, the DOGE block it landed in) are denormalized identically onto every row,
    // which is why the spine above can serve as the header no matter which section it
    // matched. Archive rows (v1/v2) and every retired per-chain version stay at
    // section_index 0, so they take no second query at all.
    //
    // snapshot_block on the header is the BUNDLE's block, the MAX over the sections: a
    // chain that lagged rides at its own older SECTION_SNAPSHOT_BLOCK, but the election
    // and the publisher attestation were both drawn at the MAX. Reading section 0's
    // block as the bundle's would look the electorate up at the wrong height.
    row.sections      = [];
    row.section_count = 1;
    if(Number(row.version) === 0){
        let sections = await db.doQuery(config,
            `SELECT
                    m.section_index,
                    m.chain,
                    m.network,
                    m.block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.action_index=?
                ORDER BY m.section_index ASC
                LIMIT ` + limit, [Number(row.action_index)]) || [];
        row.sections = sections.map(s => {
            s.validator_signatures = db.parseSignaturesArray(s.validator_signatures);
            return s;
        });
        if(row.sections.length){
            row.section_count = row.sections.length;
            let blocks = row.sections
                .map(s => db.util.isNull(s.snapshot_block) ? null : Number(s.snapshot_block))
                .filter(v => v !== null);
            if(blocks.length) row.snapshot_block = Math.max(...blocks);
        }
    }
}

// The archive continuation chunks this anchor is part of, empty for every anchor that
// carries no archive batch.
async function readAnchorChunks(db, config, row, limit){
    // Continuation chunks (v2) share the archive batch id. Bounded: a large archive
    // splits into as many chunks as it needs, so this list has no natural ceiling.
    let chunks = [];
    if(!db.util.isNull(row.match_batch_seq))
        chunks = await db.doQuery(config,
            `SELECT
                    m.action_index,
                    m.version,
                    m.chunk_index,
                    m.total_chunks,
                    CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                    m.block_index_doge,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.match_batch_seq=?
                ORDER BY m.chunk_index ASC
                LIMIT ` + limit, [row.match_batch_seq]) || [];
    return chunks;
}

// The hub-mirrored state_checkpoints row covering the height this anchor commits to,
// as a zero- or one-row array.
async function readCoveringCheckpoint(db, config, row, src){
    let scFilter    = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
    let latest      = db.latestCheckpointPredicate(src, 'sc');
    // The anchor names the CHECKPOINTED height on the CHECKPOINTED chain, which is what
    // state_checkpoints is keyed by too, so this coin's own (chain, network) identity is
    // the right filter here (the same reasoning getCommitments' anchor leg carries).
    //
    // A BUNDLE carries several chains at once, so the height to look up is THIS coin's
    // own section, not whichever section the spine happened to match. Keying a
    // chain-filtered mirror query by another chain's height cannot error: it returns
    // zero rows, and the page then reads a perfectly good bundle as uncovered.
    let localSection = row.sections.find(s =>
        String(s.chain || '').toUpperCase() === String(src.filterParams[0] || '').toUpperCase()) || null;
    let coveredHeight = localSection ? localSection.block_index : row.block_index;
    row.local_section_index = localSection ? localSection.section_index : null;
    let checkpoint = [];
    if(!db.util.isNull(coveredHeight))
        checkpoint = await db.doQuery(config,
            `SELECT
                    sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash,
                    sc.actions_hash, sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                    sc.state_root, sc.state_root_version, sc.block_merkle_root,
                    sc.block_merkle_version, sc.validator_signatures, sc.created_at
                FROM ${src.table} sc
                WHERE sc.block_index = ?${scFilter}${latest.sql}
                LIMIT 1`, [Number(coveredHeight), ...src.filterParams, ...latest.params]) || [];
    return checkpoint;
}

// The publisher electorate at this anchor's snapshot block.
async function readPublisherElection(db, config, row, src, limit){
    // Publisher election. capability_snapshots is CHAIN-AGNOSTIC: no chain/network
    // filter is bound, matching getCapabilitySnapshots. 'oracle_publish' is the
    // capability the publisher election draws its set from.
    let electorate = [];
    if(!db.util.isNull(row.snapshot_block))
        electorate = await db.doQuery(config,
            `SELECT
                    m.signing_pubkey,
                    m.amount,
                    m.source
                FROM ${src.capTable} m
                WHERE m.snapshot_block=? AND m.capability=?
                ORDER BY m.id ASC
                LIMIT ` + limit, [Number(row.snapshot_block), 'oracle_publish']) || [];
    return electorate;
}

// The reward attestations attributable to this anchor, by proof or by inference.
async function readRewardTrail(db, config, row, src, limit){
    // Reward trail. CHAIN-SCOPED, so filterParams lead. Correlated on the mined DOGE
    // txid this anchor landed in, OR on the table's own natural key minus publisher
    // (snapshot_block + the round this anchor closed: checkpoint_seq for a checkpoint
    // anchor, match_batch_seq for an archive one, the SNAPSHOT BLOCK itself for a v0
    // bundle, whose single anchor_bundle reward is keyed round_reference =
    // SNAPSHOT_BLOCK rather than to any one section's checkpoint_seq).
    let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
    let rounds = [row.checkpoint_seq, row.match_batch_seq,
                  (Number(row.version) === 0) ? row.snapshot_block : null]
        .filter(v => !db.util.isNull(v)).map(v => Number(v));
    let rewardWhere = 'm.doge_anchor_txid=?';
    let rewardArgs  = [...src.filterParams, row.tx_hash];
    if(rounds.length && !db.util.isNull(row.snapshot_block)){
        rewardWhere += ` OR (m.snapshot_block=? AND m.round_reference IN (${rounds.map(() => '?').join(',')}))`;
        rewardArgs.push(Number(row.snapshot_block), ...rounds);
    }
    let rewards = await db.doQuery(config,
        `SELECT
                m.id,
                m.chain,
                m.network,
                m.reward_type,
                m.round_reference,
                m.snapshot_block,
                m.publisher,
                m.reward_amount,
                m.doge_anchor_txid,
                m.created_at
            FROM ${src.rewardTable} m
            WHERE 1=1` + outerFilter + ` AND (` + rewardWhere + `)
            ORDER BY m.id DESC
            LIMIT ` + limit, rewardArgs) || [];
    return rewards;
}

class AnchorReaders {
    // Composed ANCHOR detail (M4.5). QUERY is the ANCHOR's action_index, or the DOGE
    // transaction hash it landed in. The two are told apart in JS rather than bound into one
    // OR: action_index is a BIGINT column and a 64-hex hash compared against it is coerced,
    // not matched, so an OR would answer 0 rows for the hash form without erroring.
    //
    // Three legs beyond the payload, and each reads a DIFFERENT source:
    //   - the covering hub-mirror state_checkpoints row, through the SAME correlated
    //     latest-checkpoint_seq-per-height predicate getCheckpoints/getCommitments use
    //     (latestCheckpointPredicate), never a fourth differently-bounded variant;
    //   - the publisher ELECTION, from capability_snapshots at this anchor's snapshot_block.
    //     That table is CHAIN-AGNOSTIC (no chain/network columns; its key is
    //     snapshot_block+capability+signing_pubkey+source), so src.filter/filterParams are
    //     deliberately NOT bound to it;
    //   - the reward-attestation trail, from anchor_reward_attestations, which IS
    //     chain-scoped (chain/network are in uq_reward_tuple), so the same src.filter IS
    //     bound there, first, exactly as getAnchorRewardAttestations binds it.
    // Getting that asymmetry backwards yields a query that is silently wrong rather than one
    // that errors, in whichever direction the blanket rule was applied.
    //
    // archive_b64 is never selected. It is a MEDIUMTEXT gzip chunk with nothing legible in
    // it; its LENGTH and crc32 are what a reader can actually check an archive against.
    async getAnchor(config){
        let limit = this.detailLimit(config);
        let row   = await readAnchorIdentity(this, config);
        if(!row) return [null];
        parseAnchorPayload(this, row);
        await readAnchorSections(this, config, row, limit);
        let chunks = await readAnchorChunks(this, config, row, limit);

        let src        = this.checkpointSource(config);
        let checkpoint = await readCoveringCheckpoint(this, config, row, src);
        let electorate = await readPublisherElection(this, config, row, src, limit);
        let rewards    = await readRewardTrail(this, config, row, src, limit);

        row.chunks             = chunks;
        row.checkpoint         = (checkpoint.length) ? this.normalizeCheckpointRows(checkpoint)[0] : null;
        row.publisher_election = electorate;
        row.reward_attestations = rewards;
        return [row];
    }
}

module.exports = AnchorReaders.prototype;
