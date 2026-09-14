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
 * XChain Explorer - entity readers
 *
 * Proposal B stage 4: the things a URL names. Actions, addresses, blocks,
 * balances, tokens, transactions and the /api endpoints that serve them, the
 * id-resolution lookups every other family calls (getAddressId, getTickId), the
 * single-entity snapshots the WebSocket layer fans out on subscribe, the two
 * FILE byte readers, and the per-token rich list with its supply helpers.
 *
 * These travel together because they share the id-resolution cache path: a page
 * for one entity resolves its key through the same memoised lookups the feeds
 * use, so splitting the resolvers away from their callers would leave one file
 * holding a cache and another holding every reason it is warm.
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const coinsRegistry = require('../../coins');
const DecoderConnector = require('../../connectors/decoder.js');
const { DbInputError, staleFailClosed } = require('../shared.js');

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../observability');
const log = getLogger();

// A block height is a non-negative integer and nothing else. parseInt/Number
// cannot make this call: parseInt('9junk') is 9 and Number('') is 0, both of
// which reproduce the coercion bug in JS instead of catching it. Same strict
// shape as the /api/action and /api/checkpoint route guards in XChainExplorer.js.
const BLOCK_INDEX_RE = /^[0-9]+$/;

class EntityReaders {
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
            extra += ' AND b1.block_index=?';
            args.push(this.util.sanitizeInt(q.blockIndex));
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

