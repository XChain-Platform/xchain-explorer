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
 * XChain Explorer - the Database LRU caches and their reorg generation
 *
 * One part of src/db/connection.js (the entry composes it through
 * composeReaderParts). The id/action LRU helpers, the cacheability rule for an
 * action response, and the per-coin generation counters that make those caches
 * safe to hold across a reorg: the reorg generation mixed into every id/action
 * key, and the tip-height generation the getData result cache is keyed on.
 *
 * These sit apart from the pool code because nothing here opens a connection:
 * the two probes that read the chain (resultCacheGeneration and
 * checkReorgAndInvalidate) go through this.doQuery on the entry, so this part
 * never sees a pool or the driver. init() is here because it is the one-line
 * start of the cache and pool lifetime and calls through to the entry's
 * setupConnectionPools.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const { MUTABLE_ACTION_FIELDS } = require('../shared.js');

class DatabaseCache {
    async init(){
        await this.setupConnectionPools()
    }

    /******************************************************************
     * LRU Cache Helpers
     *****************************************************************/

    cacheGet(cache, key){
        if(!cache.has(key)) return undefined;
        const val = cache.get(key);
        cache.delete(key);
        cache.set(key, val);
        return val;
    }

    cacheSet(cache, key, value, maxSize = 1000){
        if(cache.has(key)) cache.delete(key);
        else if(cache.size >= maxSize) cache.delete(cache.keys().next().value);
        cache.set(key, value);
    }

    // May this action response be memoized? Only when it is genuinely immutable.
    // A DISPENSER / ORDER / SWAP response carries a live `state` block whose
    // give_remaining, status, expiration and allow/block lists are derived from
    // rows written after the action confirmed, so caching one freezes it: the
    // action LRU has no TTL and is invalidated only by a reorg.
    //
    // A NOT-FOUND response is not immutable either. When getActionType finds no
    // row yet (the normal state of an action_index in the seconds between its
    // block landing and the indexer writing its typed row), getActionData
    // builds an all-null response with no `state` block, so an unguarded check
    // would pass this guard and memoize it forever with no TTL and reorg-only
    // invalidation - permanently blanking the action for anyone who asked one
    // moment too early. A real response always carries `action_index` (every
    // handler selects it, and deblankBaseline supplies it for a row-less
    // variant), so its absence is exactly the not-found case and nothing else.
    //
    // The third exclusion is the same defect on types that carry their mutable
    // state as plain columns rather than a `state` block: an ATTEST or XCALL
    // request_status, a VOTE poll_status, a BET feed/bet status. Those are
    // listed, and the reasoning is written out, on MUTABLE_ACTION_FIELDS.
    //
    // The fourth is the status itself. A `pending:` status is the indexer saying
    // this action has not settled: a chunked DEPLOY assembler waiting on its
    // carriers reports `pending: CODE_HASH (awaiting chunks)` and a null
    // deployed_contract_index, and the action that completes the group is a
    // DIFFERENT action, so nothing about this response is rewritten when it
    // completes - the values simply resolve differently on the next read. Cached,
    // the null would be served for the life of the process to the very clients
    // polling this endpoint to learn where their contract landed. The status is
    // matched rather than deployed_contract_index being added to
    // MUTABLE_ACTION_FIELDS, because that list is matched by PRESENCE: the field
    // is on every DEPLOY response, so listing it would uncache every settled
    // deploy forever for a mutation only the pending case has.
    isCacheableAction(data){
        if(this.util.isNull(data) || this.util.isNull(data['action_index'])) return false;
        if(!this.util.isNull(data['state'])) return false;
        if(!this.util.isNull(data['status']) && /^pending:/i.test(String(data['status']))) return false;
        for(let field of MUTABLE_ACTION_FIELDS)
            if(Object.prototype.hasOwnProperty.call(data, field)) return false;
        return true;
    }
    // Build an id/action cache key scoped to the coin AND its current reorg
    // generation (M-3). Coin-scoping also stops a bare address/tick key from
    // colliding across coins on a multi-coin explorer; the generation prefix is
    // what makes a reorg invalidation cheap (see bumpReorgGeneration).
    cacheKey(coin, key){
        return coin + ':' + (this._reorgGen[coin] || 0) + ':' + key;
    }

    // Invalidate this coin's id/action LRU entries after a reorg by advancing its
    // generation counter. Nothing is deleted eagerly: the old-generation keys are
    // simply unreachable and evicted by normal LRU pressure. Called from the
    // ChangeDetector tip-poll loop via checkReorgAndInvalidate.
    bumpReorgGeneration(coin){
        this._reorgGen[coin] = (this._reorgGen[coin] || 0) + 1;
    }

