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
 * WHERE THE METHODS LIVE
 *
 * This file holds the class shell (constructor, the polling loop, the staleness
 * verdict, the missing-table test, getState) and the lifecycle type lists. The
 * cursors and emit paths live in change_detector/, one module per concern, and
 * arrive on ChangeDetector.prototype through mixinParts below:
 *
 *   mempool.js       checkMempoolForCoin, the decoder mempool diff
 *   coin.js          checkCoin, one coin's tip, block and action pass
 *   xcall_phases.js  checkXcallPhases, the XCALL_COMPLETED / XCALL_EXPIRED cursor
 *   bet_latches.js   checkBetLatches, the BET_CLOSED cursor, and nextCursor
 *   lifecycle.js     emitLifecycleEvents and emitAttestationEvents
 *   entities.js      emitEntityUpdates and its per-poll entityRead cache
 *
 * Nothing a caller sees changed: `new ChangeDetector(options)` returns one object
 * carrying every method under the same name with the same `this`, and the three
 * lifecycle lists still hang on the class.
 *
 ********************************************************************/

const EventEmitter = require('events');

// One logger for the whole service. Cached at require time rather than called
// per line: getLogger() hands back a lazy singleton that resolves to the real
// shipper once the entry point installs observability, and falls through to a
// bare console before that, so a module that logs while being required cannot
// kill the process.
const { getLogger } = require('../observability');
const log = getLogger();

