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
 * XChain Explorer - Hub-mirror sync manager
 *
 * Runs the vendored HubDbSync client (see src/hub/hub_db_sync.js, canonical in
 * xchain-indexer) for every checkpoint DB the explorer is configured to
 * SELF-SYNC, so an explorer node maintains its own local mirror of the hub's
 * consensus tables (state_checkpoints, capability_snapshots,
 * cross_chain_matches, cross_chain_calls, oracle_prices, price_snapshots,
 * bridge_transfers, policy_snapshots)
 * instead of requiring a hub-owned schema to be provisioned next to it
 * (the self-sync decoupling). The read path is unchanged: db/index.js keeps reading the
 * schema named by database.checkpoint on the indexer pool; this manager is
 * only the writer that populates it.
 *
 * Opt-in per coin/network via database.checkpoint.self_sync = true, plus hub
 * seeds or a pinned REST base URL (see mirror/url.js) and HUB_API_KEY when the
 * hub gates its feed. With no
 * self_sync flags set this manager is a no-op and deployments that point
 * database.checkpoint at an externally-maintained hub schema behave exactly
 * as before.
 *
 * A self_sync target with NO hub endpoint is a misconfiguration, not a mode: the
 * mirror schema has no writer, so every hub-mirrored read serves whatever rows
 * it last held, indefinitely. db/index.js refuses to start on that pairing; when the
 * operator downgrades that to a warning (ALLOW_NO_COLOCATED_HUB_DB=1) the
 * target is still REGISTERED here, as an unconfigured instance, so managesCoin()
 * reports true and the staleness gate fails those routes loud per request
 * instead of the process warning once at boot and serving stale rows forever.
 *
 * One client instance runs per UNIQUE (host, port, schema) target, not per
 * coin: the hub feed is platform-global (its tables carry every chain), so
 * two coins sharing one mirror schema must not double-subscribe. Lifecycle
 * follows the IconDownloader precedent: constructed in XChainExplorer.init(),
 * start()/stop(), failures logged rather than fatal. Initialization retries
 * locally. A client that starts successfully reconnects on its own; a start
 * rejection returns to this manager's initialization retry.
 *
 ********************************************************************/

const HubDbSync     = require('../hub/hub_db_sync.js');
const HubMirrorPool = require('./pool.js');
const { ensureMirrorColumns } = require('./migrate.js');
const { buildHubSelector }    = require('./hub_selection.js');
// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('../observability');
const log = getLogger();
const path          = require('path');

// How often an unconfigured self_sync target re-reports itself. A single boot
// line scrolls out of a busy log within minutes, which is how this defect
// survived: the explorer kept serving the frozen mirror with nothing in the
// live log to say so.
const UNCONFIGURED_WARN_INTERVAL_MS = 5 * 60 * 1000;
const INIT_RETRY_BASE_MS = 2 * 1000;
const INIT_RETRY_CAP_MS = 5 * 60 * 1000;
const INIT_RETRY_JITTER = 0.2;

