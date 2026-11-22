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
 * XChain Explorer - the measurement fields of the /api/status report
 *
 * The per-coin maps every /status report carries before any coin is measured:
 * decoder tip and indexer gap, tip time, indexer wait and replica halt. status.js
 * seeds its report skeleton from them and nulls them again for a coin that
 * misses its deadline.
 *
 * A helper module rather than a reader part: it reads no database and adds no
 * name to Database.prototype.
 *
 ********************************************************************/

'use strict';

// Tracks the decoder tip and the indexer's distance from it for every coin.
function decoderMeasurementFields(){
    return {
        // Decoder-tip reference and indexer lag per coin. decoder_tip is the
        // decoder's highest *processed* block; decoder_lag_blocks is
        // decoder_tip - last_block, i.e. how far the indexer trails the decoder.
        // This is the indexer->decoder slice of the pipeline ONLY, not a
        // whole-pipeline health signal. The coin node's actual chain tip is not
        // visible here: the explorer reads only the indexer/decoder DBs and never
        // talks to a coin node, so a decoder that has fallen behind the chain node
        // (the chain->decoder gap) is NOT reflected in these fields. That gap is
        // surfaced separately below via chain_tip / chain_lag_blocks /
        // decoder_health, aggregated from each decoder's own health() JSON-RPC.
        // Both fields are null for a coin when the decoder tip is
        // unavailable; last_block/last_block_time are unaffected.
        decoder_tip:        {},
        decoder_lag_blocks: {}
    };
}

// Tracks each indexed tip's age and forward clock skew for every coin.
function tipTimeMeasurementFields(){
    return {
        // Wall-clock age of each measured coin's newest indexed block, and whether
        // that age has passed the coin's max tip age. Unlike decoder_lag_blocks these
        // see a JOINT indexer+decoder freeze, because they are measured against the
        // local clock rather than against the other replica.
        tip_age_seconds: {},
        // How far AHEAD of this host's clock each measured coin's newest
        // indexed block is dated, 0 when it is not ahead. Published because
        // tip_age_seconds is clamped at 0: without this field a future-dated
        // tip would be indistinguishable from a block mined this second, and
        // that skew is the thing an operator has to fix. null when block_time
        // is missing or unreadable, the same as tip_age_seconds.
        tip_future_seconds: {}
    };
}

// Tracks why the indexer is waiting and when that wait is expected to clear.
function indexerWaitMeasurementFields(){
    return {
        // Why the indexer trails, for consumers that must tell a consensus wait
        // apart from a wedge. tip_future_seconds cannot answer this: it measures
        // the block already committed, which is always past-dated, so it reads 0
        // throughout the wait. These measure the block being WAITED ON instead.
        // indexer_state: 'live' (lag 0), 'future_block_wait' (the next block is
        // dated ahead of this host's clock, so no node may commit it yet and the
        // pause is consensus, not failure), 'behind' (the next block is
        // admissible now and still uncommitted, including while held on an
        // oracle-sync barrier or while the indexer is simply slow), or null
        // when it cannot be determined. indexer_wait_clears_at is the clear instant of a
        // future wait, or of a 'behind' barrier the indexer still reports as ahead.
        indexer_state:               {},
        next_block_time:             {},
        next_block_future_seconds:   {},
        indexer_wait_clears_at:      {},
        stale:                       {}
    };
}

// Tracks active consensus-divergence halts for every replica.
function replicaHaltMeasurementFields(){
    return {
        // Durable consensus-divergence halt xchain-sync records into the indexer
        // or decoder replica DB (sync_halt, cleared_at IS NULL = active).
        // A halted replica applies no further blocks but keeps reporting a
        // small lag until its source mints past it, so neither stale nor
        // tip_age_seconds can see it; this is the only fail-closed signal that
        // can. true = an active halt row exists; false = the table was read
        // successfully and holds none; null = the signal could not be
        // determined (no pool, table absent, or a failed read) and MUST NOT
        // collapse to false, since a consumer reads false as healthy.
        replica_halted:  {}
    };
}

// Builds the per-coin maps that the status loop fills without exposing helpers.
function statusMeasurementFields(){
    return Object.assign({},
        decoderMeasurementFields(),
        tipTimeMeasurementFields(),
        indexerWaitMeasurementFields(),
        replicaHaltMeasurementFields());
}

module.exports = { statusMeasurementFields };