// The method families carved out of this file. Each module is authored as a class
// body and exports that class's prototype, so the methods arrive with `this` still
// bound to the ChangeDetector instance and no call site moved.
const mempoolDiff      = require('./change_detector/mempool.js');
const coinPass         = require('./change_detector/coin.js');
const xcallPhaseCursor = require('./change_detector/xcall_phases.js');
const betLatchCursor   = require('./change_detector/bet_latches.js');
const lifecycleEvents  = require('./change_detector/lifecycle.js');
const entityUpdates    = require('./change_detector/entities.js');

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
// XCALL_COMPLETED / XCALL_EXPIRED join it for the same structural reason (spec
// explorer-coverage-completion M5.4): a cross-chain call's terminal transition on
// the SOURCE chain is a direct status write by the callback interlock, so the
// actions cursor never sees it. See checkXcallPhases.
const NON_ACTION_LIFECYCLE_TYPES = ['BET_CLOSED', 'XCALL_COMPLETED', 'XCALL_EXPIRED'];

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
        // Coins whose indexed tip was stale at the last poll. Broadcaster reads it
        // to stamp `stale: true` on every live frame for those coins.
        this.staleCoins     = new Set();
        // How long a coin's BET_CLOSED cursor stays parked after its indexer answers
        // "no bet_feeds table". A schema gap is a deploy-order fact, not a permanent
        // property of the chain, so it is a cooldown rather than a switch: see
        // checkBetLatches. Tests set it to 0 to probe on every poll.
        this.betLatchRetryMs = options.betLatchRetryMs !== undefined
            ? options.betLatchRetryMs
            : 5 * 60 * 1000;

        // Track last known state per coin (e.g., "BTC", "TBTC", "RLTC")
        this.state = {};

        // Track the unconfirmed (decoder mempool) snapshot per coin. Keyed by
        // tx_hash: the mempool table has no monotonic index, so each poll
        // diffs the tx_hash-ordered (capped) window against the previous one;
        // see checkMempoolForCoin for what a saturated window does and does
        // not prove. The value is `{source, action, data}` (`data` being the RAW
        // action string, not a party list) so a removal can name the tx's parties
        // and its action family after its row is already gone from the table; see
        // the emit in checkMempoolForCoin.
        this.mempoolState = {};

        // Polling timer reference
        this.timer   = null;
        this.running = false;
    }

    // Begin the polling loop. Every coin gets a cursor seeded before the timer is
    // armed, and the first cycle runs immediately so subscribers are not waiting a
    // whole interval for the feed to come alive.
    start(coins) {
        if (this.running) return;
        this.running = true;

        for (const coin of coins) {
            if (!this.state[coin]) {
                this.state[coin] = { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false };
            }
            if (!this.mempoolState[coin]) {
                this.mempoolState[coin] = { seenHashes: new Map(), initialized: false };
            }
        }

        this.timer = setInterval(() => this.poll(), this.pollInterval);
        this.poll();

        log.info('CHANGE_DETECTOR_STARTED', { poll_interval_ms: this.pollInterval, coins: coins.join(', ') });
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
    // `typeof this.db.checkReorgAndInvalidate === 'function'` probe in checkCoin.
    async isCoinTipStale(coin) {
        if (!this.db || typeof this.db.isCoinTipStale !== 'function') return false;
        try { return await this.db.isCoinTipStale(coin); }
        catch (e) { return false; }
    }

    // Same opt-in as the HTTP 503 (db.staleFailClosed): skip a stale coin's
    // emits entirely instead of marking them.
    staleFailClosed() {
        return !!(this.db && typeof this.db.staleFailClosed === 'function' && this.db.staleFailClosed());
    }

    // One poll cycle over every tracked coin: staleness verdict first, then the
    // block and action cursors, then the mempool diff. Each coin's two passes are
    // caught separately so one chain's failure cannot stop the others.
    async poll() {
        if (!this.running) return;

        for (const coin of Object.keys(this.state)) {
            // A FROZEN replica emits nothing here anyway (every emit below is
            // triggered by the tip advancing), but a replica REPLAYING history from
            // a snapshot, or catching up after a stall, does advance while its
            // newest block_time is hours old, and its NEW_BLOCK/NEW_ACTION/
            // ADDRESS_UPDATE frames are stamped `timestamp: Date.now()`, which a
            // subscriber would read as the chain tip. Those frames are still sent
            // (a wallet watching an address during a stall must see the rows land),
            // but Broadcaster stamps them `stale: true` while the coin is in this
            // set, matching the HTTP marker. Evaluated once per coin per cycle,
            // which is what the cached verdict is sized for. The fail-closed opt-in
            // keeps the old behaviour: skip the coin, cursors untouched, so the
            // backlog emits normally once the tip catches up.
            const tipStale = await this.isCoinTipStale(coin);
            if (tipStale) this.staleCoins.add(coin); else this.staleCoins.delete(coin);
            if (tipStale && this.staleFailClosed()) continue;

            try {
                await this.checkCoin(coin);
            } catch (e) {
                log.error('CHANGE_DETECTOR_POLL_FAILED', { coin, err: e.message, stack: e.stack });
            }
            try {
                await this.checkMempoolForCoin(coin);
            } catch (e) {
                log.error('CHANGE_DETECTOR_MEMPOOL_POLL_FAILED', { coin, err: e.message, stack: e.stack });
            }
        }
    }

    // "That table does not exist here", seen through the db layer's wrapper. db/index.js
    // rethrows as DbQueryError with its OWN code ('DB_ERROR') and the driver's
    // SqlError on .cause, so testing the top-level error alone never matches a real
    // one: the first cut of this check looked right, passed a unit test built from a
    // hand-made error, and still logged the missing table every poll on the fleet.
    // Walks the cause chain, which is bounded and short.
    isMissingTableError(err) {
        for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
            if (e.code === 'ER_NO_SUCH_TABLE' || Number(e.errno) === 1146) return true;
        }
        return false;
    }

    // A coin's current cursor state, which is what the WELCOME frame a new subscriber
    // receives is built from.
    getState(coin) {
        return this.state[coin] || { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0 };
    }
}

// Copies a carved-out method family onto ChangeDetector.prototype. Object.assign
// cannot do this: a class method is non-enumerable, so assign would copy nothing.
// Copying the descriptor keeps each method non-enumerable, exactly as a class-body
// method is.
//
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the poll would start running another family's code.
function mixinParts(target, ...sources) {
    for (const source of sources) {
        for (const name of Object.getOwnPropertyNames(source)) {
            if (name === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('change_detector.js part mixin collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

mixinParts(ChangeDetector.prototype,
    mempoolDiff, coinPass, xcallPhaseCursor, betLatchCursor, lifecycleEvents, entityUpdates);

// Exposed for the ChannelManager VALID_TYPES conformance test: every lifecycle
// name the types filter accepts must be one this producer actually emits, across
// all three emission paths. Hung on the class rather than on module.exports so
// the file has ONE export shape; the class IS the export, so a requirer reads
// these at the same property names it always did.
ChangeDetector.LIFECYCLE_MAP = LIFECYCLE_MAP;
ChangeDetector.NON_ACTION_LIFECYCLE_TYPES = NON_ACTION_LIFECYCLE_TYPES;
ChangeDetector.INLINE_LIFECYCLE_TYPES = INLINE_LIFECYCLE_TYPES;

module.exports = ChangeDetector;
