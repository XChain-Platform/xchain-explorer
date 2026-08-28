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
 * XChain Explorer - Change Detector
 *
 * Polls the indexer database at a configurable interval to detect
 * new blocks and actions. When changes are detected, fetches the
 * new data, maps actions to lifecycle events, and passes everything
 * to the Broadcaster. Only fetches entity details when subscribers
 * exist for those channels.
 *
 ********************************************************************/

const EventEmitter = require('events');

// Mapping from indexed action type to WebSocket lifecycle event types
const LIFECYCLE_MAP = {
    'ORDER_MATCH':     ['ORDER_MATCH'],
    'COINPAY':         ['COINPAY_FULFILLED'],
    'COINPAY_EXPIRE':  ['COINPAY_EXPIRED'],
    'ORDER_EXPIRE':    ['ORDER_EXPIRED'],
    'SWAP_MATCH':      ['SWAP_MATCH'],
    'SWAP_EXPIRE':     ['SWAP_EXPIRED'],
    'DISPENSE':        ['DISPENSE'],
    'DISPENSER_CLOSE': ['DISPENSER_CLOSED'],
    'DISPENSER_EXPIRE':['DISPENSER_EXPIRED'],
    // BET is ONE action name carrying four formats (create/cancel/place/resolve), so
    // a single BET event type covers them all and consumers branch on action_format;
    // BET_EXPIRE is the system refund pass's minted action. Both route to the
    // `bet_feed` entity channel below, keyed on the PARENT feed's action_index.
    'BET':             ['BET'],
    'BET_EXPIRE':      ['BET_EXPIRED']
};

// Lifecycle events with NO causing action row, emitted by a cursor of their own
// rather than by LIFECYCLE_MAP. Kept beside the map because the ChannelManager
// conformance test reconciles both directions of the VALID_TYPES contract, and a
// name reachable only through a second cursor is invisible to a map-only check.
const NON_ACTION_LIFECYCLE_TYPES = ['BET_CLOSED'];

// Lifecycle events emitted inline by an enrichment path, so neither the map nor
// a cursor names them. Declared here so the conformance test reads the producer
// rather than carrying its own copy: that second copy is exactly what let the
// two ATTESTATION names ship emitted-but-unfilterable.
const INLINE_LIFECYCLE_TYPES = ['COINPAY_REQUIRED', 'ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE'];

class ChangeDetector extends EventEmitter {

    constructor(options) {
        super();
        this.db             = options.db;
        this.channelManager = options.channelManager || null;
        this.pollInterval   = options.pollInterval || 5000;
        this.fetchLimit     = options.fetchLimit   || 100;
        // How long a coin's BET_CLOSED cursor stays parked after its indexer answers
        // "no bet_feeds table". A schema gap is a deploy-order fact, not a permanent
        // property of the chain, so it is a cooldown rather than a switch: see
        // _checkBetLatches. Tests set it to 0 to probe on every poll.
        this.betLatchRetryMs = options.betLatchRetryMs !== undefined
            ? options.betLatchRetryMs
            : 5 * 60 * 1000;

        // Track last known state per coin (e.g., "BTC", "TBTC", "RLTC")
        this.state = {};

        // Track the unconfirmed (decoder mempool) snapshot per coin. Keyed by
        // tx_hash: the mempool table has no monotonic index, so each poll
        // diffs the tx_hash-ordered (capped) window against the previous one;
        // see _checkMempoolForCoin for what a saturated window does and does
        // not prove. The value is `{source, action, data}` (`data` being the RAW
        // action string, not a party list) so a removal can name the tx's parties
        // and its action family after its row is already gone from the table; see
        // the emit in _checkMempoolForCoin.
        this.mempoolState = {};

        // Polling timer reference
        this.timer   = null;
        this.running = false;
    }

