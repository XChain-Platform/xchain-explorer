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

class HubMirrorPool {

    constructor({ host, port, user, pass, name }){
        if(!/^[A-Za-z0-9_$]+$/.test(String(name)))
            throw new Error('hub-mirror schema name is not a safe identifier: ' + name);
        this.cfg = { host, port, user, pass, name };
        this.pool = mariadb.createPool({
            host, port, user,
            password:         pass,
            database:         name,
            // Small pool: one streaming writer plus occasional bootstrap pages.
            connectionLimit:  3,
            insertIdAsNumber: true,
            queryTimeout:     parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        });
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

    async doQuery(sql, args){
        let conn = await this.pool.getConnection();
        try {
            return await conn.query(sql, args);
        } finally {
            conn.release();
        }
    }

    async end(){
        await this.pool.end();
    }
}

module.exports = HubMirrorPool;
