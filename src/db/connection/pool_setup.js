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
 * XChain Explorer - the steps that build one coin/network's pool set
 *
 * setupConnectionPools on src/db/connection.js walks every coin and network in
 * the config and hands each usable entry to setNetworkPools below, which fills
 * the Database instance's per-coin maps in four steps: the base chain name and
 * decoder API endpoint, the indexer pool, the decoder database (and its
 * dedicated pool when the credentials differ), and the checkpoint-source schema.
 *
 * These are plain functions, not methods, and they take the Database instance
 * (`db`) and the mariadb driver as arguments. The driver is passed in rather
 * than required here because the unit suites stub it on connection.js itself,
 * and proxyquire substitutes only that file's own direct requires: a require of
 * mariadb in this file would escape the stub and open real pools under test.
 * Being functions also keeps them off Database.prototype, whose method list is
 * pinned.
 *
 ********************************************************************/

'use strict';

const poolSizing = require('../../mirror/pool_sizing');

// Empty every per-coin map setup is about to refill. Runs after the previous
// pools were ended, so nothing still references a handle these maps held.
function resetPoolMaps(db){
    db.pools = {};
    // Per-coin decoder database name, used for the colocated-decoder reads
    // (decoder tip for /api/status lag, mempool rows, raw FILE bytes).
    // When the decoder DB shares server + credentials with the indexer DB
    // the reads reuse the indexer pool with database-qualified queries;
    // otherwise a DEDICATED per-coin pool is created (decoderPools below).
    db.decoderDb = {};
    // Per-coin dedicated decoder-DB pools, created when the decoder DB does
    // NOT share credentials with the indexer DB (the norm on xchain-node
    // installs, which provision per-service DB users. Same-credentials
    // deployments make no entry here and reuse the indexer pool.
    db.decoderPools = {};
    // Per-coin decoder JSON-RPC endpoint (NOT a database), derived from the
    // same config entry the decoder pool above is built from. Feeds the
    // chain_tip / chain_lag_blocks / decoder_health block of /api/status,
    // which is the only place the chain->decoder gap is visible: the
    // explorer reads DBs only, so a decoder stalled behind its coin node
    // still reports decoder_lag_blocks 0 once the indexer catches up to it.
    // Absent for a coin whose config carries no endpoint; that coin reports
    // decoder_health 'unconfigured'. See decoderApiUrlFromConfig.
    db.decoderApiUrl = {};
    // Per-coin checkpoint-source database: the MANDATORY co-located hub DB for
    // serving the hub-mirrored tables (state_checkpoints, capability_snapshots,
    // cross_chain_matches, price_snapshots, oracle_prices). xchain-sync excludes
    // these tables from every snapshot and stream, so a serving node has no
    // replicated copy and MUST read them from the hub DB on the same server via a
    // per-network `checkpoint` config block, honored only when it shares server +
    // credentials with the indexer pool and read database-qualified, filtered by
    // chain/network so the per-coin endpoints don't leak siblings. This is a hard
    // requirement: a serving coin with no entry here makes checkpointSource /
    // matchSource / oracleMirrorSource throw instead of falling back to a stale
    // local mirror, and assertCheckpointDbForServingCoins() turns the same gap
    // into a fatal startup error so a misconfigured thin replica never silently
    // serves empty hub data.
    db.checkpointDb = {};
    // Per-key base chain name (RBTC → 'BTC'), used by the project-registry
    // queries to honor only same-chain LINKs (LINK skips owner validation
    // when COIN2 is remote; see protocol/project-registry.md).
    db.baseCoin = {};
}

// Fill the maps for one coin/network whose config carries an indexer database
// entry. `info` is the coin's whole config block and `net` the network key in it.
function setNetworkPools(db, mariadb, info, coin, net){
    let cfg  = info[net].database.indexer;
    // Remap host/port to db_host/db_port if needed (e.g. local config.json)
    if(!("db_host" in cfg) && ("host" in cfg)) cfg.db_host = cfg.host;
    if(!("db_port" in cfg) && ("port" in cfg)) cfg.db_port = cfg.port;
    let key  = coin;
    if(net=='testnet') key = 'T' + coin;
    if(net=='regtest') key = 'R' + coin;
    // Record the base chain name for this key (RBTC -> BTC):
    // LINK/LIST rows store the bare chain name in index_coins
    db.baseCoin[key] = coin;
    // Decoder JSON-RPC endpoint for this coin/network, if the
    // config carries one. Resolved here rather than in the pool
    // branch below so a coin whose indexer entry is not usable
    // as a pool can still report decoder health.
    let dApiUrl = db.decoderApiUrlFromConfig(info[net].database.decoder);
    if(dApiUrl) db.decoderApiUrl[key] = dApiUrl;
    // An entry with no database host and port cannot back a pool, so the pool,
    // decoder and checkpoint steps are skipped for it.
    if (("db_host" in cfg) && ("db_port" in cfg)){
        setIndexerPool(db, mariadb, cfg, key);
        setDecoderPool(db, mariadb, info[net].database.decoder, cfg, key);
        setCheckpointDb(db, info[net].database.checkpoint, cfg, key, coin, net);
    }
}