    async getBlock(config){
        let data = null;
        let sql   = config.data.sql;
        // The search segment is bound against the BIGINT blocks.block_index, and
        // MariaDB coerces a non-numeric string to 0 rather than rejecting it, so
        // an unguarded /api/block/zzz would answer 200 with BLOCK 0's real
        // record - a wrong answer dressed as a right one, which nothing
        // downstream can detect. Refuse the id before it reaches the query.
        if(!BLOCK_INDEX_RE.test(String(config.data.search ?? '')))
            throw new DbInputError('Invalid block_index', 'INVALID_BLOCK_INDEX');
        let args  = [config.data.search];
        let query = `SELECT
                        b1.block_index,
                        b1.block_time as timestamp,
                        t1.hash as ledger_hash,
                        t2.hash as actions_hash,
                        t3.hash as contract_hash,
                        t4.hash as state_hash
                    FROM
                        blocks b1
                        LEFT  JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=b1.actions_hash_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                        LEFT  JOIN index_transactions t4 ON (t4.id=b1.state_hash_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = results[0];
        return [data];
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

    // Get history information for a given address
    async getHistory(config){
        let [data, count] = await this.getHistoryData(config);
        return [data, null, count];
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

    //
    // /{COIN}/api/mempool[/{QUERY}/{TYPE}]: unconfirmed actions read from the
    // colocated decoder DB (see getDecoderMempoolRows). Rows are PRE-VALIDATION
    // (the indexer can still reject them at confirmation), carry a destination
    // column that is always NULL (see getDecoderMempoolRows: never read, never
    // filtered on), and the full decoded action string ships in `data`; clients
    // with format knowledge (e.g. the SDK's x402 verifier) parse fields out of it.
    // Filtering is a best-effort prefilter done in JS rather than in SQL (the
    // action string is one opaque pipe-joined column, so a LIKE would match
    // across field boundaries): TYPE=address matches the source OR any exact
    // pipe-segment of the action string (covers SEND destinations across
    // versions) OR the `^<id>` reference the SDK compacts that address to by
    // default (see mempoolRowMatchesAddress and the accepted-limitations note
    // in the endpoint header above); TYPE=token matches any exact segment
    // against the uppercased
    // tick. No TYPE (bare /api/mempool, or the /explorer/mempool list-all
    // fallback) lists every decoded row (spec explorer-coverage-completion
    // M1.2): the old code matched ONLY address/token and silently returned []
    // for the list-all case, which is the bug this row fixes.
    //
    // PAGING (deliberate §8 exception, spec-approved): this is a direct-return
    // method (getData's `typeof query === 'object'` branch), and the source is
    // the decoder's mempool table, not an indexer action table: there is no
    // action_index/id cursor column pre-confirmation for the standard SQL
    // OFFSET/cursor machinery (getQueryOffsets/getQueryOffsetSql) to key off,
    // and getDecoderMempoolRows already caps its read at one bounded window
    // (500 rows, clamped in getDecoderMempoolRows itself) rather than scanning
    // the whole table. Given that bounded window, paging is done here by a
    // plain JS-side slice honoring sql.limit (computed by getQuery: the
    // per-method max for /api, the DataTables page `length` for /explorer)
    // and whichever offset numbering the caller already uses: `sql.apiOffset`
    // for /api (page-based), or the raw DataTables `query.start` row offset
    // for /explorer. The action_index next/prev/first/last cursor dance the
    // other list feeds use does not apply here, since there is no cursor
    // column to carry it on, so /explorer/mempool pages by plain numeric
    // offset instead, which is safe specifically because the source window
    // is already capped.
    // `total` is the full filtered-match count (pre-slice), matching every
    // other list feed's envelope semantics for recordsTotal/json.total.
    async getMempool(config){
        let search = String(config.data.search || '');
        let type   = String(config.data.type || '').toLowerCase();
        let rows   = await this.getDecoderMempoolRows(config, 500);
        let out    = [];
        // Resolve the queried address to its index id ONCE per request, not once
        // per row: getExactAddressId is cached (per coin + reorg generation), but the
        // window is up to 500 rows and a cache miss is a real query. Null when the
        // address was never indexed, which is exactly when the SDK cannot compact
        // it either, so the literal branch below still matches it.
        // BYTE-EXACT resolution, not the ci getAddressId the search paths use: a
        // wrong-case address must not inherit another address's id and match its
        // `^<id>` destinations (see getExactAddressId).
        let addressId = null;
        if(type=='address' && search.length){
            // A failed id read degrades to literal-only matching rather than
            // failing the whole mempool request.
            try { addressId = await this.getExactAddressId(config, search); }
            catch(e){ addressId = null; }
        }
        for(let row of rows){
            let decoded = this.decodeMempoolRow(row);
            if(!decoded) continue;
            if(!type){
                out.push(decoded);
                continue;
            }
            let match = false;
            if(type=='address')
                match = this.mempoolRowMatchesAddress(decoded, search, addressId);
            if(type=='token')
                match = this.mempoolSegments(decoded).includes(search.toUpperCase());
            if(match) out.push(decoded);
        }
        let total = out.length;
        let sql   = config.data.sql || {};
        // Fall back to the full matched set when no request-shaped sql/limit is
        // present (e.g. an internal caller building a minimal config), so this
        // method never truncates output it wasn't asked to page.
        let limit = (this.util.isInteger(Number(sql.limit)) && Number(sql.limit) > 0)
            ? Number(sql.limit) : (total || 1);
        let offset = 0;
        if(config.type === 'api')
            offset = Number(sql.apiOffset) || 0;
        else if(config.type === 'explorer')
            offset = Number(config.data.query && config.data.query.start) || 0;
        return [out.slice(offset, offset + limit), null, total];
    }

    async getNetwork(config){
        // Resolve the coin this request is for. config.coin is the route code
        // (BTC / TBTC / RDOGE …); the per-coin chain identity (name + ticker)
        // lives in the loaded explorer config under the BASE coin key (BTC/LTC/DOGE).
        let code = config.coin;
        let coinName = String(code), coinTick = String(code);
        // Network of THIS request, derived from the route-code prefix (T=testnet,
        // R=regtest, none=mainnet). Used for the finality clamp below so an
        // override may only raise the depth on mainnet. Defaults to mainnet (the
        // safe, clamping choice) when config is momentarily unavailable.
        let reqNetwork = 'mainnet';
        try {
            let full  = await this.configInfo.getConfig();
            let bases = Object.keys(full['COIN_NETWORKS'] || {});            // ['BTC','LTC','DOGE']
            let base  = bases.find(c => String(code).endsWith(c)) || code;   // 'TBTC' -> 'BTC'
            let chain = (full[base] && full[base].chain) ? full[base].chain : {};
            if(chain.name) coinName = chain.name;
            if(chain.tick) coinTick = chain.tick;
            let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
            let upper = String(code).toUpperCase();
            for(const net in prefixes){
                const p = prefixes[net];
                if(p && upper.startsWith(p) && bases.includes(upper.slice(p.length))){ reqNetwork = net; break; }
            }
        } catch(e){ /* keep code-based fallbacks if config is momentarily unavailable */ }

        // Real indexer tip + last-block time for this coin (same source as /status).
        let block       = await this.getMaxBlockIndex(config);
        let blockTime   = await this.getMaxBlockTime(config);
        // Real unconfirmed (mempool) count from the decoder API/DB (XChain-carrying
        // txs), plus the coin node's TOTAL mempool size (any tx), which only the
        // decoder API can report (null when it isn't configured/reachable).
        let unconfirmed     = await this.getDecoderMempoolCount(config);
        let unconfirmedNode = await this.getNodeMempoolCount(config);
        // Live fee tiers from this coin's encoder (estimatesmartfee), cached.
        let fee = await this.getFeeEstimate(config);
        // Live USD price from the xchain-hub oracle (mainnet coins only; null for
        // testnet/regtest or when no oracle price is available (see getCoinPriceUsd()).
        let coinPriceUsd = await this.getCoinPriceUsd(config);

        let data = {
            // Per-action-type record counts (real; populated below).
            totals : {},
            // Network information: block/time are the real indexer tip for this coin.
            network: {
                block : block,
                time  : blockTime,
                // Real mempool size: count of unconfirmed XChain-carrying txs for
                // this coin (0 if neither the decoder API nor DB is reachable).
                unconfirmed: unconfirmed,
                // The coin node's TOTAL mempool tx count (XChain or not), from
                // the decoder API. null when no decoder API resolves for this
                // coin (a DB-only deployment cannot know it); clients hide it.
                unconfirmed_node: unconfirmedNode,
            },
            // Suggested fee tiers (sat/vByte) from this coin's encoder, which reads
            // the node's estimatesmartfee. Falls back to {1,2,3} when no encoder is
            // configured (ENCODER_URL) or it's unreachable. See getFeeEstimate().
            fee: fee,
            // Coin identity is REAL (from the per-coin chain config). usd price is
            // REAL for mainnet coins (from the xchain-hub oracle); testnet/regtest
            // keep the $0.00 placeholder (no market). price.btc stays the identity
            // 1.0 (coin priced in itself); a coin/BTC cross is future work.
            coin: {
                name: coinName,
                symbol: coinTick,
                price: {
                    btc: '1.00000000',
                    usd: coinPriceUsd != null ? coinPriceUsd : '0.00'
                }
            },
            // XChain token info: price is a PLACEHOLDER pending XCHAIN issuance + a
            // market (it must be DEX-derived, not an external feed).
            xchain: {
                name: 'XChain',
                symbol: 'XCHAIN',
                price: {
                    btc: '0.00000000',
                    usd: '0.00'
                }
            },
            // Same-chain finality guidance (display/UX only). The indexer processes
            // actions at the chain tip, so this is a recommended "treat a receipt as
            // final after N confirmations" value per chain, not a gate. Sourced from
            // the vendored coin registry (single source of truth) rather than a
            // hand-copied literal map, so a re-tune of a coin's `confirmations` in the
            // bundle can no longer leave the explorer showing a stale depth, and the
            // registry's mainnet floor clamp (overrides may only RAISE the depth on
            // mainnet) is honored instead of silently dropped. Still honors the same
            // XCHAIN_CONFIRMATIONS_<COIN> env overrides (#3212).
            finality: coinsRegistry.resolveConfirmations(config, reqNetwork)
        };
        // Per-action-type record counts for the homepage counters. Exact COUNT(*) per table
        // (cached per coin, see getActionTotals), replacing the old information_schema.TABLE_ROWS
        // estimate that drifted by hundreds of rows from the exact counts the list views show.
        data.totals = await this.getActionTotals(config);
        return [data];
    }

    // Generation token for the network-totals cache: the coin's current indexed tip
    // height, briefly memoized per coin (EXPLORER_TIP_MEMO_MS, default 1s) so a
    // request burst collapses onto a single MAX(block_index) lookup rather than
    // one per request. A probe that fails returns null, which makes the caller
    // skip the cache for that request: never serve a possibly-stale total because
    // the freshness check itself broke. An empty blocks table is a real answer
    // (nothing indexed yet), not a failed probe, so it gets a generation of its
    // own ('none') rather than falling through to null.
    async totalsTipGeneration(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TIP_MEMO_MS, 10);
        if(!this._totalsTipMemo) this._totalsTipMemo = {};
        const memo = this._totalsTipMemo[coin];
        if(memo && (Date.now() - memo.at) < (Number.isFinite(ttl) ? ttl : 1000))
            return memo.tip;
        let tip = null;
        try {
            const rows = await this.doQuery(config, 'SELECT MAX(block_index) AS tip FROM blocks', []);
            if(rows && rows.length && !this.util.isNull(rows[0].tip))
                tip = String(rows[0].tip);
            else if(rows)
                tip = 'none';
        } catch(e){
            tip = null;
        }
        this._totalsTipMemo[coin] = { tip, at: Date.now() };
        return tip;
    }

    // Exact per-action-table record counts for the homepage counters, cached per coin.
    // COUNT(*) is exact (information_schema.TABLE_ROWS is only an optimizer estimate and
    // visibly disagreed with the list views), but scanning the large action tables on every
    // /api/network call would be wasteful, so the result is cached for EXPLORER_TOTALS_CACHE_MS
    // (default 60s) per coin.
    //
    // The entry is keyed on the coin's current indexed tip and reorg generation, not on the
    // coin alone. The counts are COUNT(*)s over tables the indexer only rewrites when it
    // applies a block, so a set of counts belongs to the block it was taken at, and the TTL
    // is only a ceiling on top of that. Keyed on the coin alone, counts read while a coin
    // was still catching up - the state that answers 503 COIN_DATA_STALE - kept answering
    // the public homepage for the rest of the flat TTL after the coin was healthy again, so
    // a live coin rendered its counters at their outage values. A null generation means the
    // tip probe itself failed: serve the counts but cache nothing, rather than let a
    // possibly-stale set outlive the outage that produced it.
    //
    // NOTE ON THE CLIENT: the response carries no Cache-Control and no Expires, so nothing
    // here is cached by HTTP. The explorer's own page script keeps the parsed response in
    // localStorage for 5 minutes (getCoinNetworkInfo in src/content/js/xchain.js); that is a
    // separate cache with its own recovery path, not a browser HTTP cache.
    async getActionTotals(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TOTALS_CACHE_MS, 10) || 60000;
        const gen  = await this.totalsTipGeneration(config);
        // Only the newest generation for a coin is ever useful, so keep one entry per coin
        // and compare its key rather than accumulating an entry per block.
        const key  = (gen === null) ? null : [coin, this._reorgGen[coin] || 0, gen].join('|');
        if(!this._totalsCache) this._totalsCache = {};
        const cached = (key === null) ? null : this._totalsCache[coin];
        if(cached && cached.key === key && (Date.now() - cached.at) < ttl)
            return cached.totals;
        let tables = structuredClone(this.actionTables);
        tables.push('tokens');
        let totals = {};
        let dbName = this.pools && this.pools[coin] && this.pools[coin].config
            ? this.pools[coin].config.database
            : null;
        // full_node_verifications fans out per validator, so COUNT(*) over-counts; it needs
        // COUNT(DISTINCT action_index). Every other whitelist table gets an exact COUNT(*).
        let countTables = tables.filter(t => t !== 'full_node_verifications');
        if(dbName && countTables.length){
            // Restrict to tables that actually exist so a not-yet-migrated table can't fail the
            // whole UNION, then count the survivors in one round trip. Table names come from the
            // hardcoded actionTables whitelist (never user input), so interpolating them is safe.
            let placeholders = countTables.map(() => '?').join(',');
            let existing = await this.doQuery(config,
                `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders})`,
                [dbName, ...countTables]);
            let names = (existing || []).map(r => r.TABLE_NAME);
            if(names.length){
                let unionSql = names.map(t => `SELECT '${t}' AS t, COUNT(*) AS c FROM \`${t}\``).join(' UNION ALL ');
                let rows = await this.doQuery(config, unionSql);
                if(rows && rows.length)
                    for(let row of rows)
                        totals[row.t] = Number(row.c);
            }
        }
        let fnvResult = await this.doQuery(config, `SELECT count(DISTINCT action_index) as count FROM full_node_verifications`);
        if(fnvResult && fnvResult.length)
            totals['full_node_verifications'] = Number(fnvResult[0].count);
        if(key !== null)
            this._totalsCache[coin] = { key, at: Date.now(), totals };
        return totals;
    }

    async getStatus(config){
        let coinConfigs = await this.configInfo.getConfig();
        // Age of the explorer's last successful hub-config fetch. The explorer caches hub
        // config (in memory + on disk) and serves it even when the hub is unreachable, so a
        // climbing age here is the only signal that the served hub-derived config is stale.
        // null until the first successful fetch. getHubConfigFetchedAt may be absent against
        // an older config module; guard so /status never throws on the lookup.
        let hubFetchedAtMs = (typeof this.configInfo.getHubConfigFetchedAt === 'function')
                                ? this.configInfo.getHubConfigFetchedAt()
                                : null;
        let data = {
            supported:       coinConfigs['COIN_SUPPORTED'],
            // Copied, not aliased: the staleness gate below deletes stale coins from
            // this map and must not mutate the shared hub-config object.
            available:       Object.assign({}, coinConfigs['COIN_AVAILABLE']),
            hub_config_fetched_at:  (hubFetchedAtMs != null) ? new Date(hubFetchedAtMs).toISOString() : null,
            hub_config_age_seconds: (hubFetchedAtMs != null) ? Math.floor((Date.now() - hubFetchedAtMs) / 1000) : null,
            last_block:      {},
            last_block_time: {},
            // Decoder-tip reference and indexer lag per coin. decoder_tip is the
            // decoder's highest *processed* block; decoder_lag_blocks is
            // decoder_tip - last_block, i.e. how far the indexer trails the decoder.
            // This is the indexer->decoder slice of the pipeline ONLY, not a
            // whole-pipeline health signal. The coin node's actual chain tip is not
            // visible here: the explorer reads only the indexer/decoder DBs and never
            // talks to a coin node, so a decoder that has fallen behind the chain node
            // (the chain->decoder gap) is NOT reflected in these fields. That gap is
            // surfaced separately below via chain_tip / chain_lag_blocks /
            // decoder_health, aggregated from each decoder's own health() JSON-RPC.
            // Both fields are null for a coin when the decoder tip is
            // unavailable; last_block/last_block_time are unaffected.
            decoder_tip:        {},
            decoder_lag_blocks: {},
            // Wall-clock age of each measured coin's newest indexed block, and whether
            // that age has passed the coin's max tip age. Unlike decoder_lag_blocks these
            // see a JOINT indexer+decoder freeze, because they are measured against the
            // local clock rather than against the other replica.
            tip_age_seconds: {},
            // How far AHEAD of this host's clock each measured coin's newest
            // indexed block is dated, 0 when it is not ahead. Published because
            // tip_age_seconds is clamped at 0: without this field a future-dated
            // tip would be indistinguishable from a block mined this second, and
            // that skew is the thing an operator has to fix. null when block_time
            // is missing or unreadable, the same as tip_age_seconds.
            tip_future_seconds: {},
            // Why the indexer trails, for consumers that must tell a consensus wait
            // apart from a wedge. tip_future_seconds cannot answer this: it measures
            // the block already committed, which is always past-dated, so it reads 0
            // throughout the wait. These measure the block being WAITED ON instead.
            // indexer_state: 'live' (lag 0), 'future_block_wait' (the next block is
            // dated ahead of this host's clock, so no node may commit it yet and the
            // pause is consensus, not failure), 'behind' (the next block is
            // admissible now and still uncommitted, the state worth paging on), or
            // null when it cannot be determined. indexer_wait_clears_at is the
            // instant a future_block_wait ends, so a UI can show a countdown instead
            // of an apparently lost transaction.
            indexer_state:               {},
            next_block_time:             {},
            next_block_future_seconds:   {},
            indexer_wait_clears_at:      {},
            stale:           {},
            // Durable consensus-divergence halt xchain-sync records into the same
            // replica DB this pool serves (sync_halt, cleared_at IS NULL = active).
            // A halted replica applies no further blocks but keeps reporting a
            // small lag until its source mints past it, so neither stale nor
            // tip_age_seconds can see it; this is the only fail-closed signal that
            // can. true = an active halt row exists; false = the table was read
            // successfully and holds none; null = the signal could not be
            // determined (no pool, table absent, or a failed read) and MUST NOT
            // collapse to false, since a consumer reads false as healthy.
            replica_halted:  {}
        };
        let available = coinConfigs['COIN_AVAILABLE'] || {};
        for (let coin of Object.keys(available)) {
            if (this.pools && this.pools[coin] && this.pools[coin].pool) {
                // /status is a health endpoint: a DB read now throws on failure
                // (M-4), but here we must still return the rest of the report
                // rather than 500 the whole thing, so a failed per-coin read
                // degrades to null for that coin (the outage is exactly what an
                // operator is checking status to see). Other endpoints let the
                // throw bubble to a 5xx.
                try {
                    // Indexer position per coin: highest block index processed and its
                    // block_time.
                    data.last_block[coin]      = await this.getMaxBlockIndex({ coin, data: {} });
                    data.last_block_time[coin] = await this.getMaxBlockTime({ coin, data: {} });
                    // Decoder tip (decoder's highest processed block) and the gap to the
                    // indexer. decoder_tip can be null when the decoder DB is
                    // unreachable/unknown; decoder_lag_blocks is then null too. Clamp to
                    // >= 0: the indexer reads from the decoder so it can never lead the
                    // decoder's tip.
                    let decoderTip = await this.getDecoderTip({ coin, data: {} });
                    data.decoder_tip[coin]        = decoderTip;
                    data.decoder_lag_blocks[coin] = (decoderTip === null) ? null : Math.max(0, decoderTip - data.last_block[coin]);
                } catch (e) {
                    data.last_block[coin]         = null;
                    data.last_block_time[coin]    = null;
                    data.decoder_tip[coin]        = null;
                    data.decoder_lag_blocks[coin] = null;
                }
                // Fail closed on a frozen replica: a coin whose newest indexed block has
                // aged past its threshold stops being advertised as available, so a
                // consumer reading this map cannot mistake a 55-hour-old tip for live
                // data. Only coins this instance actually MEASURED are gated; a coin with
                // no pool here is the pre-existing "supported but not configured" case.
                let nowSec = Math.floor(Date.now() / 1000);
                let tipSec = data.last_block_time[coin];
                // Split the signed difference into two non-negative fields. The raw
                // subtraction went negative whenever a tip was dated ahead of this
                // host's clock, and a negative age passes every "older than X"
                // comparison a consumer writes, so a genuinely frozen coin read as
                // fresher than fresh. Age clamps at 0 and the skew is published
                // separately rather than being thrown away.
                let tipDelta = (Number.isFinite(Number(tipSec)) && Number(tipSec) > 0)
                                    ? (nowSec - Number(tipSec)) : null;
                data.tip_age_seconds[coin]    = (tipDelta === null) ? null : Math.max(0, tipDelta);
                data.tip_future_seconds[coin] = (tipDelta === null) ? null : Math.max(0, -tipDelta);
                // Why the indexer is behind, not just that it is. A chain whose
                // timestamps are systematically future-dated (Bitcoin testnet4 rides
                // the 20-minute min-difficulty rule, stamping each block ~1201s after
                // its parent) makes the indexer hold every block until wall clock
                // reaches that block's OWN stamp. From outside that is
                // indistinguishable from a wedge, and it was misread as one. The
                // deciding value is the NEXT block's stamp: if it is still in the
                // future, no healthy node anywhere could have committed it yet.
                data.next_block_time[coin]            = null;
                data.next_block_future_seconds[coin]  = null;
                data.indexer_wait_clears_at[coin]     = null;
                data.indexer_state[coin]              = null;
                let lag = data.decoder_lag_blocks[coin];
                if (lag === 0) {
                    data.indexer_state[coin] = 'live';
                } else if (lag !== null && Number.isFinite(Number(data.last_block[coin]))) {
                    let nextTime = await this.getDecoderBlockTime({ coin, data: {} }, Number(data.last_block[coin]) + 1);
                    data.next_block_time[coin] = nextTime;
                    if (nextTime !== null) {
                        let ahead = nextTime - nowSec;
                        data.next_block_future_seconds[coin] = Math.max(0, ahead);
                        if (ahead > 0) {
                            // Waiting by consensus, and we can say exactly when it ends.
                            data.indexer_state[coin]          = 'future_block_wait';
                            data.indexer_wait_clears_at[coin] = new Date(nextTime * 1000).toISOString();
                        } else {
                            // The next block is admissible NOW and still uncommitted:
                            // genuinely behind. This is the state that deserves alarm,
                            // and the one a future-stamp wait was being mistaken for.
                            data.indexer_state[coin] = 'behind';
                        }
                    }
                }
                data.stale[coin] = this.isTipStale(coin, tipSec, nowSec);
                // A stale coin stays listed in `available`: it IS served, with its
                // rows annotated (see staleFailClosed). The client reads `stale`,
                // tip_age_seconds, last_block and indexer_state to draw its degraded
                // banner. Only the fail-closed opt-in still delists it, because
                // there the data routes really do answer 503.
                if (data.stale[coin] && staleFailClosed(this.configInfo)) delete data.available[coin];
                // Published beside stale, not folded into it: a halted replica keeps
                // reporting a small lag until its source mints past it, so stale
                // detects it eventually and halted detects it immediately.
                data.replica_halted[coin] = await this.getReplicaHaltStatus(coin);
            }
        }
        // Chain->decoder visibility: the slice the DB-derived fields above can't
        // see (the explorer never talks to a coin node, so a decoder stalled far
        // behind the chain still shows decoder_lag_blocks=0 once the indexer
        // catches up to its tip). Best-effort per coin via the decoder's own
        // health() JSON-RPC: chain_tip is the coin node's tip as the decoder
        // sees it, chain_lag_blocks the decoder's self-reported gap to it, and
        // decoder_health the decoder's own status ('healthy'/'unhealthy'),
        // 'unconfigured' when no endpoint resolves for the coin (neither the
        // loaded config nor DECODER_API_URL[_<COIN>_<NETWORK>]), or 'unreachable'
        // when the call fails. Calls run in parallel and are bounded by the
        // connector timeout so /status stays responsive.
        data.chain_tip        = {};
        data.chain_lag_blocks = {};
        data.decoder_health   = {};
        let prefixes = coinConfigs['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        let networks = coinConfigs['COIN_NETWORKS'] || {};
        let parseCode = (code) => {
            code = String(code || '').toUpperCase();
            // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet coin named 'TBTC'.
            for(let network in prefixes){
                let p = prefixes[network];
                if(p && code.startsWith(p)){
                    let base = code.slice(p.length);
                    if(networks[base]) return { coin: base, network };
                }
            }
            if(networks[code]) return { coin: code, network: 'mainnet' };
            return null;
        };
        await Promise.all(Object.keys(available).map(async (code) => {
            data.chain_tip[code]        = null;
            data.chain_lag_blocks[code] = null;
            let parsed = parseCode(code);
            // Per-chain endpoint from the loaded config first (setupConnectionPools),
            // so a hub-provisioned deployment reports real chain_tip / chain_lag_blocks
            // without nine DECODER_API_URL_<COIN>_<NETWORK> env vars; the specific env
            // var still overrides it, the generic one is still the last resort.
            let url    = DecoderConnector.resolveDecoderUrl(
                            parsed ? parsed.coin    : null,
                            parsed ? parsed.network : null,
                            (this.decoderApiUrl || {})[code] || null);
            if(!url){
                data.decoder_health[code] = 'unconfigured';
                return;
            }
            try {
                let h = await new DecoderConnector(url).health();
                // node_height_stale is set by the decoder when its coin-node RPC
                // has not refreshed for 2x the normal poll interval, meaning the
                // cached tip is frozen. In that state chain_tip and chain_lag_blocks
                // are misleading (lag reads as 0 while the chain may be advancing),
                // so we null them out and override health to 'node-stale' to make
                // the outage visible on the /status page.
                let tipStale = h && h.node_height_stale === true;
                // A decoder that has never completed getblockchaininfo reports
                // chainTipBlock -1 and a negative blockLag (its -1 tip sentinel),
                // and node_height_stale stays false because it never had a tip to
                // freeze. Publish unknown as null: a -1 tip is not a height, and
                // clamping the negative lag to 0 would read as "at the tip" for a
                // decoder that cannot see the chain. Prefer the decoder's own
                // null-when-unknown lag_blocks; fall back to blockLag for decoders
                // that predate it, treating a negative value as unknown.
                let tip = (h && !tipStale && typeof h.chainTipBlock === 'number' && h.chainTipBlock >= 0) ? h.chainTipBlock : null;
                let lag = null;
                if(h && !tipStale){
                    if(Object.prototype.hasOwnProperty.call(h, 'lag_blocks')){
                        lag = (typeof h.lag_blocks === 'number') ? h.lag_blocks : null;
                    } else if(typeof h.blockLag === 'number' && h.blockLag >= 0){
                        lag = h.blockLag;
                    }
                }
                data.chain_tip[code]        = tip;
                data.chain_lag_blocks[code] = lag;
                data.decoder_health[code]   = tipStale ? 'node-stale' : ((h && h.status) ? h.status : 'unreachable');
            } catch(e){
                data.decoder_health[code] = 'unreachable';
            }
        }));
        return [data];
    }

    async getToken(config){
        let data  = null;
        // A token may be looked up by its full name (PEPE) or by its numeric id
        // with a caret prefix (^1234). For the id form, filter on tick_id instead
        // of the name so both references resolve to the same token.
        let search   = String(config.data.search);
        let tickIdRef = (search.charAt(0) === '^' && this.util.isNumeric(search.substring(1)));
        let tickWhere = tickIdRef ? 't1.tick_id=?' : 't2.tick=?';
        let args  = [ tickIdRef ? Number(search.substring(1)) : config.data.search ];
        let query = `SELECT
                        t2.tick,
                        -- F3 (id-determinism): expose tick_id for SDK ^<id> compaction ONLY when it
                        -- is in the deterministic set (index_tickers.block_index IS NOT NULL). An
                        -- out-of-band id is not reproducible across nodes, so the SDK must never
                        -- compact to it (the indexer would reject the ^id). Gates the SDK-facing
                        -- info.tick_id only; the t1.tick_id lookup/WHERE below is unaffected.
                        (CASE WHEN t2.block_index IS NOT NULL THEN t1.tick_id ELSE NULL END) AS tick_id,
                        t1.supply,
                        t1.max_supply,
                        t1.max_mint,
                        t1.decimals,
                        t1.description,
                        t1.lock_max_supply,
                        t1.lock_mint,
                        t1.lock_mint_supply,
                        t1.lock_max_mint,
                        t1.lock_description,
                        t1.lock_sleep,
                        t1.lock_callback,
                        t1.callback_block,
                        t3.tick as callback_tick,
                        t4.decimals as callback_decimals,
                        t4.coin_price as callback_coin_price,
                        t1.callback_amount,
                        t1.allow_list,
                        t1.block_list,
                        t1.mint_address_max,
                        t1.mint_start_block,
                        t1.mint_stop_block,
                        a1.address as owner,
                        t1.coin_price,
                        t1.coin_floor,
                        t1.escrow_action_index,
                        -- Token-bridge state (ISSUE format 7, xchain-token-bridge.md section 8).
                        -- The wallet's tokenInfo projection reads these off the grouped row, so
                        -- where each lands matters: lock_bridge carries the lock_ prefix and the
                        -- grouping loop below folds it into locks.bridge, while bridge_chains,
                        -- min_depth and bridged match no group prefix and land in info. Omitting
                        -- them made every wallet bridge surface read null in production.
                        t1.bridge_chains,
                        t1.min_depth,
                        t1.lock_bridge,
                        t1.bridged
                    FROM
                        tokens t1
                        LEFT  JOIN index_tickers      t2 ON (t2.id=t1.tick_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=t1.owner_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=t1.callback_tick_id)
                        LEFT  JOIN tokens             t4 ON (t4.tick_id=t1.callback_tick_id)
                    WHERE
                        ` + tickWhere + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            data = {
                info: {
                    coin: config.coin,   // Current COIN (BTC, LTC, DOGE, etc)
                    tick: null,
                    description : null,
                    owner: null
                },
                callback: {
                    tick: null,  // Callback tick
                    price: null, // Callback tick price (tokens.coin_price)
                    block: null, // Callback block
                    amount: null // Callback amount
                },
                market: {
                    price: null, // Tick  price (tokens.coin_price)
                    floor: null, // Floor price (tokens.floor_price)
                },
                lists: {
                    allow: null,
                    block: null
                },
                locks: {
                    bridge: false,  // LOCK_BRIDGE: freezes BRIDGE_CHAINS/MIN_DEPTH forever
                    callback: false,
                    description: false,
                    max_mint: false,
                    max_supply: false,
                    mint: false,
                    mint_supply: false,
                    sleep: false
                },
                mints: {
                    max: null,
                    address_max: null,
                    start_block: null,
                    stop_block: null
                },
                supply: {
                    current: null,
                    max: null
                }
            };
            for( let key in row ){
                let name  = key;
                let value = row[key];
                // Skip/Ignore any decimal fields
                if(String(key).includes('decimals'))
                    continue;
                // Group LOCK fields
                if(String(key).substring(0,5)=='lock_'){
                    name  = String(key).replace('lock_','');
                    value = (row[key]=="1") ? true : false;
                    data.locks[name] = value;
                // Group LIST fields
                } else if(String(key).substring(5,10)=='_list'){
                    name = String(key).replace('_list','');
                    data.lists[name] = (this.util.isNumeric(value)) ? Number(value) : null;
                // Group MINT fields
                } else if(String(key).substring(0,5)=='mint_' || key=='max_mint'){
                    name = String(key).replace('mint_','').replace('_mint','');
                    data.mints[name] = Number(value);
                // Group CALLBACK fields
                } else if(String(key).substring(0,9)=='callback_'){
                    name = String(key).replace('callback_','').replace('coin_','');
                    if(name=='amount'){
                        data.callback[name] = this.util.bcformat(value, row['callback_decimals']);
                    } else {
                        data.callback[name] = value;
                    }
                // Group SUPPLY fields
                } else if(['supply','max_supply'].includes(key)){
                    if(name=='supply')     name = 'current';
                    if(name=='max_supply') name = 'max';
                    data.supply[name] = this.util.bcformat(value, row['decimals']);
                // Group COIN fields
                } else if(String(key).substring(0,5)=='coin_'){
                    name = String(key).replace('coin_','');
                    data.market[name] = Number(value);
                } else {
                    data.info[name] = value;
                }
            }
            // Expose the token's own decimals (the grouping loop above skips every
            // *decimals* column so callback_decimals doesn't leak into info).
            // Clients need it for NFT-pattern classification (nft-standard.md:
            // DECIMALS=0 AND LOCK_MAX_SUPPLY=1 (the lock is already in locks.max_supply).
            data.info.decimals   = Number(row.decimals);
            data.supply.decimals = Number(row.decimals);
            // Expose the immutable numeric ticker id (index_tickers.id) so clients
            // (e.g. the SDK) can compact a ticker name into its `^<id>` wire form.
            data.info.tick_id    = (row.tick_id !== undefined && row.tick_id !== null) ? Number(row.tick_id) : null;
            // Project registry surfaces (protocol/project-registry.md):
            // projects = registries whose CURRENT roster includes this token
            // (drives the "Official: part of X" banner); registry = this token's
            // own roster metadata when it IS a project (null otherwise).
            data.projects = await this.getTokenProjects(config, data.info.tick);
            data.registry = await this.getProjectRosterInfo(config, data.info.tick);
            // Controller bindings still gating this token's native actions
            // (protocol/controller-bound-tokens.md). [] when nothing gates.
            data.controllers = await this.getTokenControllerBindings(config, data.info.tick);
            // Open governance polls over this token (VOTE v0, poll_status='open').
            // Drives the token page's Active Governance card: voter apathy is the
            // attack surface (a poll nobody sees is a poll nobody out-votes), so
            // open polls surface on the token itself, binding polls flagged.
            data.open_polls = await this.getTokenOpenPolls(config, data.info.tick);
            // Files LINKed to this token (the NFT pattern: LINK v0 binds a FILE action to a
            // token's ISSUE). The Files TAB already lists these, but the info column - the
            // part of the page a reader actually looks at for what a token IS - said "No
            // additional information is available" beside a token carrying on-chain artwork.
            // Same rows the tab reads (mappings_files), so nothing new is indexed.
            data.linked_files = await this.getTokenLinkedFiles(config, data.info.tick);
        }
        return [data];
    }

    // Files LINKed to a token, newest link first. `title`/`name`/`type` drive the token
    // page's Linked Files card and its artwork pick; `gated` tells the page a file's bytes
    // are gated behind a token balance, so it can say so instead of offering a raw link
    // that will refuse. Capped: this feeds an info card, not a paged list.
    async getTokenLinkedFiles(config, tick){
        if(this.util.isNull(tick)) return [];
        let rows = await this.doQuery(config,
            `SELECT
                f1.action_index,
                f1.name,
                f1.title,
                t3.type,
                b1.block_index,
                (gf.action_index IS NOT NULL) as gated
            FROM
                mappings_files m
                INNER JOIN index_tickers      t4 ON (t4.id=m.id AND t4.tick=?)
                INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id AND s1.status='valid')
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
            WHERE
                m.type_id=1
            ORDER BY m.action_index DESC
            LIMIT 10`, [tick]);
        if(!rows || !rows.length) return [];
        return rows.map(r => ({
            action_index: Number(r.action_index),
            name:         r.name,
            title:        r.title,
            type:         r.type,
            block_index:  Number(r.block_index),
            gated:        Number(r.gated) === 1
        }));
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

    async getAddressId(config, address){
        let key    = this.cacheKey(config.coin, address);
        let cached = this.cacheGet(this._addressIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [address];
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._addressIdCache, key, id);
        return id;
    }

    // Address -> index id resolved BYTE-EXACTLY. Used by the MATCHING paths only:
    // getMempool TYPE=address and the Broadcaster's mempool fan-out memo.
    //
    // index_addresses is CHARSET=utf8 COLLATE=utf8_general_ci, so the plain
    // `address=?` in getAddressId matches every case variant of an address and
    // hands back the id of a DIFFERENT address. Display and search paths want that
    // (a human typing an address by hand reaches the page they meant). A matcher
    // must not have it: a `^<id>` destination on the wire is an exact reference, so
    // a case variant resolved through the ci lookup makes an unrelated address a
    // party to the transaction, and a wallet shows somebody else's pending payment
    // as its own. Base58 is case-SENSITIVE; a case variant is a different string,
    // not the same address typed loosely.
    //
    // BECH32, deliberately not handled here: BIP173 addresses are case-INSENSITIVE
    // with a lowercase canonical form, so an uppercase bech32 spelling resolves to
    // null through this lookup and its compacted destinations go unmatched (literal
    // segments still match, and the sender still matches). Canonicalizing an
    // address before lookup is address-normalization work that belongs to the row
    // that owns it, not to this matcher.
    //
    // The equality is written twice on purpose. `address=?` runs in the table's own
    // collation and is the index seek (index_addresses has a UNIQUE index on
    // address, so under a ci collation it returns at most one row for all case
    // variants); the utf8_bin comparison is the byte-exact gate over that one row.
    // Collating the column alone in the seek predicate would force a full scan.
    // Cached like getAddressId, non-null results only, in its own LRU.
    async getExactAddressId(config, address){
        let key    = this.cacheKey(config.coin, address);
        let cached = this.cacheGet(this._exactAddressIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [address, address];
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=? AND address COLLATE utf8_bin = ?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._exactAddressIdCache, key, id);
        return id;
    }

    // Resolve an address to its index id ONLY when that id is in the DETERMINISTIC set
    // (assigned inside a block tx, block_index IS NOT NULL) - the id-space a wire ^<id>
    // may safely reference. Backs the SDK-facing info.address_id in getAddress (F3
    // id-determinism). Distinct from getAddressId, which resolves ANY id (incl. out-of-band
    // recovery pre-seeds) for internal string<->id display/lookup paths that must not change.
    // Uncached: one call per getAddress request, and a NULL-block id must never be cached as
    // compactable (it could be upgraded to a deterministic id on a later reindex).
    async getCompactableAddressId(config, address){
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=? AND block_index IS NOT NULL
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [address]);
        return (results && results.length) ? results[0].id : null;
    }

    async getTickId(config, tick){
        // A `^<id>` reference resolves directly to the numeric id, no lookup
        // needed. Everything after the caret is the id (do not drop any digit).
        let str = String(tick);
        if(str.charAt(0) === '^' && this.util.isNumeric(str.substring(1)))
            return Number(str.substring(1));
        let key    = this.cacheKey(config.coin, tick);
        let cached = this.cacheGet(this._tickIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [tick];
        let query = `SELECT
                        id
                    FROM
                        index_tickers
                    WHERE
                        tick=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this.cacheSet(this._tickIdCache, key, id);
        return id;
    }

    async getBlocks(config){
        let sql     = config.data.sql;
        let offset  = config.data.offset;
        let data    = [];
        let total   = 0;
        let query   = '';
        let results = null;
        query = `SELECT
                    count(*) as total
                FROM
                    blocks b1
                WHERE ` + sql.where.data;
        results = await this.doQuery(config, query);
        if(results && results.length)
            total = results[0].total;
        // BIND THE PAGING PLACEHOLDER. getBlocks builds and runs its own queries rather than
        // returning [query, args] to the shared path, and that shared path is where every
        // other list method gets its offset args threaded in. Without them the `?` in
        // `AND b1.block_index < ?` reached MariaDB as literal text and the whole feed
        // answered 500 on a syntax error, on every coin and every network - page 1 included,
        // because the first page carries an offset clause too. getBlocks takes no
        // data-WHERE placeholder of its own (getQueryWhereSql excludes it from the type
        // branch and anchors on `b1.block_index IS NOT NULL`), so the offset args are the
        // complete set; the count query above needs none for the same reason.
        let offsetArgs = (sql.where.offsetArgs && sql.where.offsetArgs.length) ? sql.where.offsetArgs : undefined;
        query = `SELECT
                    block_index,
                    block_time
                FROM
                    blocks b1
                WHERE
                    ` + sql.where.data + sql.where.offset + `
                ORDER BY block_index ` + sql.order + `
                LIMIT ` + sql.limit;
        results = await this.doQuery(config, query, offsetArgs);
        if(results && results.length){
            let blockIndexes = results.map(r => r.block_index);
            let blockMap = {};
            for(let row of results){
                blockMap[row.block_index] = {
                    block_index: row.block_index,
                    timestamp: row.block_time,
                    actions: {}
                };
            }
            let query2 = '';
            let blockArgs = [];
            let placeholders = blockIndexes.map(() => '?').join(',');
            for(let table of this.actionTables){
                if(query2 != '')
                    query2 += ' UNION ALL ';
                // full_node_verifications writes one row per validator pubkey sharing one
                // action_index (NODEPROOF fan-out), so COUNT(*) over-counts by validator
                // set size. Use COUNT(DISTINCT action_index) for this table only.
                const countExpr = (table === 'full_node_verifications')
                    ? 'count(DISTINCT m.action_index)'
                    : 'count(*)';
                query2 += `SELECT
                            '` + table + `' as action,
                            b1.block_index,
                            ` + countExpr + ` as count
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            b1.block_index IN (` + placeholders + `)
                        GROUP BY b1.block_index`;
                blockArgs.push(...blockIndexes);
            }
            let results2 = await this.doQuery(config, query2, blockArgs);
            if(results2 && results2.length){
                for(let row of results2){
                    let bIdx = Number(row.block_index);
                    if(blockMap[bIdx])
                        blockMap[bIdx].actions[row.action] = row.count;
                }
            }
            data = results.map(r => blockMap[r.block_index]);
        }
        return [data, null, total];
    }

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

    // Composed RICH LIST + supply stats for ONE token (spec explorer-coverage-completion
    // M5.2). Returns [object], null when the tick was never issued, following the
    // getXcall/getPoll single-record shape.
    //
    // THE COST CAP IS THE DESIGN, so it is stated rather than left to a reader to find:
    //  - This is a PER-TOKEN ranking and there is deliberately no cross-token "richest
    //    addresses on the chain" page. That query has no indexed driving column - it
    //    would sort the whole `balances` table - and the platform already has a
    //    DoS-shaped hang on record from exactly this table (getHolders' tick guard).
    //  - The tick is resolved to an id FIRST, in one unique point read, and every leg
    //    below binds `m.tick_id`, which is indexed. getHolders binds `t3.tick` through a
    //    LEFT JOIN instead, which is why it needs its own existence guard to avoid a
    //    full scan; resolving first removes that whole failure mode here.
    //  - The ranking is capped at the caller's already-clamped limit (1..100), and the
    //    holder COUNT is a separate bounded aggregate rather than a count of the rows
    //    returned, so "top 100 of 4,812 holders" is honest rather than truncated.
    //
    // Percentages are computed against CIRCULATING supply (tokens.supply), not max
    // supply: an unminted ceiling is not held by anyone, and dividing by it would
    // publish a concentration figure that understates every holder. Supply is a
    // VARCHAR on this schema and amounts can exceed 2^53, so every figure goes through
    // the bignumber helpers rather than through Number().
    async getRichList(config){
        let limit = this.detailLimit(config);
        let tick  = String(config.data.search || '');
        let tickRow = await this.doQuery(config,
            'SELECT id FROM index_tickers WHERE tick=? LIMIT 1', [tick]);
        if(!tickRow || !tickRow.length) return [null];
        let tickId = Number(tickRow[0].id);
        let tokenRow = await this.doQuery(config,
            `SELECT
                t3.tick,
                m.supply,
                m.max_supply,
                m.max_mint,
                m.decimals,
                m.lock_max_supply,
                m.lock_mint,
                m.description,
                a2.address as owner,
                m.action_index,
                t3.block_index
            FROM
                tokens m
                LEFT JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT JOIN index_addresses a2 ON (a2.id=m.owner_id)
            WHERE m.tick_id=?
            LIMIT 1`, [tickId]);
        // `tokens` carries no block_index of its own (see xchain-indexer
        // src/sql/tokens.sql); the height a token became deterministic lives on
        // its index_tickers row, which is what getToken reads too. Selecting it
        // off the tokens alias 500'd every rich list on a real schema while the
        // unit tier, which stubs the query, stayed green.
        // A tick can be interned by a reference (an ORDER naming a tick that was never
        // issued) without a `tokens` row ever existing, so an interned id is not proof
        // of a token. Answer not-found rather than composing supply stats around nulls.
        if(!tokenRow || !tokenRow.length) return [null];
        let token = tokenRow[0];

        // Holder census. Zero balances are excluded from BOTH the count and the ranking:
        // an address that once held the token and sent it all away is not a holder, and
        // counting it inflates the denominator of every "share of holders" figure a
        // reader might compute. amount is a VARCHAR, so the comparison is on the CAST.
        let census = await this.doQuery(config,
            `SELECT
                count(*) as holder_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as held_total
            FROM balances m
            WHERE m.tick_id=? AND CAST(m.amount AS DECIMAL(65,18)) > 0`, [tickId]);
        let holderCount = (census && census.length) ? Number(census[0].holder_count) : 0;
        let heldTotal   = (census && census.length) ? String(census[0].held_total)   : '0';

        // The page offset is applied to the QUERY as well as to the rank numbers
        // below. Seeding the ranks alone made page 2 return the same top-N addresses
        // relabelled 101..200, which is worse than restarting at 1: it names the
        // largest holder as the 101st. Same OFFSET idiom getData uses for API paging.
        let offset = Number(config.type == 'api' && config.data.sql && this.util.isNumeric(config.data.sql.apiOffset)
            ? Number(config.data.sql.apiOffset) : 0);
        let holders = await this.doQuery(config,
            `SELECT
                a2.address,
                m.amount
            FROM
                balances m
                LEFT JOIN index_addresses a2 ON (a2.id=m.address_id)
            WHERE m.tick_id=? AND CAST(m.amount AS DECIMAL(65,18)) > 0
            ORDER BY CAST(m.amount AS DECIMAL(65,18)) DESC
            LIMIT ` + limit + (offset > 0 ? ' OFFSET ?' : ''),
            offset > 0 ? [tickId, offset] : [tickId]) || [];

        // The denominator. Circulating supply is the token's own `supply` column; the
        // summed balances are carried alongside rather than substituted for it, because
        // a disagreement between the two is a real indexer symptom and hiding it behind
        // whichever number makes the percentages total 100 would erase the evidence.
        let supply = this.util.isNull(token.supply) ? '0' : String(token.supply);
        let ranked = [];
        let rank   = offset;
        for(const h of holders){
            rank++;
            ranked.push({
                rank:    rank,
                address: h.address,
                amount:  h.amount,
                percent: this.supplyPercent(h.amount, supply)
            });
        }
        return [{
            tick:            token.tick,
            supply:          supply,
            max_supply:      token.max_supply,
            max_mint:        token.max_mint,
            decimals:        token.decimals,
            lock_max_supply: token.lock_max_supply,
            lock_mint:       token.lock_mint,
            description:     token.description,
            owner:           token.owner,
            action_index:    token.action_index,
            block_index:     token.block_index,
            holder_count:    holderCount,
            // Sum of every non-zero balance. Equal to `supply` on a healthy index; kept
            // as its own field precisely so the two can be compared.
            held_total:      heldTotal,
            ranked_count:    ranked.length,
            top_holder_percent: ranked.length ? ranked[0].percent : null,
            // Concentration of the top ten, which is the figure a reader actually wants
            // from a rich list. Null (not 0) when fewer than ten holders were ranked, so
            // "we did not measure this" never reads as "the top ten hold nothing".
            top_ten_percent: (ranked.length >= 10)
                ? this.supplyPercent(this.supplySum(ranked.slice(0, 10)), supply)
                : null,
            holders:         ranked
        }];
    }

    // Sum of a ranked slice's amounts as a fixed-18 STRING, or null when any member is
    // unreadable. Null rather than a partial sum on purpose: a concentration figure
    // computed over nine of ten balances is wrong, not approximate.
    supplySum(rows){
        try {
            let acc = '0';
            for(const r of rows) acc = this.util.bcformat(this.util.bcadd(acc, String(r.amount), 18), 18);
            return acc;
        } catch(e){
            return null;
        }
    }

    // Percent of `supply` that `amount` represents, as a fixed-8 STRING. Null when the
    // supply is zero or unreadable: a percentage of nothing is undefined, and returning
    // 0 there would render as "holds none of it" for an address that holds all of it.
    supplyPercent(amount, supply){
        if(this.util.isNull(amount) || this.util.isNull(supply)) return null;
        // Both figures arrive from VARCHAR columns, so a malformed row is a real
        // possibility and mathjs THROWS on one rather than returning NaN. A percentage
        // is decoration on a page whose subject is the balance itself; refusing to
        // render the whole rich list because one row's amount is junk would be worse
        // than omitting that row's percentage.
        try {
            let s = this.util.bcformat(supply, 18);
            let a = this.util.bcformat(amount, 18);
            if(!this.util.bcgt(s, '0')) return null;
            return this.util.bcformat(
                this.util.bcdiv(this.util.bcmul(a, '100', 18), s, 18), 8);
        } catch(e){
            return null;
        }
    }
}

module.exports = EntityReaders.prototype;
