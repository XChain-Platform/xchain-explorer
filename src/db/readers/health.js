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
 * XChain Explorer - freshness, mempool, fee and price readers
 *
 * Proposal B stage 4: everything that answers "is what this instance is serving
 * current, and what does it cost right now". The tip probes the WebSocket
 * ChangeDetector polls every cycle, the staleness and future-skew thresholds and
 * the per-coin freshness snapshot built from them, the replica-halt check, the
 * decoder tip and mempool reads, and the fee and price lookups.
 *
 * The thresholds live here rather than in config because every one of them has a
 * per-coin override and a documented default, and the method that reads the
 * override is the one that owns the fallback.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const DecoderConnector = require('../../XChainDecoderConnector.js');
const { DbQueryError, staleFailClosed } = require('../shared.js');

// Wall-clock age, in seconds, past which the newest INDEXED block means this
// instance is no longer serving current data for a coin. Deliberately far above
// every chain's normal inter-block gap (BTC ~10min): a fail-closed gate that
// delists a quiet-but-healthy chain is worse than one that trails an outage by
// hours, and the freezes this catches ran 55 hours and 33 days in practice.
const TIP_MAX_AGE_DEFAULT_S = 21600;

// How far AHEAD of this host's clock a newest-indexed block may be dated before
// its timestamp stops counting as evidence of freshness. A future-dated tip
// makes (now - block_time) negative, which reads as "younger than any
// threshold", so a frozen chain can hide behind one for as long as the skew
// lasts: with no bound, a tip dated a year ahead would never age out. 7200s is
// the BTC-family consensus limit on how far ahead of network-adjusted time a
// block may be dated, so a tip beyond it is host clock drift or a chain the
// timestamp rules do not bind (testnet), neither of which this instance can
// vouch for. Overridable per coin, 0 disables the check.
const TIP_MAX_FUTURE_SKEW_DEFAULT_S = 7200;

// TTL of the cached per-coin freshness snapshot (tip block, tip age, stale
// verdict, replica halt). Short enough that a freeze surfaces within one status
// poll, long enough that annotating every response costs no extra query on a
// busy explorer.
const TIP_STALE_CACHE_TTL_MS = 15000;

class HealthReaders {
    /******************************************************************
     * WebSocket Change Detection Queries
     *
     * Lightweight queries used by the ChangeDetector to poll for new
     * blocks and actions. These are designed to be fast (index-only
     * where possible) and are called every poll cycle.
     *****************************************************************/

