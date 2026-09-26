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
 * XChain Explorer - the action and transaction reads
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). One action by index, the paged action and history
 * feeds, and the three reads that answer for a transaction: the composed
 * detail, the public key recovered from it and its raw row.
 *
 * Transactions travel with actions because an action IS the payload of a
 * transaction here: the tx reads exist to answer "what did this hash do",
 * and they resolve it through the same action rows the feeds above serve.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const { DbInputError } = require('../../shared.js');

class EntityActionReaders {
    /******************************************************************
     *
     * API Endpoints
     * 
     *****************************************************************/



    /******************************************************************
     * XChain API Misc Endpoints
     * 
     * Endpoints                              Method Name      Query Types
     * -----------------------------------------------------------------
     * /{COIN}/api/action/{QUERY}             getAction       action_index
     * /{COIN}/api/address/{QUERY}            getAddress      address
     * /{COIN}/api/balances/{QUERY}/{TYPE}    getBalances     address
     * /{COIN}/api/block/{QUERY}              getBlock        block
     * /{COIN}/api/credits/{QUERY}/{TYPE}     getCredits      block, address
     * /{COIN}/api/debits/{QUERY}/{TYPE}      getDebits       block, address
     * /{COIN}/api/escrows/{QUERY}/{TYPE}     getEscrows      block, address
     * /{COIN}/api/history/{QUERY}/{TYPE}     getHistory      block, address, token
     * /{COIN}/api/holders/{QUERY}            getHolders      token
     * /{COIN}/api/mempool/{QUERY}/{TYPE}     getMempool      address, token,
     * /{COIN}/api/network                    getNetwork
     * /{COIN}/api/status                     getStatus
     * /{COIN}/api/token/{QUERY}              getToken        token
     * /{COIN}/api/transaction/{QUERY}/{TYPE} getTransaction  tx_hash, tx_index
     *
     * -----------------------------------------------------------------
     * /api/mempool TYPE=address: accepted matching limitations
     * -----------------------------------------------------------------
     * The address filter is a LAYOUT-FREE segment scan over the decoded
     * action string (mempoolRowMatchesAddress), not a per-action-format
     * parser: only SEND has a documented output layout, and a mempool row is
     * pre-validation, so there is no format-aware parse to trust here. Two
     * consequences ship as accepted limitations rather than bugs:
     *
     *   - False positives. Any exact pipe-segment equal to the queried
     *     address matches, including a segment that is not a destination at
     *     all (a memo whose text happens to be that address).
     *   - Best-effort non-SEND semantics. For every action family other than
     *     SEND, a match means "this address appears in this action", not
     *     "this action pays this address".
     *
     * Compacted destinations ARE matched: the SDK writes destinations as
     * `^<id>` index references by default, so the queried address is
     * forward-resolved to its index id once per request (cached getAddressId)
     * and `^<id>` segments count as hits alongside the literal address.
     ******************************************************************/

    async getAction(config){
        // getActionData has no not-found return of its own: when getActionType
        // finds no `actions` row, getActionData still falls through to a
        // truthy all-null baseline object ({credits, debits, escrows, fee:
        // null}), so wrapping that as [data] answered 200 with a body of
        // nulls instead of the 404 getBlock and getCheckpoint give a missing
        // index (their not-found is [null]). A bug report misread that
        // 200-with-nulls, hit under rapid reads, as a rate limit; it was this
        // branch. Resolve the type here first and match that convention.
        //
        // This runs getActionType twice on a hit, since getActionData
        // resolves it again from its own preload logic below - accepted,
        // because the expensive path is unaffected and a not-found now takes
        // the cheap one instead of the whole getActionData detail fan-out.
        let type = await this.getActionType(config, config.data.search);
        if(this.util.isNull(type))
            return [null];
        let data = await this.getActionData(config, config.data.search);
        return [data];
    }