    start(coins) {
        if (this.running) return;
        this.running = true;

        for (const coin of coins) {
            if (!this.state[coin]) {
                this.state[coin] = { blockIndex: 0, actionIndex: 0, closedBlock: 0, initialized: false };
            }
            if (!this.mempoolState[coin]) {
                this.mempoolState[coin] = { seenHashes: new Map(), initialized: false };
            }
        }

        this.timer = setInterval(() => this._poll(), this.pollInterval);
        this._poll();

        console.log('ChangeDetector started: polling every', this.pollInterval, 'ms for', coins.join(', '));
    }

    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // Is this coin's indexed tip too old for the live feed to present its rows as
    // current? Same per-coin, 15s-cached, fail-closed verdict the HTTP path gates
    // on (db.isCoinTipStale). A db without the method is a unit-test double, never
    // the shipped Database, so fail OPEN there, mirroring the
    // `typeof this.db.checkReorgAndInvalidate === 'function'` probe in _checkCoin.
    async _isCoinTipStale(coin) {
        if (!this.db || typeof this.db.isCoinTipStale !== 'function') return false;
        try { return await this.db.isCoinTipStale(coin); }
        catch (e) { return false; }
    }

    async _poll() {
        if (!this.running) return;

        for (const coin of Object.keys(this.state)) {
            // Fail closed on a stale replica, matching the HTTP path and the WS
            // serving boundaries. A FROZEN replica emits nothing here
            // anyway (every emit below is triggered by the tip advancing), but a
            // replica REPLAYING history from a snapshot does advance while its
            // newest block_time is hours old, and it pushed NEW_BLOCK/NEW_ACTION/
            // ADDRESS_UPDATE frames for historical blocks stamped
            // `timestamp: Date.now()`, which a subscriber reads as the chain tip.
            // Evaluated once per coin per cycle, which is what the cached verdict is
            // sized for, and it suppresses the mempool diff too: a mempool read from
            // a replica that cannot vouch for its own tip is no more current than its
            // blocks. Cursors are left untouched, so the backlog emits normally once
            // the tip catches up rather than being skipped.
            if (await this._isCoinTipStale(coin)) continue;

            try {
                await this._checkCoin(coin);
            } catch (e) {
                console.error('ChangeDetector poll error for', coin, ':', e);
            }
            try {
                await this._checkMempoolForCoin(coin);
            } catch (e) {
                console.error('ChangeDetector mempool poll error for', coin, ':', e);
            }
        }
    }

    // Diff the decoder-DB mempool snapshot against the last poll. New rows emit
    // `mempool_action` (decoded: tx_hash/source/action/data/first_seen); rows that
    // left the mempool (confirmed or evicted; we can't tell which) emit
    // `mempool_removed` carrying {tx_hash, source, action, data} recovered from the
    // per-coin seenHashes Map. The Map stores the RAW action string rather than a
    // pre-computed party list because the subscriber set lives in ChannelManager,
    // which only the Broadcaster can reach: the removal path re-runs the shared
    // matcher against CURRENT subscribers, so a client that subscribed between the
    // action and the removal still gets the removal.
    // Rows are PRE-VALIDATION: a mempool action can still be rejected by the
    // indexer at confirmation, so consumers must treat these as provisional.
    async _checkMempoolForCoin(coin) {
        if (typeof this.db.getDecoderMempoolRows !== 'function') return;
        const state = this.mempoolState[coin];
        if (!state) return;

        const WINDOW = 500;
        const rows = await this.db.getDecoderMempoolRows({ coin }, WINDOW);
        const current = new Map();
        const decodedNew = [];
        let maxHash = null;
        for (const row of rows) {
            if (!row || !row.tx_hash) continue;
            const key = String(row.tx_hash).toLowerCase();
            if (maxHash === null || key > maxHash) maxHash = key;
            const known = state.seenHashes.get(row.tx_hash);
            if (known !== undefined) {
                // Already announced on an earlier poll: carry its parties forward
                // untouched (a mempool row's action string is immutable, so there
                // is nothing to re-read and nothing to re-decode).
                current.set(row.tx_hash, known);
                continue;
            }
            const decoded = this.db.decodeMempoolRow(row);
            if (decoded) decodedNew.push(decoded);
            // Remember source + action name + the raw action string even for a row
            // that did not decode (garbage / rejected-ACTION sentinel): it emits no
            // mempool_action, but its disappearance still emits mempool_removed,
            // and the removal frame's shape must not depend on decodability.
            // `action` is the name decodeMempoolRow already normalized out of the
            // first segment (trimmed, uppercased, validated), so the removal names
            // the same family its mempool_action did, character for character. An
            // undecodable row keeps action null: it has no family to claim.
            current.set(row.tx_hash, {
                source: (decoded && decoded.source) || row.source || null,
                action: decoded ? decoded.action : null,
                data:   decoded ? decoded.data : null
            });
        }
        // The read is ORDER BY tx_hash LIMIT 500 (getDecoderMempoolRows). When the
        // window came back full the table may hold more rows than it covers, and
        // an already-seen hash sorting above the largest hash read was never
        // looked at: its absence proves nothing. Only a hash at or below that
        // bound is known gone. A short window covers the whole table.
        const covered = (rows.length >= WINDOW) ? maxHash : null;

        // First poll: seed without emitting (mirrors block/action init)
        if (!state.initialized) {
            state.seenHashes  = current;
            state.initialized = true;
            return;
        }

        for (const decoded of decodedNew)
            this.emit('mempool_action', coin, decoded);

        const next = current;
        for (const [hash, parties] of state.seenHashes) {
            if (current.has(hash)) continue;
            if (covered !== null && String(hash).toLowerCase() > covered) {
                // Out of the window's range: carry forward, unknown rather than gone.
                next.set(hash, parties);
                continue;
            }
            // Carry the tx's source, action name and raw action string on the
            // removal so the Broadcaster can fan the frame out to the same address
            // channels its mempool_action reached, and so a subscriber filtering by
            // `types` can be offered the removal of an action family it asked for.
            // The row itself is gone from the table by now, so this remembered
            // triple is the only surviving evidence of what the tx was and who it
            // involved.
            this.emit('mempool_removed', coin, {
                tx_hash: hash,
                source:  (parties && parties.source) || null,
                action:  (parties && parties.action) || null,
                data:    (parties && parties.data)   || null
            });
        }

        state.seenHashes = next;
    }

