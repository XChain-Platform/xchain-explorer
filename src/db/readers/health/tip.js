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
 * XChain Explorer - the indexed-tip probes and the freshness verdict
 *
 * One part of src/db/readers/health.js (the entry composes it through
 * composeReaderParts). The tip probes the ChangeDetector polls every cycle,
 * the two per-coin thresholds with their defaults, the staleness rule built
 * on them, the cached per-coin freshness snapshot and the replica-halt read.
 *
 * The thresholds are here rather than in the entry because these methods are
 * their only readers: the default and the code that falls back to it stay in
 * one file, so neither can be changed without the other in view.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const { staleFailClosed } = require('../../shared.js');

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

class HealthTipReaders {
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
        let perCoin = parseInt(this.configInfo.env['EXPLORER_TIP_MAX_AGE_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(this.configInfo.env.EXPLORER_TIP_MAX_AGE_S, 10);
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
        let perCoin = parseInt(this.configInfo.env['EXPLORER_TIP_MAX_FUTURE_SKEW_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(this.configInfo.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S, 10);
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
        return staleFailClosed(this.configInfo);
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

    // Round-trips the cheapest statement through one coin's pool, so the JSON-RPC
    // ping can tell a reachable MariaDB from a process that is up but cut off.
    // Rejects exactly as doQuery does; the caller owns the empty-pool guard and timeout.
    async pingPool(config) {
        let query = `SELECT 1`;
        return await this.doQuery(config, query, []);
    }
}

module.exports = HealthTipReaders.prototype;