    // The RAW action feed: one row per row of `actions`, which is the only surface
    // that claims to enumerate the chain action by action. That claim is why the
    // join shape here is load-bearing.
    //
    // `blocks` hangs off the ACTION's own m.block_index and `transactions` is a
    // LEFT join, the same tx-less-safe shape getHistory, getAttestations and
    // getActionsSince already use. A SYSTEM-INJECTED action (the Tier-4 families:
    // *_EXPIRE, *_MATCH, DISPENSE, DISPENSER_CLOSE, CROSS_SETTLE, and a
    // mirror-applied ATTEST v1 response) carries a real action_index and a real
    // block_index but a NULL tx_index and NO transactions row at all, so reaching
    // blocks through an INNER-joined transactions did not degrade such a row, it
    // DELETED it from the feed.
    //
    // That deletion is INVISIBLE to a caller: the JSON stays well-formed, the
    // paging stays consistent, `total` agrees with the rows returned, and the rows
    // are simply not there - so every consumer enumerating the chain through this
    // feed under-counted with no way to tell (measured on regtest: 483 rows served
    // against a highest action_index of 496). tx_hash and tx_index come back NULL
    // for those rows, which is what they are.
    //
    // tx_index is selected from m (the action's own column) rather than from t1, so
    // it survives a missing transactions row on its own terms instead of depending
    // on a join that may not resolve.
    async getActions(config){
        let sql   = config.data.sql;
        let q     = (config.data.query) ? config.data.query : {};
        let args  = [];
        let extra = '';
        if (!this.util.isNull(q.blockIndex)) {
            // Bind one exact non-negative block height, never a coerced prefix.
            if(!this.util.isSafeIntegerParam(q.blockIndex))
                throw new DbInputError('Invalid block_index', 'INVALID_BLOCK_INDEX');
            extra += ' AND b1.block_index=?';
            args.push(Number(q.blockIndex));
        }
        if (!this.util.isNull(q.txid)) {
            extra += ' AND t2.hash=?';
            args.push(q.txid);
        }
        if (!this.util.isNull(q.tick)) {
            extra += ` AND m.action_index IN (
                            SELECT ma.action_index FROM mappings_actions ma
                            INNER JOIN index_tickers it ON it.id=ma.id
                            WHERE ma.type_id=1 AND it.tick=?)`;
            args.push(q.tick);
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        actions m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=m.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + extra;
        let query = `SELECT
                        m.action_index,
                        a1.action,
                        m.action_format,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        m.tx_index
                    FROM
                        actions m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=m.tx_index)
                        LEFT  JOIN index_actions      a1 ON (a1.id=m.action_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(m.source_id, t1.source_id))
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + extra + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get history information for a given address
    async getHistory(config){
        let [data, count] = await this.getHistoryData(config);
        return [data, null, count];
    }

    async getTransaction(config){
        let data = {
            actions: []
        };
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let where = '';
        if(config.data.type=='tx_hash')
            where = ' AND t1.hash=?';
        if(config.data.type=='tx_index')
            where = ' AND m.tx_index=?';
        let query = `SELECT
                        m.tx_index,
                        t1.hash as tx_hash,
                        b1.block_index,
                        b1.block_time as timestamp,
                        a1.address as source
                    FROM
                        transactions m
                        LEFT  JOIN index_transactions t1 ON (t1.id=m.tx_hash_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=m.source_id)
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE 
                        ` + sql.where.data + where + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = Object.assign({}, data, results[0]);
        if(data.tx_index){
            args = [data.tx_index];
            query = `SELECT
                            m.action_index,
                            a1.action
                        FROM
                            actions m
                            LEFT  JOIN index_actions a1 ON (a1.id=m.action_id)
                        WHERE 
                            m.tx_index=?
                        ORDER BY m.action_index DESC `;
            results = await this.doQuery(config, query, args);
            if(results && results.length){
                for(let row of results){
                    data.actions.push(row);
                }
            }
        }
        // Try to lookup raw transaction data
        let txData = await this.getTransactionData(config, data.tx_hash);
        data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
        // Get summary data for actions
        data.actions = await this.getActionSummaryData(config, data.actions);
        return [data]
    }

    async getPublicKey(config){
        let data = null;
        let query = `SELECT
                        p.pubkey
                    FROM
                        pubkeys p
                        INNER JOIN index_addresses a ON (a.id=p.address_id)
                    WHERE
                        a.address=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [config.data.search]);
        if(results && results.length)
            data = results[0];
        return [data];
    }

    async getTransactionData(config, hash){
        let data = null;
        let query = `SELECT
                        t1.tx_index,
                        t1.block_index,
                        t2.hash,
                        t1.fee,
                        t1.data
                    FROM
                        transactions t1
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        t2.hash=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [hash]);
        if(results && results.length)
            data = results[0];
        return data;
    }
}

module.exports = EntityActionReaders.prototype;