    async _checkCoin(coin) {
        const config = { coin };
        const prev   = this.state[coin];

        // Invalidate the db-layer id/action LRU caches when this poll observes a
        // reorg (M-3). The indexer reassigns ^id / action_index on a reorg, so a
        // cached entry keyed by an index can otherwise serve a different entity's
        // detail/history until natural eviction. This is the tip-poll loop the
        // caches piggyback on; a failed read throws and is caught by _poll, which
        // leaves the last-seen tip unchanged so no spurious invalidation occurs.
        // The returned flag also drives the cursor rewind below: a reorg can roll
        // the indexer tip BACKWARD, and our cursors are a high-water mark, so without
        // a rewind the strictly-greater comparisons would stop emitting until the
        // chain re-climbed past the pre-reorg tip (feed stall while the new tip sits
        // lower; replaced tail otherwise skipped).
        let reorged = false;
        if (typeof this.db.checkReorgAndInvalidate === 'function')
            reorged = await this.db.checkReorgAndInvalidate(config);

        const currentBlockIndex  = await this.db.getMaxBlockIndex(config) || 0;
        // Zero-default is 0n, not 0: getMaxActionIndex answers in BigInt so the
        // action cursor stays exact above 2^53, and `0n || 0` would have
        // flipped an empty chain's cursor back to Number for the rest of the poll.
        const currentActionIndex = await this.db.getMaxActionIndex(config) || 0n;

        // First poll: seed state without emitting
        if (!prev.initialized) {
            prev.blockIndex  = currentBlockIndex;
            prev.actionIndex = currentActionIndex;
            // The latch cursor seeds to the tip for the same reason the other two do:
            // every deadline latch at or below the current tip already happened before
            // this process started, and replaying them as live pushes would tell every
            // subscriber that historical markets are closing right now.
            prev.closedBlock = currentBlockIndex;
            prev.initialized = true;
            return;
        }

        // On a reorg, clamp each cursor down to the (possibly lower) new tip so the
        // feed resumes at the correct height instead of waiting for the chain to
        // re-pass the old high-water mark. Same-height replacements are covered by
        // the cache invalidation above + the authoritative REST reads; this loop is
        // a best-effort live feed, not a reorg replay.
        if (reorged) {
            if (prev.blockIndex  > currentBlockIndex)  prev.blockIndex  = currentBlockIndex;
            if (prev.actionIndex > currentActionIndex) prev.actionIndex = currentActionIndex;
            // The latch cursor rewinds with them, and here it is more than a stall fix:
            // rollback.js CLEARS closed_block on a reorg past the latch block, so a feed
            // that re-latches on the new chain gets a fresh stamp that must be pushed
            // again. Without the rewind that second latch sits below the high-water mark
            // and is never emitted (spec §12 E8).
            if (prev.closedBlock > currentBlockIndex) prev.closedBlock = currentBlockIndex;
        }

        if (currentBlockIndex > prev.blockIndex) {
            const newBlocks = await this.db.getBlocksSince(config, prev.blockIndex, this.fetchLimit);
            if (newBlocks && newBlocks.length > 0) {
                for (const block of newBlocks) {
                    this.emit('block', coin, block);
                }
            }
            // Advance by what was actually fetched, NOT to the observed tip:
            // getBlocksSince returns the LOWEST `fetchLimit` rows (block_index ASC),
            // so a burst larger than fetchLimit must drain over successive polls.
            // Jumping straight to currentBlockIndex would permanently skip every
            // block past the first fetchLimit seen in one interval.
            prev.blockIndex = this._nextCursor(newBlocks, 'block_index', currentBlockIndex);
        }

        if (currentActionIndex > prev.actionIndex) {
            const newActions = await this.db.getActionsSince(config, prev.actionIndex, this.fetchLimit);
            if (newActions && newActions.length > 0) {
                // Per-poll entity-read cache (grouped by type). _emitEntityUpdates used to
                // re-issue getAddressBalances / getTokenInfo / getDispenserInfo / getMarketInfo
                // for every subscribed entity ON EVERY action, fanning a poll out to
                // (new actions) x (subscribed entities) serial single-row reads. Each of those
                // reads returns the CURRENT committed aggregate state, which does not change
                // across a single poll (no writes happen mid-loop, and the action rows are
                // already committed), so the same entity read repeated within a poll always
                // yields the same value. Caching it once per distinct entity per poll therefore
                // emits byte-identical events while collapsing the read count to at most one per
                // distinct subscribed entity per poll, independent of the action count.
                const entityCache = {
                    addr:      new Map(),
                    token:     new Map(),
                    dispenser: new Map(),
                    market:    new Map()
                };
                for (const action of newActions) {
                    this.emit('action', coin, action);
                    await this._emitLifecycleEvents(coin, config, action);
                    await this._emitEntityUpdates(coin, config, action, entityCache);
                    await this._emitAttestationEvents(coin, config, action);
                }
            }
            // Same drain semantics as blocks (getActionsSince is action_index ASC,
            // capped at fetchLimit): advance to the last emitted action, not the tip.
            prev.actionIndex = this._nextCursor(newActions, 'action_index', currentActionIndex);
        }

        // Runs after the action loop, mirroring the chain: the latch pass executes
        // after every user tx in its block (spec §6), so a market page sees the last
        // bet before it is told betting closed.
        await this._checkBetLatches(coin, config, currentBlockIndex, prev);
    }

