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
 * XChain Explorer - the FILE byte readers and the WebSocket entity snapshots
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). The two reads that serve a FILE action as bytes,
 * and the single-row snapshots the WebSocket layer reads on subscribe and
 * on lifecycle enrichment: a balance set, a token, a market, a dispenser,
 * a coinpay obligation, an order-match settlement and the two dispenser
 * index resolutions.
 *
 * These are one part because they share a shape no other reader has: each
 * answers for exactly one row by a key the caller already holds, with no
 * paging, no filter and no count query.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

class EntityLookupReaders {
    // Get the raw AES-256-GCM ciphertext bytes for a gated FILE by action_index.
    // Returns the result rows (0 or 1) so the caller can distinguish "no such gated
    // file" (empty) from a stored ciphertext. Keeps the gated_files table/column
    // names in the model layer alongside the gated_files joins used elsewhere here.
    async getGatedFileRaw(config, actionIndex) {
        let query = `SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1`;
        return await this.doQuery(config, query, [Number(actionIndex)]);
    }

    // Raw bytes + declared MIME type for a non-gated FILE action. The indexer DB
    // stores only FILE metadata (files table); the bytes live in the colocated
    // decoder DB's transactions.raw_data, read with the same DB-qualified pattern
    // and identifier guard as getDecoderTip. The decoder row is matched by tx HASH
    // (each DB numbers tx_index/tx_hash_id independently, so ids can't be joined
    // across them). Returns null when the FILE is unknown, has no stored bytes,
    // or the decoder DB isn't reachable from this server.
    async getFileRaw(config, actionIndex) {
        // Resolve the FILE's tx hash + declared MIME type from the indexer DB
        let meta = `SELECT
                        t2.hash,
                        t3.type
                    FROM
                        files f1
                        INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    WHERE
                        f1.action_index=?
                    LIMIT 1`;
        let rows = await this.doQuery(config, meta, [Number(actionIndex)]);
        if(!rows || !rows.length || this.util.isNull(rows[0].hash))
            return null;
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        // dbName is config-derived, not client input, but database identifiers
        // can't be bound; restrict to a safe identifier charset before use
        // (same rule as getDecoderTip).
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        try {
            // `data` (the FULL stored ACTION string) rides along so the serve
            // path can derive the trailing COMPRESSION field at serve time
            // (protocol spec §5.1). It must NEVER come from a parsed-at-ingest
            // column: shipped indexers drop unknown trailing fields at parse, so
            // a compressed FILE mined before an indexer upgrade would be stored
            // marker-less and served as deflated garbage forever. The decoder's
            // `data` column preserves the action string verbatim, so deriving
            // here is always correct, including for history.
            let query = 'SELECT t1.raw_data, t1.data FROM `' + dbName + '`.transactions t1 ' +
                        'INNER JOIN `' + dbName + '`.index_transactions t2 ON (t2.id=t1.tx_hash_id) ' +
                        'WHERE t2.hash=? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [rows[0].hash]);
            if(results && results.length && !this.util.isNull(results[0].raw_data))
                return { raw_data: results[0].raw_data, type: rows[0].type, data: results[0].data };
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant: omit the bytes.
            log.warn('FILE_RAW_UNAVAILABLE', { method: 'getFileRaw', coin: config.coin, actionIndex, err: e && e.message ? e.message : e });
        }
        return null;
    }

    /******************************************************************
     * WebSocket Snapshot & Entity Detail Queries
     *
     * Used for snapshot-on-subscribe and lifecycle event enrichment.
     *****************************************************************/

    async getAddressBalances(config, address) {
        let query = `SELECT
                        t1.tick,
                        m.amount
                    FROM
                        balances m
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=m.address_id)
                    WHERE
                        a1.address=?
                    ORDER BY t1.tick ASC`;
        let results = await this.doQuery(config, query, [address]);
        return results || [];
    }