    // Generation token for the getData result cache: the coin's current indexed
    // tip height.
    //
    // The cached list methods (getBalances/getHolders/getTokens) read tables the
    // indexer only rewrites when it applies a block, so a cached answer stays
    // correct exactly as long as the tip does not move. Keying on the tip means a
    // new block makes every pre-block entry unreachable, instead of letting the
    // TTL keep serving the previous block's answer. Without it, /balances/{ADDR}
    // reports the pre-block balance for up to the full TTL after the block that
    // moved it confirmed - the balance a wallet shows its own user right after
    // their send confirms (it is also what made the escrow e2e suite,
    // the one template suite that reads a balance before the deposit and again
    // after, read a 0 debit off a correctly-debited ledger).
    //
    // Cost: one index-max lookup per coin per memo window, NOT per request, so a
    // request burst still collapses onto a single heavy query. A probe that fails
    // returns null, which makes the caller skip the cache for that request: never
    // serve a possibly-stale list because the freshness check itself broke.
    async resultCacheGeneration(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TIP_MEMO_MS, 10);
        const memo = this._tipMemo[coin];
        if(memo && (Date.now() - memo.at) < (Number.isFinite(ttl) ? ttl : 1000))
            return memo.tip;
        let tip = null;
        try {
            // MAX() over the blocks PK is an index-max lookup, not a scan.
            const rows = await this.doQuery(config, 'SELECT MAX(block_index) AS tip FROM blocks', []);
            if(rows && rows.length && !this.util.isNull(rows[0].tip))
                tip = String(rows[0].tip);
            // An empty blocks table is a real answer (nothing indexed yet), not a
            // failed probe: give it a generation of its own so a pre-genesis read
            // is still cacheable.
            else if(rows)
                tip = 'none';
        } catch(e){
            tip = null;
        }
        this._tipMemo[coin] = { tip, at: Date.now() };
        return tip;
    }

    // Detect a reorg cheaply on the ChangeDetector poll loop and invalidate the
    // id/action caches for the coin when one is seen (M-3). We can't observe the
    // indexer's internal reorg events without a new interface, but a reorg is
    // visible in the already-polled blocks table: the block at a previously-seen
    // height either vanishes (the tip rewound) or its hash changes (same height,
    // a different block). Either way the ^id / action_index space below that
    // height may have been reassigned, so we bump the generation. A failed read
    // throws (see doQuery) and is caught by the caller's poll guard, so a
    // transient DB blip does NOT spuriously invalidate: _lastTip is only advanced
    // after a clean read, and the missing-block check is skipped when the probe
    // itself fails. Piggybacks on the tip query the poll loop already needs.
    async checkReorgAndInvalidate(config){
        const coin = config.coin;
        // The blocks table stores no chain block hash; its identity columns are
        // *_hash_id references into index_transactions (ledger_hash_id is the
        // per-block ledger-state hash the indexer recomputes when a height is
        // replaced). Resolve it through the join and use it as the block's
        // identity for reorg detection.
        const tip  = await this.doQuery(config,
            `SELECT b1.block_index, t1.hash AS block_hash
             FROM blocks b1
             LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
             ORDER BY b1.block_index DESC LIMIT 1`, []);
        // Empty chain (no blocks yet): nothing to compare, nothing to invalidate.
        if(!tip || !tip.length || tip[0].block_index === null) return false;
        const curIndex = Number(tip[0].block_index);
        const curHash  = (tip[0].block_hash === undefined) ? null : tip[0].block_hash;
        const prev     = this._lastTip[coin];
        let reorg = false;
        if(prev){
            if(curIndex < prev.index){
                // Tip height went backwards: the chain was rolled back.
                reorg = true;
            } else {
                // Tip height is unchanged or higher; confirm the block still
                // present at the last-seen height carries the same hash.
                // A differing (or absent) hash means blocks at/below that height
                // were replaced. doQuery throws on a read failure, so an absent
                // row here is a genuine "block is gone", not a swallowed error.
                const at = await this.doQuery(config,
                    `SELECT t1.hash AS block_hash
                     FROM blocks b1
                     LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                     WHERE b1.block_index=? LIMIT 1`, [prev.index]);
                if(!at || !at.length){
                    // The row at the previously-seen height is gone entirely.
                    reorg = true;
                } else if(prev.hash !== null){
                    // Compare hashes only when the prior poll actually saw one;
                    // a NULL ledger_hash_id (hashing disabled or not yet
                    // computed) carries no identity to compare, and treating it
                    // as a mismatch would bump the generation on every poll.
                    const atHash = (at[0].block_hash === undefined) ? null : at[0].block_hash;
                    if(atHash !== prev.hash) reorg = true;
                }
            }
        }
        if(reorg) this.bumpReorgGeneration(coin);
        this._lastTip[coin] = { index: curIndex, hash: curHash };
        return reorg;
    }
}

module.exports = DatabaseCache.prototype;