    // "That table does not exist here", seen through the db layer's wrapper. db.js
    // rethrows as DbQueryError with its OWN code ('DB_ERROR') and the driver's
    // SqlError on .cause, so testing the top-level error alone never matches a real
    // one: the first cut of this check looked right, passed a unit test built from a
    // hand-made error, and still logged the missing table every poll on the fleet.
    // Walks the cause chain, which is bounded and short.
    _isMissingTableError(err) {
        for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
            if (e.code === 'ER_NO_SUCH_TABLE' || Number(e.errno) === 1146) return true;
        }
        return false;
    }

    // Emit BET_CLOSED for every market whose deadline latch was stamped since the last
    // poll. This is a SECOND cursor, over bet_feeds.closed_block rather than over
    // `actions`, and it exists because the latch is the one BET transition with no
    // action row: the end-of-block pass writes the status directly and mints nothing
    // for the actions cursor to find, so a subscribed market page used to learn that
    // betting had closed only on its next fetch (spec §11.1 lists the latch
    // among this channel's events).
    async _checkBetLatches(coin, config, currentBlockIndex, prev) {
        if (typeof this.db.getBetFeedsClosedSince !== 'function') return;
        // A coin whose indexer predates the BET tables is not an error condition to
        // re-discover every 5 seconds; see the ER_NO_SUCH_TABLE branch below. It is
        // parked, not switched off: the table appears the moment that chain's indexer
        // is upgraded, and this process can outlive several such upgrades.
        if (prev.betLatchUnsupported && Date.now() < prev.betLatchRetryAt) return;

        let since = Number(prev.closedBlock);
        if (!Number.isFinite(since)) since = 0;

        let rows;
        try {
            rows = await this.db.getBetFeedsClosedSince(config, since, this.fetchLimit);
        } catch (e) {
            // Observed live on the regtest fleet: the LTC indexer DB had no bet_feeds
            // table (its build predates P4's migrations), so every poll threw and
            // filled the log. The BET tables are per-coin-database, so one chain
            // lacking them says nothing about the others: latch this coin off and
            // report it once, rather than letting a per-coin schema gap look like a
            // recurring fault. Any OTHER error still propagates to the poll loop's
            // handler, where a genuine DB failure belongs.
            if (this._isMissingTableError(e)) {
                // Announce the transition only. A re-probe that finds the table still
                // missing must stay silent, or the cooldown just turns a per-poll log
                // into a per-cooldown one.
                if (!prev.betLatchUnsupported) {
                    console.log('ChangeDetector: no bet_feeds table for', coin,
                                '- BET_CLOSED events parked for this coin, re-probing every',
                                Math.round(this.betLatchRetryMs / 1000) + 's');
                }
                prev.betLatchUnsupported = true;
                prev.betLatchRetryAt     = Date.now() + this.betLatchRetryMs;
                return;
            }
            throw e;
        }

        // The probe succeeded after the coin had been parked, which means that chain's
        // indexer gained the BET tables while this process was running. Re-seed to the
        // tip and emit nothing, for the same reason the first poll seeds rather than
        // emits: every latch at or below the tip already happened, and pushing them now
        // tells every subscriber that historical markets are closing this second. The
        // REST timeline still reports those latches correctly (it synthesizes `closed`
        // from bet_feeds.closed_block), so nothing is unreachable, only un-pushed.
        if (prev.betLatchUnsupported) {
            prev.betLatchUnsupported = false;
            prev.betLatchRetryAt     = 0;
            prev.closedBlock         = currentBlockIndex;
            console.log('ChangeDetector: bet_feeds now present for', coin,
                        '- BET_CLOSED events re-armed from block', currentBlockIndex);
            return;
        }

        if (!rows || rows.length === 0) {
            // Skip the empty span so it is not re-scanned every interval. Safe against
            // a block committed between the tip read above and this query: such a block
            // carries a HIGHER closed_block than the tip we advance to, so it is still
            // strictly greater than the cursor on the next poll.
            if (currentBlockIndex > since) prev.closedBlock = currentBlockIndex;
            return;
        }

        let emit = rows;
        let next = Math.max(currentBlockIndex, Number(rows[rows.length - 1].closed_block));

        if (rows.length >= this.fetchLimit) {
            // A capped fetch can cut a block in half (one pass latches up to
            // MAX_BET_PASS_ROWS feeds, far more than fetchLimit). Emitting the partial
            // tail and then advancing past its block would silently drop the rest of
            // it, so stop on the last COMPLETE block and re-read the remainder next
            // poll. The cursor is a block height, not a row id, which is exactly why
            // the generic _nextCursor drain cannot be reused here: resuming mid-block
            // would re-emit the feeds already sent from that block.
            const lastBlock = Number(rows[rows.length - 1].closed_block);
            const complete  = rows.filter((r) => Number(r.closed_block) < lastBlock);
            if (complete.length > 0) {
                emit = complete;
                next = Number(complete[complete.length - 1].closed_block);
            } else {
                // The whole fetch is one block, so there is no boundary to stop on.
                // Emit what we have and move past it rather than looping on the same
                // block forever: this channel is a best-effort live push and the REST
                // reads stay authoritative for the remainder.
                next = lastBlock;
            }
        }

        for (const feed of emit) {
            this.emit('lifecycle_event', coin, {
                type:    'BET_CLOSED',
                action:  'BET_CLOSED',
                channel: 'bet_feed',
                data: {
                    // Both keys carry the feed id: action_index because every event on
                    // this channel identifies its subject that way, feed_action_index
                    // because that is what the Broadcaster routes on. For the latch they
                    // are the same number, since the market IS its creating action.
                    action_index:      feed.action_index,
                    feed_action_index: feed.action_index,
                    block_index:       feed.closed_block,
                    // No causing tx by design, and no format: the latch is not an action.
                    tx_hash:           null,
                    action_format:     null,
                    source:            feed.source || null,
                    // The TRANSITION this event reports, which is not necessarily the
                    // feed's status by the time we poll: an oracle can resolve in a
                    // later block before this fires, and reporting `resolved` on the
                    // close event would be a lie about what happened at block_index.
                    // The live status rides alongside for a consumer that wants it.
                    status:            'closed',
                    feed_status:       feed.feed_status || null,
                    // Same flag the REST timeline stamps on its synthesized `closed`
                    // entry: this transition has no action row behind it.
                    synthetic:         true
                }
            });
        }

        prev.closedBlock = next;
    }

    // Next poll cursor after a capped `*Since` fetch. The queries return the lowest
    // `fetchLimit` rows above the cursor (ORDER BY <idx> ASC LIMIT fetchLimit), so
    // when a fetch fills the cap and its last row is still below the observed tip
    // there is a backlog: continue from the last fetched row next poll rather than
    // jumping to the tip (which would drop the un-fetched remainder). An empty fetch
    // (rows filtered out despite a higher tip) advances to the tip so the same empty
    // range is not re-polled forever.
    // Compares as BigInt: both index columns are BIGINT, and Number() collapsed two
    // consecutive action indices above 2^53 onto one value, so a backlog cursor could
    // land at or past an action that was never emitted. The return keeps
    // currentMax's own type so the block cursor stays a Number and only the action
    // cursor, whose currentMax is now BigInt, becomes exact.
    _nextCursor(rows, indexKey, currentMax) {
        if (!rows || rows.length === 0) return currentMax;
        let last, max;
        // A malformed/absent index on the last row is not a cursor: fall back to the
        // tip rather than throw out of the poll loop, matching the old isFinite guard.
        try {
            last = BigInt(rows[rows.length - 1][indexKey]);
            max  = BigInt(currentMax);
        } catch (e) {
            return currentMax;
        }
        if (rows.length >= this.fetchLimit && last < max)
            return (typeof currentMax === 'bigint') ? last : Number(last);
        return currentMax;
    }

    async _emitLifecycleEvents(coin, config, action) {
        const actionType = action.action;
        if (!actionType) return;

        const eventTypes = LIFECYCLE_MAP[actionType];
        if (!eventTypes) return;

        for (const eventType of eventTypes) {
            const lifecycleEvent = {
                type:   eventType,
                action: actionType,
                data: {
                    action_index: action.action_index,
                    tx_hash:      action.tx_hash      || null,
                    block_index:  action.block_index   || null,
                    source:       action.source        || null,
                    status:       action.status        || null
                }
            };

            // Enrich ORDER_MATCH with settlement info and COINPAY_REQUIRED
            if (actionType === 'ORDER_MATCH') {
                try {
                    const settlement = await this.db.getOrderMatchSettlement(config, action.action_index);
                    if (settlement) {
                        lifecycleEvent.data.settlement_type = settlement.settlement_type;
                    }

                    if (settlement && settlement.settlement_type === 'coinpay') {
                        const obligation = await this.db.getCoinpayObligation(config, action.action_index);
                        if (obligation) {
                            this.emit('lifecycle_event', coin, {
                                type:   'COINPAY_REQUIRED',
                                action: 'COINPAY_REQUIRED',
                                data: {
                                    obligation_action_index:    obligation.obligation_action_index,
                                    order_match_action_index:  obligation.order_match_action_index,
                                    payer_address:             obligation.payer_address,
                                    payee_address:             obligation.payee_address,
                                    coin_amount:               obligation.coin_amount,
                                    expiration:                obligation.expiration
                                }
                            });
                        }
                    }
                } catch (e) {
                    // Non-fatal: emit the base event without enrichment
                }
            }

            // Enrich DISPENSE with its parent dispenser's action_index: the base
            // payload's action_index is the dispense itself, but SDK consumers
            // correlate on data.dispenser_action_index (xchain-sdk XChainSDK
            // DISPENSE handler). Mirrors the ORDER_MATCH enrichment above.
            if (actionType === 'DISPENSE') {
                try {
                    lifecycleEvent.data.dispenser_action_index =
                        await this.db.getDispenseDispenserIndex(config, action.action_index);
                } catch (e) {
                    // Non-fatal: emit the base event with a null parent index
                    lifecycleEvent.data.dispenser_action_index = null;
                }
            }

            // Route dispenser lifecycle events (DISPENSE / DISPENSER_CLOSED /
            // DISPENSER_EXPIRED) to the dedicated `dispenser` entity channel that
            // the SDK's onDispenser() subscribes to, keyed on the parent
            // dispenser's action_index. Without this they only reached the
            // `actions`/`address` channels, so the SDK's typed dispenser handlers
            // were dead (mirrors the `attestation` channel pattern below).
            if (actionType === 'DISPENSE' || actionType === 'DISPENSER_CLOSE' || actionType === 'DISPENSER_EXPIRE') {
                if (actionType === 'DISPENSER_CLOSE' || actionType === 'DISPENSER_EXPIRE') {
                    const table = actionType === 'DISPENSER_CLOSE' ? 'dispenser_closes' : 'dispenser_expires';
                    try {
                        lifecycleEvent.data.dispenser_action_index =
                            await this.db.getDispenserLifecycleDispenserIndex(config, table, action.action_index);
                    } catch (e) {
                        // Non-fatal: emit the base event with a null parent index
                        lifecycleEvent.data.dispenser_action_index = null;
                    }
                }
                lifecycleEvent.channel = 'dispenser';
            }

            // Route BET-family events to the `bet_feed` entity channel, keyed on the
            // PARENT market rather than the action itself, so a market page subscribed
            // to one feed sees every bet placed on it plus its latch/resolve/cancel/
            // expire transitions (§11.1). Same shape as the dispenser routing above.
            if (actionType === 'BET' || actionType === 'BET_EXPIRE') {
                try {
                    lifecycleEvent.data.feed_action_index =
                        await this.db.getBetActionFeedIndex(config, action.action_index);
                } catch (e) {
                    // Non-fatal: emit the base event with a null parent index
                    lifecycleEvent.data.feed_action_index = null;
                }
                // The discriminator the single BET event type is useless without:
                // 0 create, 1 cancel, 2 place a bet, 3 resolve. A market page has to
                // tell "someone staked" from "the market just paid out", and those
                // arrive under the same `type`. Null only for a system BET_EXPIRE,
                // which its own event type already identifies.
                lifecycleEvent.data.action_format =
                    (action.action_format === undefined || action.action_format === null)
                        ? null
                        : Number(action.action_format);
                lifecycleEvent.channel = 'bet_feed';
            }

            this.emit('lifecycle_event', coin, lifecycleEvent);
        }
    }

    // Read an entity's enrichment info at most once per poll. `map` is one of the
    // per-poll caches built in _checkCoin; a cache miss runs `loader` and stores its
    // result (including null), a hit returns the stored value without a DB round-trip.
    // A loader that throws is NOT cached and propagates to the caller's try/catch, so
    // the per-entity non-fatal skip behaviour is unchanged. When no cache is supplied
    // (e.g. a direct/legacy call) the loader always runs, preserving old behaviour.
    async _entityRead(map, key, loader) {
        if (!map) return await loader();
        if (map.has(key)) return map.get(key);
        const value = await loader();
        map.set(key, value);
        return value;
    }

    async _emitEntityUpdates(coin, config, action, entityCache) {
        if (!this.channelManager) return;
        const cache = entityCache || null;

        const subscribedAddresses = this.channelManager.getSubscribedAddresses(coin);
        if (subscribedAddresses.size > 0) {
            const involvedAddresses = new Set();
            if (action.source && subscribedAddresses.has(action.source))           involvedAddresses.add(action.source);
            if (action.destination && subscribedAddresses.has(action.destination)) involvedAddresses.add(action.destination);

            for (const addr of involvedAddresses) {
                try {
                    const balances = await this._entityRead(cache && cache.addr, addr, () => this.db.getAddressBalances(config, addr));
                    this.emit('entity_update', coin, {
                        type:    'ADDRESS_UPDATE',
                        channel: 'address',
                        data: {
                            address:           addr,
                            balances:          balances || [],
                            last_action_index: action.action_index
                        }
                    });
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        // getActionsSince doesn't include tick directly; this is a lightweight action-type
        // check for token subscribers (full tick resolution would require joining more tables)
        const subscribedTicks = this.channelManager.getSubscribedTicks(coin);
        if (subscribedTicks.size > 0 && ['ISSUE', 'MINT', 'DESTROY', 'SEND', 'AIRDROP', 'DIVIDEND'].includes(action.action)) {
            for (const tick of subscribedTicks) {
                try {
                    const tokenInfo = await this._entityRead(cache && cache.token, tick, () => this.db.getTokenInfo(config, tick));
                    if (tokenInfo) {
                        this.emit('entity_update', coin, {
                            type:    'TOKEN_UPDATE',
                            channel: 'token',
                            // Spread the full getTokenInfo projection (already loaded
                            // above) so the live frame is a superset of the SNAPSHOT
                            // frame, which spreads the same loader. Hand-picking
                            // supply/holders here made replace-model consumers lose
                            // decimals/description as silent undefined; the sibling
                            // address/market/dispenser channels already keep the two
                            // frame shapes aligned.
                            data: {
                                ...tokenInfo,
                                tick:              tick,
                                last_action_index: action.action_index
                            }
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        const subscribedDispensers = this.channelManager.getSubscribedDispensers(coin);
        if (subscribedDispensers.size > 0 && ['DISPENSE', 'DISPENSER', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE'].includes(action.action)) {
            for (const dispenserIdx of subscribedDispensers) {
                try {
                    const dispenserInfo = await this._entityRead(cache && cache.dispenser, dispenserIdx, () => this.db.getDispenserInfo(config, dispenserIdx));
                    if (dispenserInfo) {
                        this.emit('entity_update', coin, {
                            type:    'DISPENSER_UPDATE',
                            channel: 'dispenser',
                            data:    dispenserInfo
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }

        const subscribedMarkets = this.channelManager.getSubscribedMarkets(coin);
        if (subscribedMarkets.length > 0 && ['ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP', 'SWAP_MATCH'].includes(action.action)) {
            for (const market of subscribedMarkets) {
                try {
                    const marketInfo = await this._entityRead(cache && cache.market, market.tick1 + '\u0000' + market.tick2, () => this.db.getMarketInfo(config, market.tick1, market.tick2));
                    if (marketInfo) {
                        this.emit('entity_update', coin, {
                            type:    'MARKET_UPDATE',
                            channel: 'market',
                            data:    marketInfo
                        });
                    }
                } catch (e) {
                    // Non-fatal
                }
            }
        }
    }

    // Emit an ATTESTATION_REQUEST / ATTESTATION_RESPONSE event on the dedicated
    // `attestation` channel when a new ATTEST action lands. The raw action row
    // from getActionsSince doesn't carry the version, so we enrich it from the
    // consolidated `attests` table to tell a v0 request from a v1 response.
    async _emitAttestationEvents(coin, config, action) {
        if (!action || action.action !== 'ATTEST') return;
        try {
            const row = await this.db.getAttestationByActionIndex(config, action.action_index);
            if (!row) return;
            const isResponse = Number(row.version) === 1;
            this.emit('lifecycle_event', coin, {
                type:    isResponse ? 'ATTESTATION_RESPONSE' : 'ATTESTATION_REQUEST',
                action:  'ATTEST',
                channel: 'attestation',
                data: {
                    action_index:    row.action_index,
                    version:         row.version,
                    request_id:      row.request_id,
                    provider_id:     row.provider_id,
                    contract_index:  row.contract_index   || null,
                    request_status:  row.request_status   || null,
                    response_status: row.response_status  || null,
                    block_index:     row.block_index      || null,
                    source:          action.source        || null,
                    status:          action.status        || null
                }
            });
        } catch (e) {
            // Non-fatal: attestation enrichment failure must not break the poll loop
        }
    }

    getState(coin) {
        return this.state[coin] || { blockIndex: 0, actionIndex: 0, closedBlock: 0 };
    }
}

module.exports = ChangeDetector;
// Exposed for the ChannelManager VALID_TYPES conformance test: every lifecycle
// name the types filter accepts must be one this producer actually emits, across
// all three emission paths.
module.exports.LIFECYCLE_MAP = LIFECYCLE_MAP;
module.exports.NON_ACTION_LIFECYCLE_TYPES = NON_ACTION_LIFECYCLE_TYPES;
module.exports.INLINE_LIFECYCLE_TYPES = INLINE_LIFECYCLE_TYPES;