function retryDelay(attempt){
    const base = Math.min(INIT_RETRY_CAP_MS, INIT_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(base * (1 - INIT_RETRY_JITTER + Math.random() * INIT_RETRY_JITTER * 2));
}

function errorCode(err){
    return err && err.code ? String(err.code) : 'INIT_ERROR';
}

async function cleanFailedInstance(inst){
    try { if(inst.sync) inst.sync.stop(); } catch(_){}
    inst.sync = null;
    const pool = inst.pool;
    inst.pool = null;
    try { if(pool) await pool.end(); } catch(_){}
}

function scheduleRetry(inst, t, key){
    const delay = retryDelay(inst.initAttempts);
    inst.nextInitRetryAt = Date.now() + delay;
    inst.retryTimer = setTimeout(() => {
        inst.retryTimer = null;
        if(inst.cancelled) return;
        inst.initPromise = startMirrorInstance(inst, t, key);
    }, delay);
    if(inst.retryTimer && typeof inst.retryTimer.unref === 'function') inst.retryTimer.unref();
    return delay;
}

async function failInstance(inst, t, key, err){
    await cleanFailedInstance(inst);
    inst.initFailed = true;
    inst.lastInitErrorCode = errorCode(err);
    let retryInMs = null;
    if(!inst.cancelled && inst.lastInitErrorCode !== 'UNSAFE_SCHEMA_NAME' && !inst.retryTimer)
        retryInMs = scheduleRetry(inst, t, key);
    log.error('HUB_MIRROR_INIT_FAILED', {
        target: key, attempt: inst.initAttempts, retryInMs,
        err: err && err.message ? err.message : err, stack: err && err.stack
    });
}

// Bring up one registered mirror target: pool, schema, tables, column drift,
// then the client. A host reboot can start this process before the database;
// failed initialization retries with capped backoff without blocking other targets.
async function startMirrorInstance(inst, t, key){
    inst.initAttempts = (inst.initAttempts || 0) + 1;
    try {
        if(!/^[A-Za-z0-9_$]+$/.test(String(t.name))){
            const err = new Error('hub-mirror schema name is not a safe identifier');
            err.code = 'UNSAFE_SCHEMA_NAME';
            throw err;
        }
        inst.pool = new HubMirrorPool(t);
        // Schema, then tables, then the client: HubDbSync must never start
        // against missing tables (empty SHOW COLUMNS poisons its per-table
        // column cache; see the 2026-06-17 cold-start regression).
        await inst.pool.ensureDatabase();
        if(inst.cancelled) return cleanFailedInstance(inst);
        await HubDbSync.ensureTables(inst.pool, path.join(__dirname, '..', 'sql', 'hub-mirror'));
        if(inst.cancelled) return cleanFailedInstance(inst);
        // ensureTables never ALTERs an existing table, so a schema adopted
        // without the retraction and item-5308 fence columns (price_snapshots,
        // oracle_prices, cross_chain_matches, cross_chain_calls) needs this
        // additive drift reconciler. Runs before the client starts so its
        // per-table column cache sees the migrated shape.
        await ensureMirrorColumns(inst.pool);
        if(inst.cancelled) return cleanFailedInstance(inst);
        // network is what lets the client scope its bootstrap cursor and purge
        // rows a different hub served. Without it a mirror that once followed
        // another network keeps those rows, and because the apply is id-parity
        // INSERT IGNORE they sit on the ids the real rows need, so the mirror
        // can never refill itself.
        // Keep the initial address and selector aligned for every client.
        inst.sync = new HubDbSync(inst.pool, {
            coin: t.chain, network: t.network,
            hubUrl: inst.hubUrl, selector: inst.selector
        });
        // Keep explorer startup independent of the initial mirror bootstrap. A
        // rejection before the client enables its own recovery returns here.
        const sync = inst.sync;
        sync.start().catch(async (err) => {
            log.error('HUB_MIRROR_SYNC_START_FAILED', { target: key, err: err && err.message ? err.message : err });
            if(inst.cancelled || inst.sync !== sync) return;
            await failInstance(inst, t, key, err);
        });
        inst.initFailed = false;
        inst.lastInitErrorCode = null;
        inst.nextInitRetryAt = null;
        log.info('HUB_MIRROR_SYNC_STARTED', { target: key, coins: inst.coins.join(',') });
    } catch (err){
        await failInstance(inst, t, key, err);
    } finally {
        inst.initPromise = null;
    }
}

class HubMirrorSyncManager {

    constructor(explorer){
        this.explorer = explorer;
        this.util     = explorer.util;
        // key: host|port|schema -> { pool, sync, target, coins: [key, ...] }
        this.instances = new Map();
        this._started  = false;
    }

    // True when this coin key (BTC/TBTC/...) is served by a self-synced mirror
    // this manager runs; used by the staleness surface to decide whether
    // mirror-lag gating applies to a request.
    managesCoin(coinKey){
        for(const inst of this.instances.values())
            if(inst.coins.includes(coinKey)) return true;
        return false;
    }

    // The manager instance serving a coin key, or null.
    instanceForCoin(coinKey){
        for(const inst of this.instances.values())
            if(inst.coins.includes(coinKey)) return inst;
        return null;
    }

    async start(){
        if(this._started) return;
        this._started = true;

        let targets = this.explorer.db.checkpointDb || {};
        for(const coinKey in targets){
            let t = targets[coinKey];
            if(!t.selfSync) continue;
            let key = t.host + '|' + t.port + '|' + t.name;
            let inst = this.instances.get(key);
            if(inst){
                inst.coins.push(coinKey);
                continue;
            }
            let selector = buildHubSelector(t);
            if(!selector){
                // Registered, not skipped: an unconfigured instance is what makes
                // managesCoin() true for this coin, which is what makes the gate in
                // XChainExplorer.mirrorGate() refuse the consensus routes instead of
                // serving a mirror nothing writes. Reached only when the operator
                // downgraded the db/index.js startup refusal with ALLOW_NO_COLOCATED_HUB_DB=1.
                inst = { target: t, coins: [coinKey], pool: null, sync: null,
                         hubUrl: '', selector: null, unconfigured: true, warnedAt: 0 };
                this.instances.set(key, inst);
                this.warnUnconfigured(inst);
                continue;
            }
            inst = {
                target: t, coins: [coinKey], pool: null, sync: null,
                hubUrl: selector.current(), selector, unconfigured: false,
                cancelled: false, retryTimer: null, initPromise: null,
                initAttempts: 0, initFailed: false
            };
            this.instances.set(key, inst);
            inst.initPromise = startMirrorInstance(inst, t, key);
            await inst.initPromise;
        }
    }

    async stop(){
        for(const inst of this.instances.values()){
            inst.cancelled = true;
            if(inst.retryTimer) clearTimeout(inst.retryTimer);
            inst.retryTimer = null;
            try { if(inst.sync) inst.sync.stop(); } catch(_){}
            try { if(inst.pool) await inst.pool.end(); } catch(_){}
            inst.sync = null;
            inst.pool = null;
        }
        this.instances.clear();
        this._started = false;
    }

    // Re-report an unconfigured self_sync target, at most once per interval per
    // instance. Called from start() and from every status read, so the condition
    // stays visible in the log for as long as it lasts instead of scrolling away
    // after boot.
    warnUnconfigured(inst){
        let now = Date.now();
        if(inst.warnedAt && (now - inst.warnedAt) < UNCONFIGURED_WARN_INTERVAL_MS) return;
        inst.warnedAt = now;
        log.error('HUB_MIRROR_HUB_URL_MISSING', {
            coins: inst.coins.join(','), schema: inst.target.name,
            detail: 'database.checkpoint.self_sync is set but no hub endpoint is configured (neither ' +
                'database.checkpoint.hub_seed_urls, HUB_SEED_URLS, database.checkpoint.hub_url nor ' +
                'HUB_API_URL); the mirror schema has NO writer, so its ' +
                'hub-mirrored tables are frozen at whatever they last held. Consensus routes for these coins ' +
                'fail closed until this is fixed: set hub seeds or a hub URL, or drop self_sync and point ' +
                'database.checkpoint at an externally-maintained hub schema.'
        });
    }

    // Status snapshot for the observability endpoint and per-request lag gating.
    // streamWatermark is the hub's "delivered through" signal in epoch seconds
    // (0 until the first heartbeat); bootstrapDrained distinguishes an empty
    // mirror that never completed a REST bootstrap from a quiet-but-live one.
    // configured:false is the third state: a self_sync target with no hub URL,
    // which is neither live nor merely slow and must never read as either.
    statusForCoin(coinKey){
        let inst = this.instanceForCoin(coinKey);
        if(!inst) return null;
        if(inst.unconfigured){
            this.warnUnconfigured(inst);
            return {
                enabled:           true,
                configured:        false,
                reason:            'HUB_URL_MISSING',
                target:            { host: inst.target.host, name: inst.target.name },
                bootstrapDrained:  false,
                everBootstrapped:  false,
                streamWatermark:   0,
                mirrorLagSeconds:  null
            };
        }
        let sync = inst.sync;
        let watermark = sync ? Number(sync.streamWatermark) || 0 : 0;
        let drained = !!(sync && sync._bootstrapDrained);
        // bootstrapDrained drops on every socket close (the heartbeat gate must close until
        // the reconnect re-drain), so it cannot tell a mirror that never bootstrapped from
        // one mid-reconnect. everBootstrapped latches the first drain; a stream watermark
        // above zero proves one too, as it only advances after a completed drain, which
        // covers a drain and close that fell between two status reads.
        if(drained || watermark > 0) inst.everBootstrapped = true;
        const status = {
            enabled:           true,
            configured:        true,
            target:            { host: inst.target.host, name: inst.target.name },
            bootstrapDrained:  drained,
            everBootstrapped:  !!inst.everBootstrapped,
            streamWatermark:   watermark,
            mirrorLagSeconds:  watermark > 0 ? Math.max(0, Math.round(Date.now() / 1000 - watermark)) : null
        };
        if(inst.initFailed) Object.assign(status, {
            initFailed: true,
            initAttempts: inst.initAttempts,
            lastInitErrorCode: inst.lastInitErrorCode,
            nextInitRetryAt: inst.nextInitRetryAt || null
        });
        return status;
    }
}

module.exports = HubMirrorSyncManager;
