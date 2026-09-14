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
 * XChain Explorer - connection pools, query execution and the caches
 *
 * Proposal B stage 1: everything between the Database instance and a live
 * MariaDB connection. The per-coin pool set (indexer, decoder, checkpoint and
 * hub-mirror), the topology guards that refuse a misconfigured install, the
 * connect/release pair, the two statement runners (doQuery and its decoder
 * sibling), and the LRU caches whose keys carry the per-coin reorg generation
 * that makes them safe to hold across a rewind.
 *
 * Why these travel together: the caches are keyed by the reorg generation the
 * pool layer bumps, and doQuery is the only place a pool failure turns into a
 * DbQueryError rather than an empty result. Splitting the three would put a
 * cache invalidation in one file and the event that drives it in another.
 * So they still reach db/index.js as ONE object, exported below; only the
 * source is read from several files, because together they run past the size
 * a file should have:
 *
 *   - connection/cache.js      the LRU helpers, the action cacheability rule and
 *                              both per-coin generations (reorg and tip)
 *   - connection/pools.js      closing and lazily rebuilding the pool maps, the
 *                              decoder endpoint and the checkpoint-schema guard
 *   - connection/pool_setup.js the steps setupConnectionPools runs for each
 *                              coin/network (plain functions, not methods)
 *   - this file                setupConnectionPools itself, connect/release and
 *                              the two statement runners
 *
 * setupConnectionPools and the runners stay here because this file is the one
 * that requires mariadb. The unit suites stub the driver on this file by
 * proxyquire, which substitutes only this file's own direct requires, so the
 * driver is handed to pool_setup.js as an argument rather than required there.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as class bodies (this file's and each part's) and
 * composeReaderParts folds their prototypes into the one object exported here,
 * so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const mariadb = require('mariadb');
const { DbQueryError } = require('./shared.js');
const { composeReaderParts } = require('./reader_parts.js');
const { resetPoolMaps, setNetworkPools } = require('./connection/pool_setup.js');

// The two method parts this entry composes with its own class body below.
const cacheMethods = require('./connection/cache.js');
const poolMethods  = require('./connection/pools.js');

// Structured logging. Cached at require time on purpose: getLogger() resolves
// lazily on every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that, which
// is the shape the unit suites see.
const { getLogger } = require('../observability');
const log = getLogger();

class DatabaseConnection {
    async setupConnectionPools(){
        let coinConfigs = await this.configInfo.getConfig()

        // End previous pools before discarding the maps. Without this, any
        // re-entry to setup (config refresh, manual reload) reassigns
        // this.pools and orphans the prior mariadb.createPool() handles;
        // their kept-alive connections linger until the explorer process
        // exits, and MariaDB hits its max_connections ceiling in minutes
        // once refresh is active.
        //
        // decoderPools was missed when the guard above was first written, and it
        // is the DEFAULT shape rather than an edge case, because xchain-node
        // installs provision per-service DB users and so always take the
        // dedicated-pool branch below. rebuildPoolsIfStale() re-enters here as
        // often as every 10s, so the omission leaked the decoder pool's 3
        // connections per coin per rebuild: one live regtest explorer had
        // accumulated 870 of that server's 1000 connections over four days, which
        // surfaced as OTHER services being unable to connect at all.
        await this.endPools([this.pools, this.decoderPools]);

        resetPoolMaps(this);
        let networks = ['mainnet', 'testnet', 'regtest'];
        for(let coin in coinConfigs){
            let info = coinConfigs[coin];
            if(info.mainnet || info.testnet || info.regtest){
                for(let net in info){
                    // Only a known network whose config names an indexer database
                    // can back a pool set.
                    if(networks.includes(net) && !this.util.isNull(info[net].database) && !this.util.isNull(info[net].database.indexer))
                        setNetworkPools(this, mariadb, info, coin, net);
                }
            }
        }

        // Mandatory co-located mirror invariant (#4138). The hub-mirrored tables
        // (state_checkpoints, capability_snapshots, cross_chain_matches) are NEVER
        // replicated by xchain-sync, so a serving coin with no checkpoint schema
        // (self-synced via HubMirrorSyncManager, or externally maintained) has
        // only a stale/empty bootstrap copy. Fail loud at startup rather than
        // letting a thin replica silently serve empty hub-mirror data with no alarm.
        this.assertCheckpointDbForServingCoins();
    }

