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
 * XChain Explorer - pool lifetime, topology guards and the decoder endpoint
 *
 * One part of src/db/connection.js (the entry composes it through
 * composeReaderParts). Everything about the per-coin pool maps except building
 * them: closing every distinct handle, the shutdown close, the throttled lazy
 * rebuild, the decoder JSON-RPC endpoint read out of a coin's config, and the
 * startup assertion that refuses a serving coin with no co-located checkpoint
 * schema.
 *
 * Building the pools stays on the entry (setupConnectionPools, with its steps in
 * connection/pool_setup.js) because that is the one place that calls
 * mariadb.createPool, and the unit suites stub the driver on the entry file
 * itself: proxyquire substitutes only the stubbed module's own direct requires,
 * so a part that required mariadb would open real pools under test.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const { resolveHubUrl } = require('../../mirror/url.js');

// Structured logging. Cached at require time on purpose: getLogger() resolves
// lazily on every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that, which
// is the shape the unit suites see.
const { getLogger } = require('../../observability');
const log = getLogger();

class DatabasePools {
    /******************************************************************
     * Database Connection Pool Functions
     *****************************************************************/

    // Best-effort close of every DISTINCT pool handle held in the given maps.
    // Entries are either {config, pool} wrappers (this.pools) or bare pools
    // (this.decoderPools), and the setup loop deliberately assigns ONE pool
    // object to several keys when they resolve to the same host/port/user/db, so
    // handles are deduped by identity: end() must run once per handle, not once
    // per key. Failures are swallowed because this runs on the way to replacing
    // the map, and a pool that cannot be closed must not block the rebuild.
    async endPools(maps){
        let seen = new Set();
        for(let map of maps){
            if(!map) continue;
            for(let key in map){
                let entry = map[key];
                let pool  = (entry && entry.pool) ? entry.pool : entry;
                if(!pool || typeof pool.end !== 'function' || seen.has(pool)) continue;
                seen.add(pool);
                try { await pool.end(); } catch(e){ /* best-effort */ }
            }
        }
    }

    // Release every pool this instance holds and leave the maps empty. Called from
    // the process shutdown drain (src/http/shutdown.js), which is the only caller: a
    // serving explorer holds its pools for its whole lifetime. Public wrapper over
    // endPools so the drain does not reach into a private method, and so the map
    // list stays in ONE place - a future third pool map added to setupConnectionPools
    // must be added to the endPools call there, and this inherits it.
    async close(){
        await this.endPools([this.pools, this.decoderPools]);
        this.pools        = {};
        this.decoderPools = {};
    }

