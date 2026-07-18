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
 * Runs the vendored HubDbSync client (see src/hub_db_sync.js, canonical in
 * xchain-indexer) for every checkpoint DB the explorer is configured to
 * SELF-SYNC, so an explorer node maintains its own local mirror of the hub's
 * consensus tables (state_checkpoints, capability_snapshots,
 * cross_chain_matches, cross_chain_calls, oracle_prices, price_snapshots)
 * instead of requiring a hub-owned schema to be provisioned next to it
 * (#4138 decoupling). The read path is unchanged: db.js keeps reading the
 * schema named by database.checkpoint on the indexer pool; this manager is
 * only the writer that populates it.
 *
 * Opt-in per coin/network via database.checkpoint.self_sync = true, plus
 * HUB_API_URL (and HUB_API_KEY when the hub gates its feed). With no
 * self_sync flags set this manager is a no-op and deployments that point
 * database.checkpoint at an externally-maintained hub schema behave exactly
 * as before.
 *
 * One client instance runs per UNIQUE (host, port, schema) target, not per
 * coin: the hub feed is platform-global (its tables carry every chain), so
 * two coins sharing one mirror schema must not double-subscribe. Lifecycle
 * follows the IconDownloader precedent: constructed in XChainExplorer.init(),
 * start()/stop(), failures logged rather than fatal (HubDbSync reconnects and
 * re-bootstraps on its own).
 *
 ********************************************************************/

const HubDbSync     = require('./hub_db_sync.js');
const HubMirrorPool = require('./hub-mirror-pool.js');
const { ensureMirrorColumns } = require('./hub-mirror-migrate.js');
const path          = require('path');

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
            if(!process.env.HUB_API_URL){
                console.error('[hub-mirror] database.checkpoint.self_sync is set for ' + coinKey +
                    ' but HUB_API_URL is not configured; mirror will not sync.');
                continue;
            }
            let key = t.host + '|' + t.port + '|' + t.name;
            let inst = this.instances.get(key);
            if(inst){
                inst.coins.push(coinKey);
                continue;
            }
            inst = { target: t, coins: [coinKey], pool: null, sync: null };
            this.instances.set(key, inst);
            try {
                inst.pool = new HubMirrorPool(t);
                // Schema, then tables, then the client: HubDbSync must never start
                // against missing tables (empty SHOW COLUMNS poisons its per-table
                // column cache; see the 2026-06-17 cold-start regression).
                await inst.pool.ensureDatabase();
                await HubDbSync.ensureTables(inst.pool, path.join(__dirname, 'sql', 'hub-mirror'));
                // ensureTables never ALTERs an existing table, so a schema
                // created before the price_snapshots retraction columns landed
                // needs this additive drift reconciler . Runs before
                // the client starts so its per-table column cache sees the
                // migrated shape.
                await ensureMirrorColumns(inst.pool);
                inst.sync = new HubDbSync(inst.pool, { coin: t.chain });
                // start() rejects when the hub is unreachable at boot; the client
                // keeps reconnecting/re-bootstrapping on its own after that, and the
                // staleness surface reports bootstrapDrained=false meanwhile.
                inst.sync.start().catch((err) => {
                    console.error('[hub-mirror] sync start failed for ' + key + ': ' +
                        (err && err.message ? err.message : err));
                });
                console.log('[hub-mirror] self-sync started for ' + key + ' (coins: ' + inst.coins.join(',') + ')');
            } catch (err){
                console.error('[hub-mirror] failed to initialize mirror for ' + key + ': ' +
                    (err && err.stack ? err.stack : err));
            }
        }
    }

    async stop(){
        for(const inst of this.instances.values()){
            try { if(inst.sync) inst.sync.stop(); } catch(_){}
            try { if(inst.pool) await inst.pool.end(); } catch(_){}
        }
        this.instances.clear();
        this._started = false;
    }

    // Status snapshot for the observability endpoint and per-request lag gating.
    // streamWatermark is the hub's "delivered through" signal in epoch seconds
    // (0 until the first heartbeat); bootstrapDrained distinguishes an empty
    // mirror that never completed a REST bootstrap from a quiet-but-live one.
    statusForCoin(coinKey){
        let inst = this.instanceForCoin(coinKey);
        if(!inst) return null;
        let sync = inst.sync;
        let watermark = sync ? Number(sync.streamWatermark) || 0 : 0;
        return {
            enabled:           true,
            target:            { host: inst.target.host, name: inst.target.name },
            bootstrapDrained:  !!(sync && sync._bootstrapDrained),
            streamWatermark:   watermark,
            mirrorLagSeconds:  watermark > 0 ? Math.max(0, Math.round(Date.now() / 1000 - watermark)) : null
        };
    }
}

module.exports = HubMirrorSyncManager;
