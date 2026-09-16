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
 * XChain Explorer - the address reads and the per-address feeds
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). One address with the tracker info the UTXO tracker
 * adds to it, and the five paged feeds a balance sheet is made of:
 * balances, credits, debits, escrows and the per-token holder list.
 *
 * The holder list sits here rather than with the token reads because it is
 * keyed and paged by address the way the other four are; the token page
 * reads it, but every column it selects is an address column.
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

class EntityAddressReaders {
    // TODO: pull balance data from the utxo-tracker API instead of placeholder values
    async getAddress(config){
        const address = config.data.search;
        // Native-coin balance / UTXO figures come from this coin's xchain-utxo-tracker (the
        // explorer is DB-only and never talks to a node). When no tracker is configured for the
        // coin or it is unreachable, the fields stay null and the page shows "Unavailable" rather
        // than the old hardcoded placeholder values. See getAddressTrackerInfo().
        let data = {
            address: address,
            type: null,
            balances: { confirmed: null, pending: null, received: null },
            utxos: { confirmed: null, pending: null },
            estimated_value: { btc: null, usd: null },
            tracker_available: false
        };
        let info = await this.getAddressTrackerInfo(config, address);
        if(info && info.balances && info.utxos){
            data.type     = info.type || null;
            data.balances = {
                confirmed: info.balances.confirmed,
                pending:   info.balances.pending,
                received:  info.balances.received
            };
            data.utxos = {
                confirmed: info.utxos.confirmed,
                pending:   info.utxos.pending
            };
            data.tracker_available = true;
            if(info.mempool_ready !== undefined) data.mempool_ready = info.mempool_ready;
            // Estimated fiat value of the confirmed balance: confirmed amount * live USD price
            // (null on testnet/regtest or when the hub oracle has no price for this coin).
            let price = await this.getCoinPriceUsd(config);
            data.estimated_value = {
                btc: data.balances.confirmed,
                usd: (price != null && data.balances.confirmed != null)
                    ? this.util.bcmul(String(data.balances.confirmed), String(price), 2)
                    : null
            };
        }
        // Controller bindings still gating this address's native actions
        // (protocol/controller-bound-tokens.md). [] when nothing gates.
        data.controllers = await this.getAddressControllerBindings(config, config.data.search);
        // Surface the immutable index_addresses id (mirrors how getToken surfaces
        // tick_id in info). The SDK address compactor reads info.address_id to rewrite
        // an address to its smaller ^<id> wire form (see xchain-sdk addressResolver.js).
        // F3 (id-determinism): expose it ONLY when the id is in the DETERMINISTIC set
        // (block_index IS NOT NULL). An out-of-band id (recovery pre-seed, pre-F1a) is not
        // reproducible across nodes, so the SDK must never compact an address to it; the
        // indexer's resolveAddressRef rejects such a ^id anyway, this stops the leak at the
        // source. getCompactableAddressId, NOT getAddressId (the internal string<->id
        // resolver), so display/lookup paths are unaffected. null => SDK emits the full address.
        let addressId = await this.getCompactableAddressId(config, config.data.search);
        data.info = {
            address:    config.data.search,
            address_id: (addressId !== null && addressId !== undefined) ? Number(addressId) : null
        };
        return [data];
    }

    // Live native-coin balance / UTXO info for an address from this coin's xchain-utxo-tracker.
    // The explorer is DB-only and never talks to a node, so it asks the tracker's read API. The
    // base URL is per coin (each tracker instance is single-coin): UTXO_TRACKER_URL_<CODE> (e.g.
    // UTXO_TRACKER_URL_BTC, UTXO_TRACKER_URL_TBTC), falling back to a generic UTXO_TRACKER_URL.
    // The tracker's GET /info/<address> response already matches the address-page shape
    // (type + balances{confirmed,pending,received} + utxos{confirmed,pending}, full-precision
    // decimal strings). Returns null when no tracker is configured for this coin or it is
    // unreachable, so getAddress can fall back to an honest "Unavailable" instead of fake values.
    async getAddressTrackerInfo(config, address){
        const code = config.coin;
        const base = this.configInfo.env['UTXO_TRACKER_URL_' + code] || this.configInfo.env.UTXO_TRACKER_URL;
        if(!base || !address) return null;
        try {
            const url = base.replace(/\/+$/, '') + '/info/' + encodeURIComponent(address);
            const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            if(j && j.balances && j.utxos) return j;
            throw new Error('malformed /info response');
        } catch(e){
            log.warn('UTXO_TRACKER_UNAVAILABLE', { method: 'getAddressTrackerInfo', code, err: e && e.message ? e.message : e });
            return null;
        }
    }

    async getBalances(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        t1.tick,
                        m.amount,
                        t4.supply,
                        t4.decimals,
                        t4.coin_price
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY t1.tick ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCredits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        credits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        credits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDebits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        debits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        debits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getEscrows(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        escrows m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        escrows m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getHolders(config){
        let sql   = config.data.sql;
        // Guard: for a token-type query, verify the tick exists before joining
        // against the full balances table. Without this check, a nonexistent
        // tick produces a WHERE t3.tick=? that forces a full balances scan (the
        // LEFT JOIN does not short-circuit) which was reported as a DoS-shaped
        // hang; returning [] immediately avoids the scan.
        if(config.data.type === 'token'){
            let tickCheck = await this.doQuery(config,
                `SELECT id FROM index_tickers WHERE tick=? LIMIT 1`,
                [config.data.search]);
            if(!tickCheck || tickCheck.length === 0)
                return [[], null, 0];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.address,
                        m.amount,
                        t3.tick,
                        t4.supply,
                        t4.decimals,
                        t4.coin_price
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY ABS(m.amount) ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }
}

module.exports = EntityAddressReaders.prototype;