    // Decoder JSON-RPC endpoint for one coin/network, read out of the config the
    // explorer already holds. Two config shapes reach here and they disagree on
    // what `host`/`port` mean, so the shape is discriminated rather than guessed:
    //
    //   - Hub config (xchain-node's updateconfig push): the xchain-decoder entry
    //     carries db_host/db_port for the DATABASE and host/port for the decoder's
    //     API (SERVICE_REGISTRY maps them from DECODER_URL + DECODER_API_PORT), the
    //     same pair xchain-hub's own resolveIndexerUrl builds an indexer URL from.
    //   - src/config.json: host/port ARE the database and there is no API entry, so
    //     reading them as an endpoint would point the health poll at MariaDB.
    //
    // Hence the db_host/db_port test: only their presence proves the hub shape, in
    // which host/port are free to mean the API. api_url (or api_host + api_port) is
    // an explicit operator override honored in EITHER shape, so a config.json
    // deployment can name the endpoint beside the DB instead of exporting one env
    // var per chain. Returns null when the entry carries nothing usable.
    decoderApiUrlFromConfig(dcfg){
        if(!dcfg || typeof dcfg !== 'object') return null;
        let trim = (v) => this.util.isNull(v) ? '' : String(v).trim();
        // Accept a host written with or without a scheme; default to http, which
        // is what the decoder's API serves (TLS terminates upstream when present).
        let join = (host, port) => {
            host = trim(host).replace(/\/+$/, '');
            port = trim(port);
            if(!host || !port) return null;
            return (/^https?:\/\//i.test(host) ? host : 'http://' + host) + ':' + port;
        };
        let explicitUrl = trim(dcfg.api_url).replace(/\/+$/, '');
        if(explicitUrl) return explicitUrl;
        let explicit = join(dcfg.api_host, dcfg.api_port);
        if(explicit) return explicit;
        if(this.util.isNull(dcfg.db_host) || this.util.isNull(dcfg.db_port)) return null;
        return join(dcfg.host, dcfg.port);
    }

    // Startup assertion: every coin/network this explorer serves (has an indexer
    // pool for) MUST have a checkpoint schema configured (database.checkpoint,
    // same host+credentials as the indexer DB): either a self-synced mirror
    // (database.checkpoint.self_sync plus a hub endpoint - hub_url in the same
    // block, else HUB_API_URL - populated by HubMirrorSyncManager) or an
    // externally-maintained hub schema. Without one
    // the hub-mirrored tables cannot be served, because xchain-sync never
    // replicates them. A missing entry is a fatal misconfiguration: throw a
    // clear, named error so a mis-provisioned thin replica fails to start
    // instead of silently serving empty state_checkpoints /
    // capability_snapshots / cross_chain_matches (#4138), or empty
    // price_snapshots / oracle_prices (items 4062 / 4063).
    // Opt-out: ALLOW_NO_COLOCATED_HUB_DB=1 downgrades the fatal error to a warning,
    // for deployments that intentionally do not expose the hub-mirrored endpoints.
    assertCheckpointDbForServingCoins(){
        let missing = [];
        // A self-synced schema with no hub endpoint is the SAME failure as a missing
        // schema, and a quieter one: the mirror exists, reads succeed, and every row
        // it returns is frozen at whatever the last working writer left, because
        // nothing repopulates it. It went undetected because self_sync arrives in the
        // hub's config push while HUB_API_URL was a container env written at install
        // time, so the two could be emitted under different conditions and the
        // mismatch cost one startup warning. Checked here, at the same fatal tier and
        // behind the same opt-out, so the pairing cannot silently half-exist.
        let unwritable = [];
        for(let key in this.pools){
            let kcfg = this.checkpointDb[key];
            if(!kcfg){ missing.push(key); continue; }
            if(kcfg.selfSync && !resolveHubUrl(kcfg)) unwritable.push(key);
        }
        if(unwritable.length){
            let msg = 'Self-synced checkpoint schema has no hub endpoint for serving coin(s): ' +
                unwritable.join(', ') + '. database.checkpoint.self_sync is set, so the hub-mirrored ' +
                'tables (state_checkpoints, capability_snapshots, cross_chain_matches, price_snapshots, ' +
                'oracle_prices) are expected to be written by this explorer, but no hub URL is ' +
                'configured (neither database.checkpoint.hub_url nor the HUB_API_URL env), so nothing ' +
                'writes them and every read serves stale rows. Set the hub URL, or drop self_sync and ' +
                'point database.checkpoint at an externally-maintained hub schema. Set ' +
                'ALLOW_NO_COLOCATED_HUB_DB=1 to start anyway (hub-mirrored endpoints then fail loud ' +
                'per request instead of serving a mirror nothing updates).';
            if(this.configInfo.env.ALLOW_NO_COLOCATED_HUB_DB === '1'){
                log.warn('CHECKPOINT_HUB_URL_MISSING', { coins: unwritable, detail: msg });
            } else {
                throw new Error(msg);
            }
        }
        if(missing.length){
            let msg = 'Checkpoint schema missing for serving coin(s): ' + missing.join(', ') +
                '. The hub-mirrored tables (state_checkpoints, capability_snapshots, ' +
                'cross_chain_matches, price_snapshots, oracle_prices) are never replicated ' +
                'by xchain-sync and must be served ' +
                'from a local schema on the same server: add a database.checkpoint block ' +
                '(same host + credentials as the indexer DB) for each serving coin/network, ' +
                'either self-synced (self_sync: true + HUB_API_URL) or pointing at an ' +
                'externally-maintained hub schema. Set ALLOW_NO_COLOCATED_HUB_DB=1 to start ' +
                'anyway (hub-mirrored endpoints will fail loud per request instead).';
            if(this.configInfo.env.ALLOW_NO_COLOCATED_HUB_DB === '1'){
                log.warn('CHECKPOINT_SCHEMA_MISSING', { coins: missing, detail: msg });
                return;
            }
            throw new Error(msg);
        }
    }

    // Rebuild connection pools from the current config, at most once per 10s and
    // never concurrently. Used as a lazy recovery path when a query finds no pool
    // (e.g. the explorer came up before the hub and the config arrived later).
    async rebuildPoolsIfStale(){
        let now = Date.now();
        if(this._lastPoolRebuild && (now - this._lastPoolRebuild) < 10000)
            return;
        if(this._poolRebuildPromise)
            return this._poolRebuildPromise;
        this._lastPoolRebuild = now;
        this._poolRebuildPromise = (async () => {
            try { await this.setupConnectionPools(); }
            catch(e){ log.info('POOL_REBUILD_FAILED', { err: e && e.message }); }
            finally { this._poolRebuildPromise = null; }
        })();
        return this._poolRebuildPromise;
    }
}

module.exports = DatabasePools.prototype;