    async getTokenInfo(config, tick) {
        let query = `SELECT
                        t2.tick,
                        t1.supply,
                        t1.decimals,
                        t1.description,
                        (SELECT COUNT(*) FROM balances b
                            INNER JOIN index_tickers t3 ON (t3.id=b.tick_id)
                            WHERE t3.tick=? AND b.amount > 0) as holders
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE
                        t2.tick=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [tick, tick]);
        if (results && results.length) return results[0];
        return null;
    }

    // Market snapshot for the WebSocket market channel. Two things this query could not
    // do before: last_price / volume_24h / bid / ask are not columns of `markets` (the
    // stats are stored per side as tick1_*/tick2_*), so it raised 'Unknown column' and
    // the channel pushed an empty snapshot on every subscribe; and it matched only the
    // orientation the pair happened to be stored in, which is whichever side traded
    // first. The CASE resolves the caller's tick1 to the side it actually is, so the
    // response keys stay what the channel has always advertised.
    //
    // LEFT JOIN + COALESCE for the same reason as the market readers: the native side
    // of a token/native pair has no index_tickers row (see src/db/readers/markets.js).
    async getMarketInfo(config, tick1, tick2) {
        let side1 = 'COALESCE(t1.tick, c1.coin)';
        let side2 = 'COALESCE(t2.tick, c2.coin)';
        let query = `SELECT
                        ? as tick1,
                        ? as tick2,
                        CASE WHEN ` + side1 + `=? THEN m.tick1_price        ELSE m.tick2_price        END as last_price,
                        CASE WHEN ` + side1 + `=? THEN m.tick1_24hr_volume  ELSE m.tick2_24hr_volume  END as volume_24h,
                        CASE WHEN ` + side1 + `=? THEN m.tick1_bid          ELSE m.tick2_bid          END as bid,
                        CASE WHEN ` + side1 + `=? THEN m.tick1_ask          ELSE m.tick2_ask          END as ask
                    FROM
                        markets m
                        LEFT JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        LEFT JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                        LEFT JOIN index_coins   c1 ON (c1.id=m.coin1_id)
                        LEFT JOIN index_coins   c2 ON (c2.id=m.coin2_id)
                    WHERE
                        (` + side1 + `=? AND ` + side2 + `=?) OR
                        (` + side1 + `=? AND ` + side2 + `=?)
                    LIMIT 1`;
        let args = [tick1, tick2, tick1, tick1, tick1, tick1, tick1, tick2, tick2, tick1];
        let results = await this.doQuery(config, query, args);
        if (results && results.length) return results[0];
        return null;
    }

    // Dispenser snapshot for the WebSocket dispenser channel. give_remaining is
    // DERIVED: the dispensers table has no such column, so selecting it throws
    // 'Unknown column' on every subscribe/update and the channel silently pushes
    // nothing.
    async getDispenserInfo(config, actionIndex) {
        let query = `SELECT
                        d.action_index,
                        a2.address as source,
                        t1.tick as give_tick,
                        d.give_amount,
                        d.give_escrow,
                        t2.tick as get_tick,
                        d.get_amount,
                        d.expiration,
                        s1.status
                    FROM
                        dispensers d
                        INNER JOIN actions            a1 ON (a1.action_index=d.action_index)
                        INNER JOIN transactions        t3 ON (t3.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                        LEFT  JOIN index_tickers      t1 ON (t1.id=d.give_tick_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=d.get_tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=d.status_id)
                    WHERE
                        d.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length){
            let info   = results[0];
            let escrow = await this.getDispenserEscrowBatch(config, [actionIndex]);
            let entry  = escrow[String(actionIndex)];
            info.escrow_remaining = (entry) ? entry.escrow_remaining : null;
            info.give_remaining   = info.escrow_remaining;
            return info;
        }
        return null;
    }

    async getCoinpayObligation(config, orderMatchActionIndex) {
        // NOTE: obligation_action_index and order_match_action_index are the SAME
        // column (co.action_index = the ORDER_MATCH action_index that created this
        // obligation). There is no separate obligation identifier; obligation_action_index
        // is a wire-contract alias of the ORDER_MATCH index, kept for compatibility.
        let query = `SELECT
                        co.action_index as obligation_action_index,
                        co.action_index as order_match_action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        co.coin_amount,
                        co.expiration
                    FROM
                        coinpay_obligations co
                        LEFT JOIN index_addresses a1 ON (a1.id=co.payer_address_id)
                        LEFT JOIN index_addresses a2 ON (a2.id=co.payee_address_id)
                    WHERE
                        co.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [orderMatchActionIndex]);
        if (results && results.length) return results[0];
        return null;
    }

    async getOrderMatchSettlement(config, actionIndex) {
        let query = `SELECT
                        om.action_index,
                        s1.status as settlement_type
                    FROM
                        order_matches om
                        LEFT JOIN index_statuses s1 ON (s1.id=om.settlement_type_id)
                    WHERE
                        om.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length) return results[0];
        return null;
    }

    // Parent-dispenser lookup for DISPENSE lifecycle enrichment. The event's own
    // action_index is the dispense; SDK consumers correlate a dispense to its
    // dispenser via data.dispenser_action_index (xchain-sdk XChainSDK DISPENSE
    // handler), so the ChangeDetector attaches this value to the event.
    async getDispenseDispenserIndex(config, actionIndex) {
        let query = `SELECT
                        dispenser_action_index
                    FROM
                        dispenses
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length && results[0].dispenser_action_index != null)
            return results[0].dispenser_action_index;
        return null;
    }

    // Resolve the parent dispenser's opening action_index for a DISPENSER_CLOSE
    // or DISPENSER_EXPIRE lifecycle action, so those events can be routed to the
    // per-dispenser websocket channel (coin:dispenser:<dispenser_action_index>)
    // the SDK's onDispenser() subscribes to. `table` is dispenser_closes or
    // dispenser_expires, both of which map action_index -> dispenser_action_index.
    async getDispenserLifecycleDispenserIndex(config, table, actionIndex) {
        const allowed = { dispenser_closes: true, dispenser_expires: true };
        if (!allowed[table]) return null;
        let query = `SELECT
                        dispenser_action_index
                    FROM
                        ${table}
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length && results[0].dispenser_action_index != null)
            return results[0].dispenser_action_index;
        return null;
    }
}

module.exports = EntityLookupReaders.prototype;