    /******************************************************************
     * Common database connection functions (connect / release)
     *****************************************************************/

    async getConnection(config){
        if(this.transactionConnection)
            return this.transactionConnection;
        let connection = null,
            retryCount = 0,
            maxRetrys  = 3;
        let pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
        // Lazy recovery: a missing pool usually means the explorer started before
        // the hub was reachable and never built pools for this coin. Rebuild from
        // current config once (throttled) and retry, rather than failing every
        // read until a manual restart.
        if(!pool){
            await this.rebuildPoolsIfStale();
            pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
        }
        if(pool){
            while(connection == null){
                try {
                    connection = await pool.getConnection();
                } catch (e){
                    if(this.configInfo.env.DEBUG) log.debug('DB_CONNECTION_ERROR', { coin: config && config.coin, err: e && e.message ? e.message : e });
                    connection = null;
                    if(retryCount <= maxRetrys){
                        retryCount++;
                        log.info('DB_CONNECT_RETRY', { coin: config && config.coin, attempt: retryCount });
                        await this.util.sleep(1000);
                    } else {
                        log.info('DB_CONNECT_FAILED', { coin: config && config.coin, attempts: maxRetrys });
                        break;
                    }
                }
            }
        } else {
            log.info('DB_POOL_UNAVAILABLE', { coin: config && config.coin });
        }
        this.transactionConnection = connection;
        return connection;
    }

    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    // Run a decoder-DB read. Same-credentials deployments reuse the indexer
    // pool (the query is database-qualified); xchain-node installs (per-service
    // DB users) run on the dedicated per-coin decoder pool created at init.
    async doDecoderQuery(config, query, args){
        let dedicated = this.decoderPools ? this.decoderPools[config.coin] : null;
        return this.doQuery(config, query, args, dedicated || null);
    }

    // Runs a read and returns the rows. A GENUINE failure (no pool, connection
    // unavailable after retries, or a rejected statement) THROWS a DbQueryError
    // rather than returning a falsy value (M-4). A swallowed-into-false failure
    // is indistinguishable at the call site from a successful empty SELECT, so a
    // transient outage would render as "no data" (an address showing zero
    // balance). The request layer catches DbQueryError and answers 5xx; a
    // successful query still returns its (possibly empty) array, so a genuinely
    // empty result stays 200. A null query is an explicit no-op and returns false
    // (not a failure). Callers that must tolerate an outage (the /status health
    // read, the WS poll loops, decoder-tip reads) wrap their own calls.
    async doQuery(config, query, args, poolOverride = null){
        if(this.util.isNull(query)) return false;
        let pool = poolOverride || ((this.pools[config.coin]) ? this.pools[config.coin].pool : null);
        if(!pool){
            log.info('DB_POOL_UNAVAILABLE', { coin: config && config.coin });
            throw new DbQueryError('No database connection pool for ' + (config && config.coin));
        }
        let db = null,
            retryCount = 0,
            maxRetrys  = 3;
        while(db === null){
            try {
                db = await pool.getConnection();
            } catch (e){
                if(this.configInfo.env.DEBUG) log.debug('DB_CONNECTION_ERROR', { coin: config && config.coin, err: e && e.message ? e.message : e });
                db = null;
                if(retryCount <= maxRetrys){
                    retryCount++;
                    log.info('DB_CONNECT_RETRY', { coin: config && config.coin, attempt: retryCount });
                    await this.util.sleep(1000);
                } else {
                    log.info('DB_CONNECT_FAILED', { coin: config && config.coin, attempts: maxRetrys });
                    throw new DbQueryError('Database connection unavailable after ' + maxRetrys + ' retries', e);
                }
            }
        }
        let result = false;
        try {
            result = await db.query(query, args);
        } catch (error){
            if(this.configInfo.env.DEBUG) log.debug('SQL_QUERY_ERROR', { coin: config && config.coin, err: error && error.message, stack: error && error.stack });
            else log.error('SQL_QUERY_FAILED', { coin: config && config.coin, err: error.message, stack: error.stack });
            throw new DbQueryError('SQL query failed: ' + (error && error.message), error);
        } finally {
            db.release();
        }
        return result;
    }
}

module.exports = composeReaderParts(DatabaseConnection.prototype, cacheMethods, poolMethods);
