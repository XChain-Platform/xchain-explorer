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

// Name the ANCHOR wire versions whose status a later chunk can restamp (see isCacheableAction).
const ANCHOR_RESTAMPED_VERSIONS = [1, 3];

// The identity of the block standing at a height, as the request path reads it:
// its ledger hash and its actions hash, both interned in index_transactions. A
// replacement block at the same height differs in at least one of them unless it
// carries the same actions with the same ledger effects, which serves the same
// rows anyway.
const BLOCK_IDENTITY_JOINS = `LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
             LEFT JOIN index_transactions t2 ON (t2.id=b1.actions_hash_id)`;

// The indexed tip and its identity. MAX() over the block_index index is an
// index-max lookup, and the joins are one indexed seek plus two primary-key
// reads. The derived table always yields one row, so an empty chain answers
// { tip: null } as the bare MAX() probe does.
const TIP_IDENTITY_SQL = `SELECT m.tip, t1.hash AS block_hash, t2.hash AS actions_hash
             FROM (SELECT MAX(block_index) AS tip FROM blocks) m
             LEFT JOIN blocks b1 ON (b1.block_index=m.tip)
             ` + BLOCK_IDENTITY_JOINS + `
             LIMIT 1`;

// The identity of the block at one earlier height.
const ROW_IDENTITY_SQL = `SELECT t1.hash AS block_hash, t2.hash AS actions_hash
             FROM blocks b1
             ` + BLOCK_IDENTITY_JOINS + `
             WHERE b1.block_index=? LIMIT 1`;

// The ledger hash of the block at one height, the identity the ChangeDetector
// poll (checkReorgAndInvalidate) compares.
const POLL_ROW_SQL = `SELECT t1.hash AS block_hash
                     FROM blocks b1
                     LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                     WHERE b1.block_index=? LIMIT 1`;

// One identity string for a blocks row read with BLOCK_IDENTITY_JOINS, or null
// when neither hash is present (hashing disabled), which carries no identity.
function requestIdentity(row){
    const ledger  = (row.block_hash === undefined || row.block_hash === null) ? null : String(row.block_hash);
    const actions = (row.actions_hash === undefined || row.actions_hash === null) ? null : String(row.actions_hash);
    return (ledger === null && actions === null) ? null : (ledger || '') + '/' + (actions || '');
}

