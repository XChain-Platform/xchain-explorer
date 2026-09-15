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
 * XChain Explorer - the mempool feed, /api/network and the action totals
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). The mempool feed, the /api/network summary and the
 * per-action-type totals it quotes, with the tip generation stamp that
 * decides when a cached total is still the same chain state.
 *
 * Totals travel with the summary that serves them: the counters are
 * expensive enough to be cached, and the only reason the cache can be
 * trusted is the tip generation read immediately above them.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const coinsRegistry = require('../../../coins');

// The coin identity and network this request is for, read off the loaded explorer
// config rather than off the route code alone, so a re-tune of a chain's name,
// ticker or prefix reaches the response without an edit here. A module function
// rather than a method: Database.prototype carries the family's public readers
// and nothing else, so a cut made for length adds no name to it.
async function resolveCoinIdentity(db, config){
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
        let full  = await db.configInfo.getConfig();
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
    return { coinName, coinTick, reqNetwork };
}

// The /api/network response body, assembled from values their own readers already
// produced. Kept apart from those reads so the shape this endpoint promises is one
// legible object rather than a tail on a sequence of awaits.
function buildNetworkSummary(config, reqNetwork, parts){
    let { coinName, coinTick, block, blockTime, unconfirmed, unconfirmedNode, fee, coinPriceUsd } = parts;
    return {
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
}

class EntityNetworkReaders {
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
        let { coinName, coinTick, reqNetwork } = await resolveCoinIdentity(this, config);

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

        let data = buildNetworkSummary(config, reqNetwork,
            { coinName, coinTick, block, blockTime, unconfirmed, unconfirmedNode, fee, coinPriceUsd });
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
}

module.exports = EntityNetworkReaders.prototype;