// The indexer pool for one key: reuse a pool another key already opened on the
// same server, credentials and database, otherwise open a new one.
function setIndexerPool(db, mariadb, cfg, key){
    let pool = false;
    db.pools[key] = {
        "config": {
            host:     cfg.db_host,
            port:     cfg.db_port,
            user:     cfg.user,
            password: cfg.pass,
            database: cfg.name,
            // Connection options. The indexer default of 10
            // matches xchain-indexer, xchain-decoder, and
            // xchain-hub; the previous 25 pushed total demand
            // past MariaDB's default max_connections=151 once
            // 3+ coins were active. Sized per dbType via
            // DB_POOL_SIZE_INDEXER (see src/mirror/pool_sizing.js), since
            // the indexer and decoder pools carry very
            // different loads.
            connectionLimit:  poolSizing.resolvePoolSize('indexer'),
            //connectTimeout: 0,
            insertIdAsNumber: true,
            queryTimeout:     poolSizing.resolveQueryTimeout('indexer')
        }
    };
    // Reuse an existing pool ONLY when it targets the SAME database too.
    // A MariaDB pool is bound to one default database (`database:` above)
    // and the explorer issues unqualified queries (e.g. `FROM blocks`)
    // that run against it. The old code shared a pool across entries with
    // the same host/port/user/pass but DIFFERENT databases, so when every
    // coin used one MariaDB user (e.g. the single-server NO_HUB deployment
    // reading synced DBs) all 9 collapsed onto the first pool and every
    // coin served the first database's data (BTC). Including the database
    // name keeps per-DB pools correct; 9 coin/networks is <=90 connections,
    // under MariaDB's default max_connections=151. (Uses the normalized
    // db_host/db_port so config.json and hub-config both match.)
    for(let existingKey in db.pools){
        let data = db.pools[existingKey];
        if( cfg.db_host==data.config.host &&
            cfg.db_port==data.config.port &&
            cfg.user==data.config.user &&
            cfg.pass==data.config.password &&
            cfg.name==data.config.database &&
            !db.util.isNull(data.pool) )
            pool = data.pool;
    }
    if(!pool)
        pool = mariadb.createPool(db.pools[key].config);

    db.pools[key].pool = pool;
}

// Record the decoder DB name for this coin so /api/status can
// read the decoder tip (decoder's highest processed block), serve
// mempool rows, and serve raw FILE bytes. Same credentials as the
// indexer DB → reuse this indexer pool with database-qualified
// queries; different credentials (xchain-node installs provision
// per-service DB users) → create a DEDICATED decoder pool so the
// colocated-decoder features still work.
function setDecoderPool(db, mariadb, dcfg, cfg, key){
    if(dcfg && !db.util.isNull(dcfg.name)){
        let dHost = ("db_host" in dcfg) ? dcfg.db_host : dcfg.host;
        let dPort = ("db_port" in dcfg) ? dcfg.db_port : dcfg.port;
        if(!db.util.isNull(dHost) && !db.util.isNull(dPort)){
            db.decoderDb[key] = dcfg.name;
            if(!(dHost==cfg.db_host && dPort==cfg.db_port && dcfg.user==cfg.user && dcfg.pass==cfg.pass)){
                db.decoderPools[key] = mariadb.createPool({
                    host:             dHost,
                    port:             dPort,
                    user:             dcfg.user,
                    password:         dcfg.pass,
                    database:         dcfg.name,
                    // Smaller than the indexer pool: decoder
                    // reads are low-volume (status tip, mempool
                    // page, raw FILE bytes). Tunable on its own
                    // via DB_POOL_SIZE_DECODER, because at the
                    // old hardcoded 3 a busy mempool/FILE view
                    // queued behind three connections with no
                    // knob to raise it.
                    connectionLimit:  poolSizing.resolvePoolSize('decoder'),
                    insertIdAsNumber: true,
                    queryTimeout:     poolSizing.resolveQueryTimeout('decoder')
                });
            }
        }
    }
}

// Record the checkpoint-source DB name for this coin (see
// the checkpointDb note above); same same-server/same-creds
// rule as decoderDb, read by reusing this indexer pool.
// self_sync marks a mirror schema this explorer populates
// itself via HubMirrorSyncManager (the self-sync decoupling)
// rather than an externally-maintained hub schema; the
// connection details ride along so the mirror writer can
// open its own small pool on the same server.
function setCheckpointDb(db, kcfg, cfg, key, coin, net){
    if(kcfg && !db.util.isNull(kcfg.name)){
        let kHost = ("db_host" in kcfg) ? kcfg.db_host : kcfg.host;
        let kPort = ("db_port" in kcfg) ? kcfg.db_port : kcfg.port;
        if(kHost==cfg.db_host && kPort==cfg.db_port && kcfg.user==cfg.user && kcfg.pass==cfg.pass)
            db.checkpointDb[key] = {
                name: kcfg.name, chain: coin, network: net,
                selfSync: kcfg.self_sync === true || kcfg.self_sync === 'true',
                // The hub endpoint the mirror writer follows,
                // carried in the SAME config block as self_sync
                // so the two cannot arrive by different paths
                // (the HUB_API_URL env remains the fallback;
                // see src/mirror/url.js).
                hubUrl: db.util.isNull(kcfg.hub_url) ? '' : String(kcfg.hub_url),
                host: kHost, port: kPort, user: kcfg.user, pass: kcfg.pass
            };
    }
}

module.exports = { resetPoolMaps, setNetworkPools };
