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
 * XChain Explorer - the contract list and one contract's detail
 *
 * One part of src/db/readers/contracts.js (the entry composes it through
 * composeReaderParts). The paged deployed-contract list, one contract with
 * everything its page quotes, the manifest read, and the two helpers that
 * turn a stored description into the metadata snippet a row shows.
 *
 * This is the only part that reads contract CODE, so the introspection
 * cache and the sha256 that keys it live here rather than in the entry.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const { extractMethods } = require('../../../contract/introspect.js');

// The columns and joins one contract's detail page reads. Hoisted out of the
// reader so the read is legible as a shape rather than as mostly SQL; the caller
// appends its own WHERE and ORDER, which is the only part that varies per request.
const CONTRACT_DETAIL_SELECT = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        cp.permissions,
                        cp.max_take_bps
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN contract_permissions cp ON (cp.contract_index=m.action_index)
                    WHERE `;

// The manifest columns a contracts row carries as raw JSON, turned into the nested
// objects every contract-bearing response serves. A module function rather than a
// method: Database.prototype carries the family's public readers and nothing else,
// so a cut made for length adds no name to it. Same for the two below.
function attachContractPermissions(db, row){
    // Permissions manifest (protocol/controller-bound-tokens.md): the
    // declared emission allowlist + per-contract fee cap. permissions is
    // stored as a JSON array (NULL = unrestricted / no manifest); parse
    // it, falling back to null on absence or malformed JSON. max_take_bps
    // is NULL when the global cap applies.
    let permissions = null;
    if(!db.util.isNull(row.permissions)){
        try { permissions = JSON.parse(row.permissions); }
        catch(e){ permissions = null; }
    }
    row.permissions  = permissions;
    row.max_take_bps = db.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
    // Contract identity manifest (spec contract-meta-manifest 2.1): the three
    // extracted columns ride flat beside permissions, and the whole declared
    // object rides nested as `meta`, the way `abi` already does. meta_json
    // holds the isolate's own JSON.stringify bytes; parse it here so no
    // consumer has to (and so a malformed one is null rather than a string).
    db.attachContractMeta(row);
    // action_index stays the driver's BIGINT so utility.jsonStringify emits the
    // exact decimal string openapi's info.description promises; a Number() here
    // collapsed values above 2^53 and made it the one index in this row typed
    // unlike its own block_index (contract standardized in 38cc1d9).
    // The constructor lookup below binds it as a BigInt, never a quoted string,
    // which MariaDB would compare against a BIGINT column as a DOUBLE.
    if(db.util.isNull(row.action_index)) row.action_index = null;
}

// The code-derived fields: the integrity check against the stored hash, and the
// callable method surface the page lists, both keyed by the digest computed here.
function attachContractCodeSurface(db, row){
    // Source integrity: the chain carries the source itself, so
    // "verified contract" reduces to hashing what we serve. A mismatch
    // can only mean a corrupted indexer row; surface it, never hide it.
    let computedHash = db.util.isNull(row.code) ? null
        : crypto.createHash('sha256').update(row.code).digest('hex');
    row.code_hash_ok = computedHash !== null && computedHash === row.code_hash;

    // Callable method surface + optional self-declared abi metadata
    // via AST extraction (presentation-only; methods null = shape
    // unrecognized and the UI shows "unknown"; abi null = none
    // declared or malformed, UI falls back to name-only forms).
    // Cache key is the digest WE computed, never the stored code_hash:
    // introspection is a pure function of the code, and a row whose
    // stored hash mismatches its code must not poison (or read) the
    // entry of the code that hash really belongs to.
    let introspected = computedHash === null ? { methods: null, abi: null }
        : db.cacheGet(db._methodsCache, computedHash);
    if(introspected === undefined){
        try {
            let ex = extractMethods(row.code);
            introspected = { methods: ex.methods, abi: ex.abi };
        } catch(e){
            introspected = { methods: null, abi: null };
        }
        db.cacheSet(db._methodsCache, computedHash, introspected);
    }
    row.methods = introspected.methods;
    row.abi     = introspected.abi;
}

// The two deployment-dependent switches the contract page reads off this instance
// rather than off the chain: whether it may offer a read call, and where a write
// hands off to.
function attachContractPageFeatures(db, row){
    // Feature discovery for the contract page's Read Contract card:
    // mirrors the env gate on POST /{COIN}/api/contract/{idx}/call.
    row.vm_query_enabled = db.configInfo.env.EXPLORER_VM_QUERY_ENABLED === 'true';

    // Wallet handoff target for the Write Contract card. An explicitly
    // EMPTY EXPLORER_WALLET_URL disables the card, so only default over
    // an unset variable, never over ''.
    row.wallet_url = db.configInfo.env.EXPLORER_WALLET_URL !== undefined
        ? db.configInfo.env.EXPLORER_WALLET_URL : 'https://wallet.xchain.io';
}

class ContractDetailReaders {
    // Deployed contracts. Every contract query is an explicit column list, so the
    // four meta_* columns (spec contract-meta-manifest 2.5) are named here as well
    // as on getContract; meta_json is parsed into the nested `meta` object by
    // getData's post-pass, the same shape the single-contract route serves.
    //
    // The `name` lane binds the FULLTEXT term the WHERE clause built (see
    // getQueryWhereSql), which is the one filter on this method whose bind value is
    // not the raw path segment: BOOLEAN MODE reads +, -, *, ", ( ), ~, < > and @ as
    // operators, so an unsanitized term is a query-syntax injection into the search
    // itself. A term left with nothing to match after sanitizing returns the empty
    // page rather than a MATCH that would match everything.
    async getContracts(config){
        let sql   = config.data.sql;
        let args  = null;
        if(config.data.type=='name'){
            let term = this.fulltextTerm(config.data.search);
            if(term === '') return [[], null, 0];
            args = [term];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get single CONTRACT by action_index. Data method (returns [data]): the
    // /api/contract/{idx} route serves a single record, not a datatable (the
    // explorer contract listing uses getContracts). The LEFT JOIN surfaces the
    // contract's permissions manifest (contract_permissions; null when none).
    async getContract(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = CONTRACT_DETAIL_SELECT + sql.where.data + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            attachContractPermissions(this, row);
            attachContractCodeSurface(this, row);

            // Deploy-time constructor arguments: the indexer records the
            // constructor run in contract_executions under the literal method
            // name 'constructor', keyed by the DEPLOY's own action_index.
            try {
                let ctor = await this.doQuery(config,
                    `SELECT input_params FROM contract_executions WHERE action_index=? AND method_name='constructor' LIMIT 1`,
                    [row.action_index]);
                row.constructor_params = (ctor && ctor.length && !this.util.isNull(ctor[0].input_params)) ? String(ctor[0].input_params) : null;
            } catch(e){
                row.constructor_params = null;
            }

            attachContractPageFeatures(this, row);
            data = row;
        }
        return [data];
    }

    // Turn a contracts row's stored meta_json into the nested `meta` object every
    // contract-bearing response carries, and drop the raw column: a consumer that
    // had to JSON.parse a string field would eventually forget to, and the two
    // forms of the same value on one row is the drift that produces. A row whose
    // meta_json is absent, unparseable, or not a plain object gets meta null; the
    // three flat columns are served exactly as stored (the author's own bytes,
    // hardened at render, never here).
    attachContractMeta(row){
        if(!row || typeof row !== 'object') return row;
        let meta = null;
        if(!this.util.isNull(row.meta_json)){
            try {
                let parsed = JSON.parse(row.meta_json);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
                    meta = parsed;
            } catch(e){ meta = null; }
        }
        row.meta = meta;
        delete row.meta_json;
        return row;
    }

    // One search row's share of a contract description: enough to tell two hits
    // apart, short enough that a 512-byte description cannot take over the results
    // list. Truncated on characters, not bytes, because the consumer is a table
    // cell. The bytes are otherwise the author's own and are hardened at render,
    // never here.
    metaSnippet(description){
        const SNIPPET_MAX = 160;
        if(this.util.isNull(description)) return null;
        let s = String(description);
        return (s.length > SNIPPET_MAX) ? s.slice(0, SNIPPET_MAX - 1) + '…' : s;
    }

    // Get a contract's permissions manifest (protocol/controller-bound-tokens.md):
    // the declared emission allowlist + per-contract fee cap, or null when the
    // contract declared no manifest. permissions is a JSON array on the wire
    // (NULL = unrestricted); parse it, falling back to null on malformed JSON.
    async getContractManifest(config, contractIndex){
        if(this.util.isNull(contractIndex)) return null;
        let query = `SELECT permissions, max_take_bps
                     FROM contract_permissions
                     WHERE contract_index=?
                     LIMIT 1`;
        let rows = await this.doQuery(config, query, [contractIndex]);
        if(!rows || !rows.length) return null;
        let row = rows[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); }
            catch(e){ permissions = null; }
        }
        return {
            permissions:  permissions,
            max_take_bps: this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps)
        };
    }
}

module.exports = ContractDetailReaders.prototype;