    async getMaxBlockIndex(config) {
        let query   = `SELECT MAX(block_index) as max_index FROM blocks`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].max_index !== null)
            return Number(results[0].max_index);
        return 0;
    }

    // Get the block_time of the highest (tip) block in the blocks table.
    // Used as the deterministic "now" for display-side activation checks so the
    // result matches the indexer's consensus logic (which uses block_time) and is
    // identical across explorer hosts irrespective of local wall-clock.
    async getMaxBlockTime(config) {
        let query   = `SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].block_time !== null)
            return Number(results[0].block_time);
        return 0;
    }

    // Max tip age for a coin, in seconds: EXPLORER_TIP_MAX_AGE_S_<COIN> if set,
    // else EXPLORER_TIP_MAX_AGE_S, else the default. An explicit 0 disables the
    // gate for that coin, the same operator escape hatch MIRROR_MAX_LAG_S has; a
    // regtest instance, where blocks are mined on demand, wants that.
    /**
     * @param {string} coin coin code, e.g. 'BTC' or 'TLTC'
     * @returns {number} max age in seconds, 0 when the gate is disabled
     */
    tipMaxAgeSeconds(coin) {
        let perCoin = parseInt(process.env['EXPLORER_TIP_MAX_AGE_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(process.env.EXPLORER_TIP_MAX_AGE_S, 10);
        if (Number.isFinite(global) && global >= 0) return global;
        return TIP_MAX_AGE_DEFAULT_S;
    }

    // Max future skew for a coin, in seconds: EXPLORER_TIP_MAX_FUTURE_SKEW_S_<COIN>
    // if set, else EXPLORER_TIP_MAX_FUTURE_SKEW_S, else the default. An explicit 0
    // disables the future-tip check for that coin, the same escape hatch
    // EXPLORER_TIP_MAX_AGE_S has for the age check.
    /**
     * @param {string} coin coin code, e.g. 'BTC' or 'TBTC'
     * @returns {number} max future skew in seconds, 0 when the check is disabled
     */
    tipMaxFutureSkewSeconds(coin) {
        let perCoin = parseInt(process.env['EXPLORER_TIP_MAX_FUTURE_SKEW_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S, 10);
        if (Number.isFinite(global) && global >= 0) return global;
        return TIP_MAX_FUTURE_SKEW_DEFAULT_S;
    }

    // Is the newest indexed block old enough that this coin's data is not current?
    // Fails closed on a missing, zero, or unparseable block_time, which is what a
    // never-bootstrapped or unreadable replica looks like. decoder_lag_blocks
    // cannot see this: it is an intra-replica difference that reads 0 whenever the
    // indexer and decoder freeze together.
    //
    // A tip dated far AHEAD of this host also fails closed. Its age is negative,
    // which clears the age gate by a margin that grows with the skew, so an
    // unbounded future timestamp is a permanent freshness alibi for a coin that
    // has stopped advancing. Skew within tipMaxFutureSkewSeconds is tolerated
    // so ordinary clock drift and lax testnet timestamp rules do not delist a
    // healthy chain.
    /**
     * @param {string} coin coin code
     * @param {number|null} blockTimeSec unix seconds of the newest indexed block
     * @param {number} [nowSec] unix seconds to measure against, defaults to now
     * @returns {boolean}
     */
    isTipStale(coin, blockTimeSec, nowSec) {
        let maxAge = this.tipMaxAgeSeconds(coin);
        if (maxAge === 0) return false;
        let tip = Number(blockTimeSec);
        if (!Number.isFinite(tip) || tip <= 0) return true;
        let now = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
        let delta = now - tip;
        if (delta < 0) {
            let maxSkew = this.tipMaxFutureSkewSeconds(coin);
            return (maxSkew !== 0) && (-delta > maxSkew);
        }
        return delta > maxAge;
    }

    // Whether a stale coin is refused (503 COIN_DATA_STALE, delisted from
    // /status `available`, WS replay/snapshot errors) rather than served with a
    // freshness marker. Off by default; see staleFailClosed for why.
    /**
     * @returns {boolean}
     */
    staleFailClosed() {
        return staleFailClosed();
    }

    // Cached per-coin freshness snapshot: the newest indexed block, how old it is
    // against this host's clock, whether that age passes the coin's stale
    // threshold, and whether the replica carries an active sync halt. This is
    // what every data response is annotated with (XChainExplorer.processRequest)
    // and what the WS serving boundaries read, so it is one cache fill per coin
    // per TIP_STALE_CACHE_TTL_MS rather than a query per request. An unreadable
    // indexer reads as stale with null tip fields: the marker exists to say this
    // instance cannot vouch for the tip, and an unreadable one is the clearest
    // case of that.
    /**
     * @param {string} coin coin code
     * @returns {Promise<{stale: boolean, tip_block: number|null, tip_time: number|null,
     *   tip_age_seconds: number|null, replica_halted: boolean|null, max_age_seconds: number}>}
     */
    async getCoinFreshness(coin) {
        if (!this._tipStaleCache) this._tipStaleCache = {};
        const cached = this._tipStaleCache[coin];
        if (cached && (Date.now() - cached.at) < TIP_STALE_CACHE_TTL_MS) return cached.snapshot;
        let snapshot = {
            stale:           this.tipMaxAgeSeconds(coin) !== 0,
            tip_block:       null,
            tip_time:        null,
            tip_age_seconds: null,
            replica_halted:  null,
            max_age_seconds: this.tipMaxAgeSeconds(coin)
        };
        try {
            let tipSec = await this.getMaxBlockTime({ coin, data: {} });
            let nowSec = Math.floor(Date.now() / 1000);
            snapshot.stale = this.isTipStale(coin, tipSec, nowSec);
            if (Number.isFinite(Number(tipSec)) && Number(tipSec) > 0) {
                snapshot.tip_time        = Number(tipSec);
                snapshot.tip_age_seconds = Math.max(0, nowSec - Number(tipSec));
            }
            snapshot.tip_block = await this.getMaxBlockIndex({ coin, data: {} });
        } catch (e) {
            // Leave the fail-closed defaults: stale unless the gate is disabled,
            // and no tip to report.
        }
        // The halt signal is only worth a query while the tip is already stale:
        // a fresh tip means the replica is applying blocks, so it cannot be
        // halted, and the banner only needs the reason once there is one.
        if (snapshot.stale) {
            try { snapshot.replica_halted = await this.getReplicaHaltStatus(coin); }
            catch (e) { snapshot.replica_halted = null; }
        } else {
            snapshot.replica_halted = false;
        }
        this._tipStaleCache[coin] = { at: Date.now(), snapshot };
        return snapshot;
    }

    // Cached tip-staleness verdict, the boolean view of getCoinFreshness. An
    // unreadable indexer counts as stale: the marker exists to say this instance
    // cannot vouch for the tip as current.
    /**
     * @param {string} coin coin code
     * @returns {Promise<boolean>}
     */
    async isCoinTipStale(coin) {
        return (await this.getCoinFreshness(coin)).stale;
    }

    // Reads whether this coin's indexer replica carries an active
    // consensus-divergence halt (xchain-sync's sync_halt table, cleared_at IS
    // NULL). Checks table existence first via information_schema, a query that
    // always succeeds (0 rows, not an error) on a deployment whose DB predates
    // the sync client, so that ordinary case never hits the failure log below.
    // Returns true (active halt), false (table read, no active halt), or null
    // (no pool, table absent, or the read failed); null is never coerced to
    // false, since /status consumers read false as healthy.
    /**
     * @param {string} coin coin code
     * @returns {Promise<boolean|null>}
     */
    async getReplicaHaltStatus(coin) {
        let config = { coin, data: {} };
        let existing;
        try {
            existing = await this.doQuery(config,
                `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_halt' LIMIT 1`,
                []);
        } catch (e) {
            return null;
        }
        if (!existing || !existing.length) return null;
        try {
            let rows = await this.doQuery(config,
                `SELECT id FROM sync_halt WHERE db_type=? AND cleared_at IS NULL LIMIT 1`,
                ['indexer']);
            return !!(rows && rows.length);
        } catch (e) {
            return null;
        }
    }

    // Get the decoder-tip reference for a coin: the highest block the decoder has
    // *processed* for it. The explorer reads the indexer DB, whose MAX(block_index)
    // is the indexer's own position; the decoder DB's MAX(block_index) is the
    // decoder's position. Comparing the two yields the indexer->decoder lag, which
    // is what lets /api/status distinguish a stalled indexer from a healthy one.
    // NOTE: this is NOT the coin node's chain tip; the explorer never talks to a
    // coin node, so a decoder lagging the chain node is invisible here; that gap is
    // surfaced by the decoder's own health() JSON-RPC. Reuses the indexer connection
    // pool via a database-qualified query (the decoder DB is on the same server) and
    // returns null when the decoder DB name is unknown or the query fails, so status
    // degrades to "no tip" rather than erroring.
    async getDecoderTip(config) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        // dbName originates from hub/explorer config, not client input, but it is
        // interpolated into the query (database identifiers can't be bound), so
        // restrict it to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        try {
            let query   = 'SELECT MAX(block_index) as max_index FROM `' + dbName + '`.blocks';
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].max_index !== null)
                return Number(results[0].max_index);
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant: omit the tip.
            console.warn('getDecoderTip: decoder tip unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return null;
    }

    // Read the decoder's recorded block_time for ONE height. Exists to answer a
    // question tip_future_seconds structurally cannot: that field is derived from
    // the newest block the indexer has already COMMITTED, which is by definition
    // past-dated, so it reads 0 during the exact condition it looks like it would
    // reveal. The block that decides whether the indexer is waiting or wedged is
    // the NEXT one (last_block + 1), which only the decoder DB has, because the
    // indexer has not committed it yet. Same degradation contract as
    // getDecoderTip: null when the DB name is unknown, unsafe, or the read fails.
    async getDecoderBlockTime(config, height) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        if(!Number.isFinite(Number(height))) return null;
        try {
            let query   = 'SELECT block_time FROM `' + dbName + '`.blocks WHERE block_index = ? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [Number(height)]);
            if (results && results.length && results[0].block_time !== null)
                return Number(results[0].block_time);
        } catch(e){
            console.warn('getDecoderBlockTime: decoder block_time unavailable for ' + config.coin + ' at ' + height + ': ' + (e && e.message ? e.message : e));
        }
        return null;
    }

    // Split a route code (TBTC / RDOGE / BTC) into { coin, network } using the
    // loaded config's COIN_PREFIXES/COIN_NETWORKS. Returns null when the code
    // doesn't parse (config momentarily unavailable, or an unknown base coin).
    async _parseCoinCode(code){
        try {
            let full     = await this.configInfo.getConfig();
            let networks = full['COIN_NETWORKS'] || {};
            let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
            let upper    = String(code || '').toUpperCase();
            // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet
            // coin named 'TBTC' (same rule as getStatus's parseCode).
            for(let network in prefixes){
                let p = prefixes[network];
                if(p && upper.startsWith(p)){
                    let base = upper.slice(p.length);
                    if(networks[base]) return { coin: base, network };
                }
            }
            if(networks[upper]) return { coin: upper, network: 'mainnet' };
        } catch(e){ /* fall through to null */ }
        return null;
    }

    // Live mempool snapshot over the decoder's JSON-RPC API (getmempool), the
    // ONLY live-mempool path for an explorer serving from synced replicas:
    // mempool_transactions is deliberately excluded from xchain-sync replication
    // (node-local, non-deterministic), so on a replica deployment the colocated
    // decoder-DB reads below see a permanently empty table. When a decoder API
    // endpoint resolves for the coin (DECODER_API_URL_<COIN>_<NETWORK> >
    // config-derived decoderApiUrl > DECODER_API_URL, same chain as /status's
    // decoder_health), this snapshot is preferred by the mempool readers; a
    // deployment with no endpoint (e.g. a single-box regtest stack whose decoder
    // DB is truly colocated) falls back to the direct DB path unchanged.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s), stale-served on
    // fetch failure for one extra TTL so one decoder hiccup doesn't blank the
    // homepage counter. Returns { node_tx_count, total, rows } or null when
    // unconfigured/unreachable with nothing cached.
    async _getDecoderMempoolSnapshot(config){
        const code = config.coin;
        const ttl  = parseInt(process.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
        const now  = Date.now();
        this._mempoolApiCache = this._mempoolApiCache || {};
        const hit = this._mempoolApiCache[code];
        if(hit && (now - hit.t) < ttl) return hit.v;
        let parsed = await this._parseCoinCode(code);
        let url    = DecoderConnector.resolveDecoderUrl(
                        parsed ? parsed.coin    : null,
                        parsed ? parsed.network : null,
                        (this.decoderApiUrl || {})[code] || null);
        if(!url) return null;
        try {
            let r = await new DecoderConnector(url).getmempool(500);
            let v = (r && Array.isArray(r.rows)) ? {
                node_tx_count: (typeof r.node_tx_count === 'number' && r.node_tx_count >= 0) ? r.node_tx_count : null,
                total:         Number(r.total) || 0,
                rows:          r.rows
            } : null;
            this._mempoolApiCache[code] = { t: now, v };
            return v;
        } catch(e){
            console.warn('_getDecoderMempoolSnapshot: decoder mempool unavailable for ' + code + ': ' + (e && e.message ? e.message : e));
            // Serve the stale snapshot once more; refresh the clock so a dead
            // decoder is retried once per TTL, not on every request.
            this._mempoolApiCache[code] = { t: now, v: (hit && hit.v) || null };
            return (hit && hit.v) || null;
        }
    }

    // The coin node's TOTAL mempool tx count (XChain-carrying or not), from the
    // decoder API snapshot. null when no decoder API is configured/reachable or
    // the decoder hasn't completed a mempool poll yet: the DB paths below cannot
    // know this number (the decoder DB only holds the XChain-carrying subset),
    // so there is deliberately no fallback and callers render null as absent.
    async getNodeMempoolCount(config){
        let snap = await this._getDecoderMempoolSnapshot(config);
        return (snap && typeof snap.node_tx_count === 'number') ? snap.node_tx_count : null;
    }

    // Count of unconfirmed (mempool) transactions for this coin: the decoder
    // API snapshot when one resolves (see _getDecoderMempoolSnapshot), else the
    // decoder DB's mempool_transactions table. Same access pattern + safety as
    // getDecoderTip (DB-qualified query on the indexer pool; only works when the
    // decoder DB shares the indexer's server/credentials). Returns 0 when the
    // decoder DB isn't reachable so callers always get a usable number.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s, same pattern as
    // getFeeEstimate's _feeCache): the count backs the unauthenticated coin
    // homepage / network stats, and an uncached COUNT(*) on a busy mempool table
    // is a full-scan the public read path can be made to repeat on every hit.
    // A stale prior value is served when the query fails mid-flight.
    async getDecoderMempoolCount(config) {
        let snap = await this._getDecoderMempoolSnapshot(config);
        if(snap) return snap.total;
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return 0;
        // dbName is config-derived, not client input, but database identifiers
        // can't be bound; restrict to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return 0;
        const ttl = parseInt(process.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
        const now = Date.now();
        this._mempoolCountCache = this._mempoolCountCache || {};
        const hit = this._mempoolCountCache[config.coin];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            // Action-carrying rows only. mempool_transactions holds a row for
            // EVERY mempool tx the decoder saw, with `data` blanked to '' when
            // the tx carried no valid ACTION (nearly all of them on a public
            // chain), so a bare COUNT(*) publishes the node's whole mempool as
            // the XChain unconfirmed count. Matches what the feed renders,
            // since decodeMempoolRow drops the same rows.
            let query   = 'SELECT COUNT(*) as count FROM `' + dbName + '`.mempool_transactions' +
                          " WHERE data IS NOT NULL AND data != ''";
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].count !== null){
                const v = Number(results[0].count);
                this._mempoolCountCache[config.coin] = { t: now, v };
                return v;
            }
        } catch(e){
            // Decoder DB unreachable, missing table, or no cross-DB grant: serve the
            // last good count if we have one, else report 0.
            console.warn('getDecoderMempoolCount: mempool count unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return (hit && hit.v) || 0;
    }

    // Raw unconfirmed (mempool) action rows from the decoder DB. As of the
    // 2026-06-15 mempool-raw-strings migration, mempool_transactions stores the
    // tx hash and source address as raw string columns (tx_hash, source) rather
    // than FK ids into the decoder's index tables, so the row reads directly with
    // no joins. Rows are PRE-VALIDATION: the decoder writes whatever parses out of
    // a mempool tx; the indexer may still reject it at confirmation time.
    // mempool_transactions DOES declare a `destination` column (indexed as
    // mempool_destination) and the decoder binds it on every insert, but the
    // bound value is always NULL: XChainDecoder.parseTransaction's only success
    // return hardcodes destination:null. Destinations live inside the decoded
    // action string (`data`), which callers parse. Do NOT move getMempool's
    // type=address filter onto that index: it would match zero rows. Same
    // access pattern + safety rules as getDecoderMempoolCount. Returns [] when
    // the decoder DB isn't reachable.
    //
    // ENCODING: mempool_transactions.data is a MEDIUMTEXT utf8mb4 column holding
    // the canonical UTF-8 ACTION string ("SEND|0|TICK|..."), the exact same
    // representation the decoder's confirmed-block path writes to
    // transactions.data. It is NOT hex. The decoder pins that contract in
    // test/unit/mempoolPayloadRepresentation.test.js (uuid:26220713); this read
    // and decodeMempoolRow below are the other half of it.
    async getDecoderMempoolRows(config, limit) {
        let max = Math.max(1, Math.min(Number(limit) || 200, 500));
        // Live path first: the decoder API snapshot (see _getDecoderMempoolSnapshot).
        // Its rows carry the same tx_hash/source/data shape this method's DB path
        // returns, plus first_seen (unix seconds, from the decoder's own table).
        let snap = await this._getDecoderMempoolSnapshot(config);
        if(snap) return snap.rows.slice(0, max);
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return [];
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return [];
        try {
            // ORDER BY the unique-indexed tx_hash: the table has no primary key
            // and the decoder rewrites it every cycle, so a bare LIMIT returns a
            // scan-order subset that churns between polls. The ws mempool diff
            // and /api/mempool paging both read this window as a stable snapshot.
            // first_seen: UNIX_TIMESTAMP so both paths hand callers the same
            // integer-seconds representation the decoder API serves.
            // Action-carrying rows only (same filter + rationale as
            // getDecoderMempoolCount): an unfiltered window fills all 500 slots
            // with actionless rows on a busy chain and renders an empty feed
            // while real pending actions sit deeper in the table.
            let query = 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data, ' +
                        'UNIX_TIMESTAMP(m.first_seen) AS first_seen ' +
                        'FROM `' + dbName + '`.mempool_transactions m ' +
                        "WHERE m.data IS NOT NULL AND m.data != '' " +
                        'ORDER BY m.tx_hash ' +
                        'LIMIT ' + max;
            let results = await this.doDecoderQuery(config, query, []);
            return results || [];
        } catch(e){
            // errno 1054: a decoder DB from before the 2026-08-22-mempool-first-seen
            // migration has no first_seen column. Retry without it (Time renders
            // as absent) instead of blanking the whole feed until the decoder
            // restarts and auto-applies its migration. doQuery wraps the driver
            // error in DbQueryError with the original on `cause`, so check both.
            let errno = (e && e.errno) || (e && e.cause && e.cause.errno);
            if(errno == 1054){
                try {
                    let query = 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data ' +
                                'FROM `' + dbName + '`.mempool_transactions m ' +
                                "WHERE m.data IS NOT NULL AND m.data != '' " +
                                'ORDER BY m.tx_hash ' +
                                'LIMIT ' + max;
                    let results = await this.doDecoderQuery(config, query, []);
                    return results || [];
                } catch(e2){
                    console.warn('getDecoderMempoolRows: mempool rows unavailable for ' + config.coin + ': ' + (e2 && e2.message ? e2.message : e2));
                    return [];
                }
            }
            console.warn('getDecoderMempoolRows: mempool rows unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return [];
    }

    // Split one decoder mempool row's action string into its parts. The column
    // already holds the canonical UTF-8 ACTION string (see the encoding note on
    // getDecoderMempoolRows), so there is nothing to decode: the wire layout is
    // pipe-joined with the action name first (e.g.
    // SEND|0|TICK|AMOUNT|DESTINATION|MEMO). Returns null on garbage, which also
    // covers the decoder's rejected-ACTION sentinel (an empty string written for
    // a money-bearing tx whose ACTION was invalid or unknown) and any legacy
    // hex-encoded row left behind by an older decoder: neither yields a
    // valid leading action name, so both drop out of the feed rather than
    // rendering as mojibake.
    decodeMempoolRow(row) {
        try {
            if(!row || this.util.isNull(row.data)) return null;
            // Buffer only if a driver hands back the TEXT column as binary.
            let text = Buffer.isBuffer(row.data) ? row.data.toString('utf8') : String(row.data);
            if(!text.length) return null;
            let segments = text.split('|');
            let action = String(segments[0] || '').trim().toUpperCase();
            if(!/^[A-Z_]{2,32}$/.test(action)) return null;
            return {
                tx_hash: row.tx_hash || null,
                source:  row.source || null,
                action:  action,
                data:    text,
                // Unix seconds when the decoder first observed the tx in its
                // node's mempool; null against a pre-first_seen decoder DB.
                first_seen: this.util.isNumeric(row.first_seen) ? Number(row.first_seen) : null
            };
        } catch(e){
            return null;
        }
    }

    // Split a decoded mempool row's action string into its pipe-joined segments.
    // Deliberately layout-free: the field map differs per action family and only
    // SEND has a documented one, so every consumer scans segments instead of
    // reading positions. Returns [] for a row with no action string (the
    // ChangeDetector's removal path carries `data: null` for a row that never
    // decoded), so callers never have to null-check first.
    mempoolSegments(decoded) {
        if(!decoded || this.util.isNull(decoded.data)) return [];
        let text = Buffer.isBuffer(decoded.data) ? decoded.data.toString('utf8') : String(decoded.data);
        return text.split('|');
    }

    // Does this decoded mempool row involve `address`? THE one matcher for
    // "who does this unconfirmed tx affect", shared by the REST prefilter
    // (getMempool TYPE=address) and the WS fan-out (Broadcaster mempool
    // frames). Sharing it is the point: the poll and the live event must never
    // disagree about the parties to a tx, or a wallet sees a pending row that
    // no event ever removes (or the reverse).
    //
    // `addressId` is the address's index id from the cached BYTE-EXACT resolver
    // (getExactAddressId), or null when it has none. Byte-exact is a correctness
    // requirement of this matcher and not a style choice: the ci resolver would
    // hand a case variant the id of the address it resembles, and the `^<id>`
    // branch below would then name it a party to a transaction it has no part in.
    // It is what makes a compacted destination match:
    // the SDK writes destinations as `^<id>` references by default
    // (addressResolver), so without this branch an incoming pending payment to
    // an address that already holds an index id is invisible on both surfaces. Resolution
    // is FORWARD (address -> id) on purpose; no id -> address lookup exists in
    // the explorer and none is needed, since both call sites hold the address.
    //
    // Known false-positive class, accepted: a non-destination segment (a memo)
    // whose text equals the address matches. See the accepted-limitations note
    // in the /api/mempool endpoint header.
    mempoolRowMatchesAddress(decoded, address, addressId) {
        if(!decoded || this.util.isNull(address)) return false;
        let search = String(address);
        if(!search.length) return false;
        if(decoded.source === search) return true;
        let segments = this.mempoolSegments(decoded);
        if(segments.includes(search)) return true;
        if(this.util.isNull(addressId)) return false;
        return segments.includes('^' + String(addressId));
    }

    // Suggested fee tiers (sat/vByte) for this coin, fetched from its encoder's
    // `estimatefee` JSON-RPC method (which reads the node's estimatesmartfee).
    // The explorer is DB-only and can't reach a node, so it asks the encoder.
    // Endpoint comes from ENCODER_URL (e.g. https://encoder.xchain.io); the coin
    // path is appended (.../{COIN}/). Result is cached per coin for FEE_CACHE_MS
    // (default 60s) so the coin homepage doesn't trigger a node RPC on every hit.
    // Returns a conservative {low:1,medium:2,high:3} fallback when no encoder is
    // configured or it's unreachable.
    async getFeeEstimate(config) {
        const fallback = { low: 1, medium: 2, high: 3 };
        const base = process.env.ENCODER_URL;
        if(!base) return fallback;
        const code = config.coin;
        const ttl  = parseInt(process.env.FEE_CACHE_MS, 10) || 60000;
        const now  = Date.now();
        this._feeCache = this._feeCache || {};
        const hit = this._feeCache[code];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const url = base.replace(/\/+$/, '') + '/' + encodeURIComponent(code) + '/';
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ jsonrpc: '2.0', method: 'estimate_fee', id: 1 }),
                signal:  AbortSignal.timeout(6000)
            });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const f = j && j.result;
            if(f && f.low != null && f.medium != null && f.high != null){
                const v = { low: Number(f.low), medium: Number(f.medium), high: Number(f.high) };
                this._feeCache[code] = { t: now, v };
                return v;
            }
            throw new Error('malformed estimatefee response');
        } catch(e){
            console.warn('getFeeEstimate: fee estimate unavailable for ' + code + ': ' + (e && e.message ? e.message : e));
            // Reuse a prior good value if we have one; otherwise the safe fallback.
            return (hit && hit.v) || fallback;
        }
    }

    // Live USD price for this coin, fetched from the xchain-hub price oracle
    // (its finalized price_snapshots, via the public `getprice` JSON-RPC). The
    // explorer has no market feed of its own. Endpoint comes from HUB_URL
    // (e.g. http://127.0.0.1:10000). Cached per base coin for PRICE_CACHE_MS
    // (default 60s) so the coin homepage doesn't hit the hub on every request.
    // Mirrors getFeeEstimate(). Only mainnet BTC/LTC/DOGE have an oracle market;
    // testnet/regtest route codes (TBTC, RDOGE, …) have no market, so this returns
    // null and getNetwork keeps the $0.00 placeholder. Returns a price string
    // (8-decimal, as published) or null.
    async getCoinPriceUsd(config) {
        const hubUrl = process.env.HUB_URL;
        if(!hubUrl) return null;
        // Resolve the base mainnet symbol. The oracle only prices the real asset,
        // so a request is eligible only when its route code IS the base symbol
        // (mainnet): 'BTC' === 'BTC'. Testnet/regtest codes ('TBTC','RDOGE') differ.
        let code = String(config.coin);
        let sym = null;
        try {
            const full  = await this.configInfo.getConfig();
            const bases = Object.keys(full['COIN_NETWORKS'] || {});   // ['BTC','LTC','DOGE']
            const b     = bases.find(c => code.endsWith(c));
            if(b && code === b) sym = b;
        } catch(e){ return null; }
        if(!sym) return null;

        const ttl = parseInt(process.env.PRICE_CACHE_MS, 10) || 60000;
        const now = Date.now();
        this._priceCache = this._priceCache || {};
        const hit = this._priceCache[sym];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const url = hubUrl.replace(/\/+$/, '') + '/';
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ jsonrpc: '2.0', method: 'getprice', params: { coin_pair: sym + '/USD' }, id: 1 }),
                signal:  AbortSignal.timeout(6000)
            });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const r = j && j.result;
            if(r && !r.error && r.price != null){
                const p = Number(r.price);
                if(Number.isFinite(p) && p > 0){
                    const v = String(r.price);
                    this._priceCache[sym] = { t: now, v };
                    this._priceStaleSince = this._priceStaleSince || {};
                    delete this._priceStaleSince[sym];
                    return v;
                }
            }
            // The hub answers a well-formed verdict when it refuses to quote: a
            // stale snapshot (its reference block aged past the oracle bound, which
            // a long Bitcoin block gap does routinely) or no finalized round at all.
            // Surface that verdict as the hub wrote it; "malformed" is reserved for
            // a body the parser genuinely cannot read.
            if(r && typeof r.error === 'string' && r.error){
                if(/\bstale\b/i.test(r.error)){
                    // Expected between rounds during a long block gap, and the last
                    // good value keeps serving, so log the transition once rather
                    // than every cache expiry until the next round finalizes.
                    this._priceStaleSince = this._priceStaleSince || {};
                    if(!this._priceStaleSince[sym]){
                        this._priceStaleSince[sym] = now;
                        console.log('getCoinPriceUsd: hub declines to quote ' + sym + ' (' + r.error + '); serving the last finalized value until the next round');
                    }
                    return (hit && hit.v) || null;
                }
                throw new Error('hub: ' + r.error);
            }
            throw new Error('malformed getprice response');
        } catch(e){
            console.warn('getCoinPriceUsd: price unavailable for ' + sym + ': ' + (e && e.message ? e.message : e));
            // Reuse a prior good value if we have one; otherwise null (placeholder).
            return (hit && hit.v) || null;
        }
    }

    // Returns the action-index high-water mark as an exact BigInt, never a Number.
    // This value is the WebSocket live/catch-up cursor, and Number() collapses two
    // consecutive action indices above 2^53 onto one value, which stalls or skips a
    // NEW_ACTION frame even though the wire serializer emits exact decimal strings.
    // Callers that put it on the wire still String() it; the WS frames
    // are decimal strings under schema v2 (ws/serialize.js).
    async getMaxActionIndex(config) {
        let query   = `SELECT MAX(action_index) as max_index FROM actions`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].max_index !== null)
            return BigInt(results[0].max_index);
        return 0n;
    }
}

module.exports = HealthReaders.prototype;