// Has the block seen at prev.index been replaced, given the tip now reads cur?
// Both observers apply this one rule: the tip height went backwards, or the block
// at the last-seen height is gone or carries a different identity. At an
// unchanged height the tip row is that block, so no second read is made. A prior
// reading with no identity (null hash) compares on height alone.
async function blockReplaced(db, config, prev, cur, rowSql, identityOf){
    if(!prev) return false;
    if(cur.index < prev.index) return true;
    let atHash = cur.hash;
    if(cur.index !== prev.index){
        // doQuery throws on a read failure, so an absent row here is a genuine
        // "block is gone", not a swallowed error.
        const at = await db.doQuery(config, rowSql, [prev.index]);
        if(!at || !at.length) return true;
        atHash = identityOf(at[0]);
    }
    return prev.hash !== null && atHash !== prev.hash;
}

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
    //
    // The match covers every `pending` spelling, not only `pending:`: a COINPAY
    // order match is stored `pending_coinpay` and the settling COINPAY later
    // rewrites that same order_matches row to `valid`.
    //
    // The fifth is a status a LATER action restamps in place. An ANCHOR archive
    // head (v1, or any v3 bundle, since its section 0 header cannot show whether
    // the bundle carries an archive) is stored valid, and the continuation chunk
    // that completes its archive can rewrite every row of that action to
    // invalid_archive when the reassembled body fails its CRC or match count.
    // Those two versions are exactly the ones the indexer picks as a chunk's
    // parent; v0 bundles and v2 chunks are never restamped.
    isCacheableAction(data){
        if(this.util.isNull(data) || this.util.isNull(data['action_index'])) return false;
        if(!this.util.isNull(data['state'])) return false;
        if(!this.util.isNull(data['status']) && /^pending/i.test(String(data['status']))) return false;
        if(data['action'] === 'ANCHOR' && ANCHOR_RESTAMPED_VERSIONS.includes(Number(data['version']))) return false;
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
    // simply unreachable and evicted by normal LRU pressure. Called by the
    // tip poll (checkReorgAndInvalidate, run by the ChangeDetector or, with the
    // live feed off, by the api boot reorg poll) and by the request-path tip
    // reading in resultCacheGeneration.
    bumpReorgGeneration(coin){
        this._reorgGen[coin] = (this._reorgGen[coin] || 0) + 1;
    }

    // Generation token for the getData result cache and the list totals cache
    // (query_sql/data_totals.js): the coin's current indexed tip height and the
    // identity of the block at it, as '<height>:<ledger hash>/<actions hash>'
    // ('<height>' alone when the block carries no hashes). blocks.js reads the
    // height off the front.
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
    // The identity is what makes a same-height reorg visible: a block replaced by
    // another at the same height leaves the height unchanged, so the identity is
    // what moves the key off the replaced block's balances and holders.
    //
    // The same reading is this process's request-path reorg check. It keeps its
    // own last-seen tip (_requestTip), separate from the ChangeDetector poll's
    // _lastTip, because the poll turns its reorg verdict into a WebSocket cursor
    // rewind and a second reader of _lastTip would consume that verdict. When the
    // block seen at the last reading has been replaced it bumps the reorg
    // generation, which retires the id/action LRU entries keyed through cacheKey.
    // XChainExplorer.processRequest calls this before serving any route of a
    // coin, so those caches are checked against the chain on every request, not
    // only on the WebSocket poll.
    //
    // Cost: one tip read per coin per memo window (EXPLORER_TIP_MEMO_MS, default
    // 1 s), NOT per request, plus one single-row identity read in a window where
    // the height moved. A request burst still collapses onto a single heavy query.
    // A probe that fails returns null, which makes the caller skip the cache for
    // that request: never serve a possibly-stale list because the freshness check
    // itself broke. A failed probe also leaves _requestTip as it was.
    async resultCacheGeneration(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TIP_MEMO_MS, 10);
        const memo = this._tipMemo[coin];
        if(memo && (Date.now() - memo.at) < (Number.isFinite(ttl) ? ttl : 1000))
            return memo.tip;
        let tip = null;
        try {
            const rows = await this.doQuery(config, TIP_IDENTITY_SQL, []);
            if(rows && rows.length && !this.util.isNull(rows[0].tip)){
                const cur = { index: Number(rows[0].tip), hash: requestIdentity(rows[0]) };
                if(!this._requestTip) this._requestTip = {};
                if(await blockReplaced(this, config, this._requestTip[coin], cur, ROW_IDENTITY_SQL, requestIdentity))
                    this.bumpReorgGeneration(coin);
                this._requestTip[coin] = cur;
                tip = String(rows[0].tip) + ((cur.hash === null) ? '' : ':' + cur.hash);
            }
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

    // Detect a reorg cheaply on the tip poll and invalidate the id/action caches
    // for the coin when one is seen (M-3). The ChangeDetector runs this poll when
    // the live feed is on, and src/http/api_boot/websocket.js runs it on its own
    // when WS_ENABLED=false, so the invalidation never depends on the live feed. We can't observe the
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
        // The tip height went backwards, or the block at the last-seen height is
        // gone or carries a different hash (blockReplaced). A prior poll that
        // saw a NULL ledger_hash_id (hashing disabled or not yet computed)
        // carries no identity to compare, so it compares on height alone rather
        // than bumping the generation on every poll.
        const reorg = await blockReplaced(this, config, this._lastTip[coin], { index: curIndex, hash: curHash },
            POLL_ROW_SQL, (row) => (row.block_hash === undefined) ? null : row.block_hash);
        if(reorg) this.bumpReorgGeneration(coin);
        this._lastTip[coin] = { index: curIndex, hash: curHash };
        return reorg;
    }
}

module.exports = DatabaseCache.prototype;
