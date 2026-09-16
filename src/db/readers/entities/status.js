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
 * XChain Explorer - /api/status
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). The one read that answers for every served coin at
 * once: indexed tip, decoder tip, supply, per-coin availability and the
 * freshness verdict that decides whether a coin is listed at all.
 *
 * It is alone in a part because it is the only reader that fans out across
 * coins rather than reading one entity, so it reaches the decoder and the
 * fail-closed staleness gate that no other entity read touches.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const DecoderConnector = require('../../../connectors/decoder.js');
const { staleFailClosed } = require('../../shared.js');

// The per-coin measurement maps a /status report carries, each empty until the loop
// below fills it. Split from the header fields only because the two together run
// past the length a function should have; the comments are the contract for what
// each map means, so they stay with the field they describe.
function statusMeasurementFields(){
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
        decoder_lag_blocks: {},
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
        tip_future_seconds: {},
        // Why the indexer trails, for consumers that must tell a consensus wait
        // apart from a wedge. tip_future_seconds cannot answer this: it measures
        // the block already committed, which is always past-dated, so it reads 0
        // throughout the wait. These measure the block being WAITED ON instead.
        // indexer_state: 'live' (lag 0), 'future_block_wait' (the next block is
        // dated ahead of this host's clock, so no node may commit it yet and the
        // pause is consensus, not failure), 'behind' (the next block is
        // admissible now and still uncommitted, the state worth paging on), or
        // null when it cannot be determined. indexer_wait_clears_at is the
        // instant a future_block_wait ends, so a UI can show a countdown instead
        // of an apparently lost transaction.
        indexer_state:               {},
        next_block_time:             {},
        next_block_future_seconds:   {},
        indexer_wait_clears_at:      {},
        stale:           {},
        // Durable consensus-divergence halt xchain-sync records into the same
        // replica DB this pool serves (sync_halt, cleared_at IS NULL = active).
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

// The /status report before any coin has been measured. A module function rather
// than a method: Database.prototype carries the family's public readers and
// nothing else, so a cut made for length adds no name to it. Same for the five
// below.
function statusReportSkeleton(coinConfigs, hubFetchedAtMs){
    return Object.assign({
        supported:       coinConfigs['COIN_SUPPORTED'],
        // Copied, not aliased: the staleness gate below deletes stale coins from
        // this map and must not mutate the shared hub-config object.
        available:       Object.assign({}, coinConfigs['COIN_AVAILABLE']),
        hub_config_fetched_at:  (hubFetchedAtMs != null) ? new Date(hubFetchedAtMs).toISOString() : null,
        hub_config_age_seconds: (hubFetchedAtMs != null) ? Math.floor((Date.now() - hubFetchedAtMs) / 1000) : null,
        last_block:      {},
        last_block_time: {},
    }, statusMeasurementFields());
}

// Where the indexer and the decoder each stand for one coin, and the gap between
// them.
async function measureIndexerPosition(db, data, coin){
    // /status is a health endpoint: a DB read now throws on failure
    // (M-4), but here we must still return the rest of the report
    // rather than 500 the whole thing, so a failed per-coin read
    // degrades to null for that coin (the outage is exactly what an
    // operator is checking status to see). Other endpoints let the
    // throw bubble to a 5xx.
    try {
        // Indexer position per coin: highest block index processed and its
        // block_time.
        data.last_block[coin]      = await db.getMaxBlockIndex({ coin, data: {} });
        data.last_block_time[coin] = await db.getMaxBlockTime({ coin, data: {} });
        // Decoder tip (decoder's highest processed block) and the gap to the
        // indexer. decoder_tip can be null when the decoder DB is
        // unreachable/unknown; decoder_lag_blocks is then null too. Clamp to
        // >= 0: the indexer reads from the decoder so it can never lead the
        // decoder's tip.
        let decoderTip = await db.getDecoderTip({ coin, data: {} });
        data.decoder_tip[coin]        = decoderTip;
        data.decoder_lag_blocks[coin] = (decoderTip === null) ? null : Math.max(0, decoderTip - data.last_block[coin]);
    } catch (e) {
        data.last_block[coin]         = null;
        data.last_block_time[coin]    = null;
        data.decoder_tip[coin]        = null;
        data.decoder_lag_blocks[coin] = null;
    }
}

// The age of a coin's newest indexed block, and how far ahead of this host's clock
// it is dated, as two non-negative fields.
function measureTipAge(data, coin, nowSec, tipSec){
    // Split the signed difference into two non-negative fields. The raw
    // subtraction went negative whenever a tip was dated ahead of this
    // host's clock, and a negative age passes every "older than X"
    // comparison a consumer writes, so a genuinely frozen coin read as
    // fresher than fresh. Age clamps at 0 and the skew is published
    // separately rather than being thrown away.
    let tipDelta = (Number.isFinite(Number(tipSec)) && Number(tipSec) > 0)
                        ? (nowSec - Number(tipSec)) : null;
    data.tip_age_seconds[coin]    = (tipDelta === null) ? null : Math.max(0, tipDelta);
    data.tip_future_seconds[coin] = (tipDelta === null) ? null : Math.max(0, -tipDelta);
}

// WHY a coin's indexer trails, read off the stamp of the block it is waiting on.
async function measureIndexerState(db, data, coin, nowSec){
    // Why the indexer is behind, not just that it is. A chain whose
    // timestamps are systematically future-dated (Bitcoin testnet4 rides
    // the 20-minute min-difficulty rule, stamping each block ~1201s after
    // its parent) makes the indexer hold every block until wall clock
    // reaches that block's OWN stamp. From outside that is
    // indistinguishable from a wedge, and it was misread as one. The
    // deciding value is the NEXT block's stamp: if it is still in the
    // future, no healthy node anywhere could have committed it yet.
    data.next_block_time[coin]            = null;
    data.next_block_future_seconds[coin]  = null;
    data.indexer_wait_clears_at[coin]     = null;
    data.indexer_state[coin]              = null;
    let lag = data.decoder_lag_blocks[coin];
    if (lag === 0) {
        data.indexer_state[coin] = 'live';
    } else if (lag !== null && Number.isFinite(Number(data.last_block[coin]))) {
        let nextTime = await db.getDecoderBlockTime({ coin, data: {} }, Number(data.last_block[coin]) + 1);
        data.next_block_time[coin] = nextTime;
        if (nextTime !== null) {
            let ahead = nextTime - nowSec;
            data.next_block_future_seconds[coin] = Math.max(0, ahead);
            if (ahead > 0) {
                // Waiting by consensus, and we can say exactly when it ends.
                data.indexer_state[coin]          = 'future_block_wait';
                data.indexer_wait_clears_at[coin] = new Date(nextTime * 1000).toISOString();
            } else {
                // The next block is admissible NOW and still uncommitted:
                // genuinely behind. This is the state that deserves alarm,
                // and the one a future-stamp wait was being mistaken for.
                data.indexer_state[coin] = 'behind';
            }
        }
    }
}

// Everything /status measures for one coin this instance actually holds a pool for.
async function measureCoinStatus(db, data, coin){
    await measureIndexerPosition(db, data, coin);
    // Fail closed on a frozen replica: a coin whose newest indexed block has
    // aged past its threshold stops being advertised as available, so a
    // consumer reading this map cannot mistake a 55-hour-old tip for live
    // data. Only coins this instance actually MEASURED are gated; a coin with
    // no pool here is the pre-existing "supported but not configured" case.
    let nowSec = Math.floor(Date.now() / 1000);
    let tipSec = data.last_block_time[coin];
    measureTipAge(data, coin, nowSec, tipSec);
    await measureIndexerState(db, data, coin, nowSec);
    data.stale[coin] = db.isTipStale(coin, tipSec, nowSec);
    // A stale coin stays listed in `available`: it IS served, with its
    // rows annotated (see staleFailClosed). The client reads `stale`,
    // tip_age_seconds, last_block and indexer_state to draw its degraded
    // banner. Only the fail-closed opt-in still delists it, because
    // there the data routes really do answer 503.
    if (data.stale[coin] && staleFailClosed(db.configInfo)) delete data.available[coin];
    // Published beside stale, not folded into it: a halted replica keeps
    // reporting a small lag until its source mints past it, so stale
    // detects it eventually and halted detects it immediately.
    data.replica_halted[coin] = await db.getReplicaHaltStatus(coin);
}

// Reads a route code (BTC / TBTC / RDOGE) as a base coin plus a network, against
// the prefixes and coins the loaded config declares.
function coinCodeParser(coinConfigs){
    let prefixes = coinConfigs['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
    let networks = coinConfigs['COIN_NETWORKS'] || {};
    return (code) => {
        code = String(code || '').toUpperCase();
        // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet coin named 'TBTC'.
        for(let network in prefixes){
            let p = prefixes[network];
            if(p && code.startsWith(p)){
                let base = code.slice(p.length);
                if(networks[base]) return { coin: base, network };
            }
        }
        if(networks[code]) return { coin: code, network: 'mainnet' };
        return null;
    };
}

// One coin's chain-visibility reading, from the decoder's own health() call.
async function measureDecoderHealth(db, data, code, parseCode){
    data.chain_tip[code]        = null;
    data.chain_lag_blocks[code] = null;
    let parsed = parseCode(code);
    // Per-chain endpoint from the loaded config first (setupConnectionPools),
    // so a hub-provisioned deployment reports real chain_tip / chain_lag_blocks
    // without nine DECODER_API_URL_<COIN>_<NETWORK> env vars; the specific env
    // var still overrides it, the generic one is still the last resort.
    let url    = DecoderConnector.resolveDecoderUrl(
                    parsed ? parsed.coin    : null,
                    parsed ? parsed.network : null,
                    (db.decoderApiUrl || {})[code] || null);
    if(!url){
        data.decoder_health[code] = 'unconfigured';
        return;
    }
    try {
        let h = await new DecoderConnector(url).health();
        // node_height_stale is set by the decoder when its coin-node RPC
        // has not refreshed for 2x the normal poll interval, meaning the
        // cached tip is frozen. In that state chain_tip and chain_lag_blocks
        // are misleading (lag reads as 0 while the chain may be advancing),
        // so we null them out and override health to 'node-stale' to make
        // the outage visible on the /status page.
        let tipStale = h && h.node_height_stale === true;
        // A decoder that has never completed getblockchaininfo reports
        // chainTipBlock -1 and a negative blockLag (its -1 tip sentinel),
        // and node_height_stale stays false because it never had a tip to
        // freeze. Publish unknown as null: a -1 tip is not a height, and
        // clamping the negative lag to 0 would read as "at the tip" for a
        // decoder that cannot see the chain. Prefer the decoder's own
        // null-when-unknown lag_blocks; fall back to blockLag for decoders
        // that predate it, treating a negative value as unknown.
        let tip = (h && !tipStale && typeof h.chainTipBlock === 'number' && h.chainTipBlock >= 0) ? h.chainTipBlock : null;
        let lag = null;
        if(h && !tipStale){
            if(Object.prototype.hasOwnProperty.call(h, 'lag_blocks')){
                lag = (typeof h.lag_blocks === 'number') ? h.lag_blocks : null;
            } else if(typeof h.blockLag === 'number' && h.blockLag >= 0){
                lag = h.blockLag;
            }
        }
        data.chain_tip[code]        = tip;
        data.chain_lag_blocks[code] = lag;
        data.decoder_health[code]   = tipStale ? 'node-stale' : ((h && h.status) ? h.status : 'unreachable');
    } catch(e){
        data.decoder_health[code] = 'unreachable';
    }
}

// The chain->decoder slice for every advertised coin, in parallel.
async function measureChainVisibility(db, data, coinConfigs, available){
    // Chain->decoder visibility: the slice the DB-derived fields above can't
    // see (the explorer never talks to a coin node, so a decoder stalled far
    // behind the chain still shows decoder_lag_blocks=0 once the indexer
    // catches up to its tip). Best-effort per coin via the decoder's own
    // health() JSON-RPC: chain_tip is the coin node's tip as the decoder
    // sees it, chain_lag_blocks the decoder's self-reported gap to it, and
    // decoder_health the decoder's own status ('healthy'/'unhealthy'),
    // 'unconfigured' when no endpoint resolves for the coin (neither the
    // loaded config nor DECODER_API_URL[_<COIN>_<NETWORK>]), or 'unreachable'
    // when the call fails. Calls run in parallel and are bounded by the
    // connector timeout so /status stays responsive.
    data.chain_tip        = {};
    data.chain_lag_blocks = {};
    data.decoder_health   = {};
    let parseCode = coinCodeParser(coinConfigs);
    await Promise.all(Object.keys(available).map((code) => measureDecoderHealth(db, data, code, parseCode)));
}

class EntityStatusReaders {
    async getStatus(config){
        let coinConfigs = await this.configInfo.getConfig();
        // Age of the explorer's last successful hub-config fetch. The explorer caches hub
        // config (in memory + on disk) and serves it even when the hub is unreachable, so a
        // climbing age here is the only signal that the served hub-derived config is stale.
        // null until the first successful fetch. getHubConfigFetchedAt may be absent against
        // an older config module; guard so /status never throws on the lookup.
        let hubFetchedAtMs = (typeof this.configInfo.getHubConfigFetchedAt === 'function')
                                ? this.configInfo.getHubConfigFetchedAt()
                                : null;
        let data = statusReportSkeleton(coinConfigs, hubFetchedAtMs);
        let available = coinConfigs['COIN_AVAILABLE'] || {};
        for (let coin of Object.keys(available)) {
            if (this.pools && this.pools[coin] && this.pools[coin].pool)
                await measureCoinStatus(this, data, coin);
        }
        await measureChainVisibility(this, data, coinConfigs, available);
        return [data];
    }
}

module.exports = EntityStatusReaders.prototype;
