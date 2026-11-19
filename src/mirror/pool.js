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
 * XChain Explorer - Hub-mirror pool wrapper
 *
 * Minimal single-schema MariaDB pool exposing the doQuery(sql, args)
 * interface the vendored HubDbSync client expects. The explorer's own
 * Database class is a multi-coin read layer built around per-request
 * config, so the mirror writer gets its own small dedicated pool bound
 * to the mirror schema instead.
 *
 ********************************************************************/

const mariadb = require('mariadb');
const poolSizing = require('./pool_sizing');
const { getSqlTiming } = require('../observability');

// The statement limit for schema DDL, matching the indexer migration runner's default.
const DDL_TIMEOUT_MS = 3600000;

class HubMirrorPool {

    constructor({ host, port, user, pass, name }){
        if(!/^[A-Za-z0-9_$]+$/.test(String(name)))
            throw new Error('hub-mirror schema name is not a safe identifier: ' + name);
        this.cfg = { host, port, user, pass, name };
        this.pool = getSqlTiming().wrapPool(mariadb.createPool({
            host, port, user,
            password:         pass,
            database:         name,
            // Small pool: one streaming writer plus occasional bootstrap pages.
            // Sized per dbType (DB_POOL_SIZE_HUB_MIRROR) so raising the indexer
            // or decoder pools does not drag this one along, and vice versa.
            connectionLimit:  poolSizing.resolvePoolSize('hub-mirror'),
            insertIdAsNumber: true,
            queryTimeout:     poolSizing.resolveQueryTimeout('hub-mirror'),
            // Session at +00:00 like the hub, so CURRENT_TIMESTAMP defaults land UTC-literal
            timezone:         'Z'
        }));
    }

    // Create the mirror schema itself when absent. ensureTables() creates tables
    // WITHIN the schema, but a fresh self-sync node has no schema yet and the
    // pool (bound to `database: name`) cannot connect to a nonexistent one, so
    // this runs first on a short-lived schema-less connection. Fails loud when
    // the DB user lacks CREATE privilege; the operator either grants it or
    // provisions the empty schema manually.
    async ensureDatabase(){
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: this.cfg.host, port: this.cfg.port,
                user: this.cfg.user, password: this.cfg.pass
            });
            await conn.query('CREATE DATABASE IF NOT EXISTS `' + this.cfg.name + '`');
        } finally {
            if(conn) try { await conn.end(); } catch(_){}
        }
    }

    // opts.ddl runs the statement under DDL_TIMEOUT_MS instead of the pool's read limit:
    // a schema reconcile ALTER on a million-row mirror outlives 30 s on a loaded server,
    // and a refused one leaves that coin's mirror unstarted until the next boot.
    async doQuery(sql, args, opts){
        let conn = await this.pool.getConnection();
        try {
            return await conn.query((opts && opts.ddl) ? { sql, timeout: DDL_TIMEOUT_MS } : sql, args);
        } finally {
            conn.release();
        }
    }

    async end(){
        await this.pool.end();
    }
}

module.exports = HubMirrorPool;
