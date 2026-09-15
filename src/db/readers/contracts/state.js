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
 * XChain Explorer - the contract state reads
 *
 * One part of src/db/readers/contracts.js (the entry composes it through
 * composeReaderParts). A contract's stored state: the paged key feed, the
 * whole-state read behind its size caps, and the balance read.
 *
 * They are one part because they share the caps: a state large enough to
 * refuse must be refused by the same rule whichever of these asks for it.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

class ContractStateReaders {
    async getContractState(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        cs.id,
                        cs.contract_index,
                        cs.state_key,
                        cs.state_value,
                        cs.block_index
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY cs.state_key ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Load a contract's FULL current state in the shape the VM consumes,
    // mirroring the indexer's own loader (xchain-indexer/src/db/contracts.js
    // getContractState): latest non-null row per key, values JSON-parsed with
    // raw-string fallback. Null-prototype object so adversarial keys like
    // '__proto__' round-trip instead of hitting the setter. Used only by the
    // read-only simulation endpoint (src/contract/vm_query.js), not the datatable route.
    //
    // The endpoint is public and the VM's maxStateKeys only bounds NEW writes,
    // not the initial load, so the caller passes hard row/byte caps and a
    // cheap aggregate pre-check refuses oversized state BEFORE the multi-MB
    // row fetch. Throws code 'STATE_TOO_LARGE' past either cap.
    async getContractFullState(config, contractIndex, limits){
        let maxRows  = limits && limits.maxRows  > 0 ? Math.floor(limits.maxRows)  : 10000;
        let maxBytes = limits && limits.maxBytes > 0 ? Math.floor(limits.maxBytes) : 4 * 1024 * 1024;
        let gateQuery = `SELECT COUNT(*) as total_rows, COALESCE(SUM(LENGTH(cs.state_value)), 0) as total_bytes
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL`;
        let gate = await this.doQuery(config, gateQuery, [contractIndex]);
        let totalRows  = gate && gate.length ? Number(gate[0].total_rows)  : 0;
        let totalBytes = gate && gate.length ? Number(gate[0].total_bytes) : 0;
        if(totalRows > maxRows || totalBytes > maxBytes){
            let err  = new Error('contract state too large to load for simulation (' + totalRows + ' keys, ' + totalBytes + ' bytes)');
            err.code = 'STATE_TOO_LARGE';
            throw err;
        }
        // LIMIT is belt-and-braces for rows written between the two queries.
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL
                     LIMIT ` + maxRows;
        let results = await this.doQuery(config, query, [contractIndex]);
        let state = Object.create(null);
        let loadedBytes = 0;
        for(let row of (results || [])){
            // Re-verify the byte budget against the rows actually fetched: the
            // aggregate gate above and this SELECT are two separate queries, so
            // state written between them can push the real payload past the cap
            // the gate approved (TOCTOU). LIMIT bounds row count; this bounds bytes.
            loadedBytes += row.state_value == null ? 0 : Buffer.byteLength(String(row.state_value));
            if(loadedBytes > maxBytes){
                let err  = new Error('contract state exceeded simulation byte budget while loading (>' + maxBytes + ' bytes)');
                err.code = 'STATE_TOO_LARGE';
                throw err;
            }
            try { state[row.state_key] = JSON.parse(row.state_value); }
            catch(e){ state[row.state_key] = row.state_value; }
        }
        return state;
    }

    // Get contract custody balances; custody lives in the standard `balances`
    // table under the contract's derived address C:<CHAIN>:<action_index>.
    async getContractBalance(config){
        let sql     = config.data.sql;
        let chain   = this.baseCoin ? this.baseCoin[config.coin] : null;
        let address = 'C:' + chain + ':' + config.data.search;
        let args    = [address];
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        t3.tick,
                        m.amount
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY t3.tick ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }
}

module.exports = ContractStateReaders.prototype;
