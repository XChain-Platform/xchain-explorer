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
 * per-action-type totals it quotes, with a bounded cache that keeps those
 * growing-table counts off the request path during its lifetime.
 *
 * Totals travel with the summary that serves them: the counters are
 * expensive enough to be cached, the TTL bounds their age, and a reorg
 * generation prevents rolled-back values from surviving a chain rewrite.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const coinsRegistry = require('../../../coins');
const { isMissingTableError } = require('../../schema_probe.js');
const { DbQueryError } = require('../../shared.js');
const DecoderConnector = require('../../../connectors/decoder.js');
const decoderReaders = require('../health/decoder.js');
const originalMempoolCount = decoderReaders.getDecoderMempoolCount, originalMempoolRows = decoderReaders.getDecoderMempoolRows;
const NODE_MEMPOOL_MAX_AGE_MS = 2 * 60 * 1000;
function decoderMempoolUrl(db, code, parsed){ return DecoderConnector.resolveDecoderUrl(parsed && parsed.coin, parsed && parsed.network, (db.decoderApiUrl || {})[code] || null); }
function ageNodeMempoolCount(snapshot, now){
    if(!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, 'node_updated_at')) return snapshot;
    const updatedAt = Number(snapshot.node_updated_at); return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt < NODE_MEMPOOL_MAX_AGE_MS ? snapshot : Object.assign({}, snapshot, { node_tx_count: null });
}
function snapshotValue(reply, now){
    const reportedOkAt = Number(reply.read_ok_at), okAt = Number.isFinite(reportedOkAt) && reportedOkAt > 0 ? reportedOkAt : (reply.stale === true ? null : now);
    const value = { node_tx_count: typeof reply.node_tx_count === 'number' && reply.node_tx_count >= 0 ? reply.node_tx_count : null, total: Number(reply.total) || 0, rows: reply.rows, read_ok_at: okAt };
    if(Object.prototype.hasOwnProperty.call(reply, 'node_updated_at')) value.node_updated_at = reply.node_updated_at; return { okAt, value: ageNodeMempoolCount(value, now) };
}
async function getDecoderMempoolSnapshot(config){
    const code = config.coin, ttl = parseInt(this.configInfo.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000, now = Date.now();
    this._mempoolApiCache = this._mempoolApiCache || {};
    const hit = this._mempoolApiCache[code];
    if(hit && (now - hit.t) < ttl) return ageNodeMempoolCount(hit.v, now);
    const url = decoderMempoolUrl(this, code, await this.parseCoinCode(code));
    if(!url) return null;
    try {
        const reply = await new DecoderConnector(url).getmempool(500);
        if(!reply || !Array.isArray(reply.rows)){
            const malformed = reply && Object.prototype.hasOwnProperty.call(reply, 'rows') ? 'invalid_rows' : 'missing_rows';
            return (this._mempoolApiCache[code] = { t: now, v: null, okAt: null, malformed }).v;
        }
        const { okAt, value } = snapshotValue(reply, now);
        if(reply.stale === true){ const usable = okAt && (now - okAt) < 2 * ttl ? value : null;
            return (this._mempoolApiCache[code] = { t: now - ttl, v: usable, okAt, stale: true, unavailable: usable === null }).v; }
        return (this._mempoolApiCache[code] = { t: now, v: value, okAt }).v;
    } catch(e){
        const okAt = hit ? hit.okAt : undefined, stale = Boolean(hit && hit.stale);
        const value = hit && hit.v && Number.isFinite(Number(okAt)) && now - Number(okAt) < 2 * ttl ? ageNodeMempoolCount(hit.v, now) : null;
        return (this._mempoolApiCache[code] = { t: stale ? now - ttl : now, v: value, okAt, stale, unavailable: value === null }).v;
    }
}
async function getDecoderMempoolCount(config){
    const parsed = await this.parseCoinCode(config.coin), snapshot = await this.getDecoderMempoolSnapshot(config);
    return snapshot ? snapshot.total : decoderMempoolUrl(this, config.coin, parsed) ? null : originalMempoolCount.call(this, config);
}
async function getDecoderMempoolRows(config, limit){
    const parsed = await this.parseCoinCode(config.coin), snapshot = await this.getDecoderMempoolSnapshot(config);
    const hit = (this._mempoolApiCache || {})[config.coin];
    return snapshot ? snapshot.rows.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500))) : decoderMempoolUrl(this, config.coin, parsed) && !(hit && hit.malformed === 'missing_rows') ? null : originalMempoolRows.call(this, config, limit);
}
for(const [name, value] of Object.entries({ getDecoderMempoolSnapshot, getDecoderMempoolCount, getDecoderMempoolRows })) Object.defineProperty(decoderReaders, name, Object.assign({}, Object.getOwnPropertyDescriptor(decoderReaders, name), { value }));
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

function buildNetworkState(block, blockTime, unconfirmed, unconfirmedNode){
    // Network information: block/time are the real indexer tip for this coin.
    return {
        block : block,
        time  : blockTime,
        // Real mempool size: count of unconfirmed XChain-carrying txs for
        // this coin (0 if neither the decoder API nor DB is reachable).
        unconfirmed: unconfirmed,
        // The coin node's TOTAL mempool tx count (XChain or not), from
        // the decoder API. null when no decoder API resolves for this
        // coin (a DB-only deployment cannot know it); clients hide it.
        unconfirmed_node: unconfirmedNode,
    };
}

function buildCoinState(coinName, coinTick, coinPriceUsd){
    // Read coin identity from the per-coin chain config.
    // Use live USD prices for mainnet coins and $0.00 for testnet/regtest,
    // where no market price exists.

    // Keep price.btc at 1.0 until a coin/BTC cross is available.
    return {
        name: coinName,
        symbol: coinTick,
        price: {
            btc: '1.00000000',
            usd: coinPriceUsd != null ? coinPriceUsd : '0.00'
        }
    };
}

function buildXchainState(){
    // XChain token info: price is a PLACEHOLDER pending XCHAIN issuance + a
    // market (it must be DEX-derived, not an external feed).
    return {
        name: 'XChain',
        symbol: 'XCHAIN',
        price: {
            btc: '0.00000000',
            usd: '0.00'
        }
    };
}

// The /api/network response body, assembled from values their own readers already
// produced. Kept apart from those reads so the shape this endpoint promises is one
// legible object rather than a tail on a sequence of awaits.
function buildNetworkSummary(config, reqNetwork, parts){
    let { coinName, coinTick, block, blockTime, unconfirmed, unconfirmedNode, fee, coinPriceUsd } = parts;
    return {
        // Per-action-type record counts (real; populated below).
        totals : {},
        network: buildNetworkState(block, blockTime, unconfirmed, unconfirmedNode),
        // Suggested fee tiers (sat/vByte) from this coin's encoder, which reads
        // the node's estimatesmartfee. Falls back to {1,2,3} when no encoder is
        // configured (ENCODER_URL) or it's unreachable. See getFeeEstimate().
        fee: fee,
        coin: buildCoinState(coinName, coinTick, coinPriceUsd),
        xchain: buildXchainState(),
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

async function readActionTotals(db, config, coin){
    let tables = structuredClone(db.actionTables);
    tables.push('tokens');
    let totals = {};
    let dbName = db.pools && db.pools[coin] && db.pools[coin].config
        ? db.pools[coin].config.database
        : null;
    // Count only tables present in the active schema so a partial migration
    // cannot make the complete network response fail.
    let countTables = tables.filter(t => t !== 'full_node_verifications');
    if(dbName && countTables.length){
        let placeholders = countTables.map(() => '?').join(',');
        let existing = await db.doQuery(config,
            `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders})`,
            [dbName, ...countTables]);
        let names = (existing || []).map(r => r.TABLE_NAME);
        if(names.length){
            let unionSql = names.map(t => `SELECT '${t}' AS t, COUNT(*) AS c FROM \`${t}\``).join(' UNION ALL ');
            let rows = await db.doQuery(config, unionSql);
            if(rows && rows.length)
                for(let row of rows)
                    totals[row.t] = Number(row.c);
        }
    }
    // Count one verification per action because the table fans out by validator.
    // A format 5 LIST has no lists row, so its per-table count is appended to
    // the same supplemental pass. Format 4 stays counted only by `lists`.
    const fnvSql = `SELECT 'full_node_verifications' as action,
                        count(DISTINCT action_index) as count
                    FROM full_node_verifications`;
    let supplemental;
    try {
        supplemental = await db.doQuery(config, fnvSql + ` UNION ALL
                    SELECT 'lists' as action,
                        count(*) as count
                    FROM list_metas m
                        INNER JOIN actions a1 ON (a1.action_index=m.action_index)
                    WHERE a1.action_format = 5`);
    } catch(e){
        if(!isMissingTableError(e)) throw e;
        supplemental = await db.doQuery(config, fnvSql);
    }
    if(supplemental && supplemental.length){
        for(let row of supplemental){
            let count = Number(row.count);
            if(!Number.isFinite(count)) continue;
            if(row.action === 'lists')
                totals.lists = Number(totals.lists || 0) + count;
            else
                totals.full_node_verifications = count;
        }
    }
    return totals;
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
        let feed   = await this.getDecoderMempoolFeed(config, 500);
        if(feed === null)
            throw new DbQueryError('DECODER_MEMPOOL_UNAVAILABLE: decoder mempool is configured but not answering for ' + config.coin);
        let rows   = feed.rows;
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

    async getDecoderMempoolFeed(config, limit){
        const code = config.coin, parsed = await this.parseCoinCode(code);
        if(!decoderMempoolUrl(this, code, parsed)) return { rows: await this.getDecoderMempoolRows(config, limit), read_ok_at: Date.now() };
        const ttl = parseInt(this.configInfo.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000, snap = await this.getDecoderMempoolSnapshot(config);
        const hit = (this._mempoolApiCache || {})[code], okAt = snap && snap.read_ok_at ? snap.read_ok_at : hit && hit.okAt;
        if(!snap || !okAt || (Date.now() - okAt) >= 2 * ttl) return null;
        return { rows: snap.rows.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500))), read_ok_at: okAt };
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

    // Exact per-action-table record counts for the homepage counters, cached per coin.
    // The stable TTL bounds count frequency even while the indexed tip advances, and one
    // shared promise collapses simultaneous cold requests onto the same count pass.
    //
    // NOTE ON THE CLIENT: the response carries no Cache-Control and no Expires, so nothing
    // here is cached by HTTP. The explorer's own page script keeps the parsed response in
    // localStorage for 5 minutes (getCoinNetworkInfo in src/content/js/xchain.js); that is a
    // separate cache with its own recovery path, not a browser HTTP cache.
    async getActionTotals(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TOTALS_CACHE_MS, 10) || 60000;
        const key  = [coin, this._reorgGen[coin] || 0].join('|');
        if(!this._totalsCache) this._totalsCache = {};
        if(!this._totalsLoads) this._totalsLoads = {};
        const cached = this._totalsCache[coin];
        if(cached && cached.key === key && (Date.now() - cached.at) < ttl)
            return cached.totals;
        let active = this._totalsLoads[coin];
        if(active && active.key === key)
            return active.promise;
        let promise = readActionTotals(this, config, coin);
        this._totalsLoads[coin] = { key, promise };
        try {
            let totals = await promise;
            this._totalsCache[coin] = { key, at: Date.now(), totals };
            return totals;
        } finally {
            if(this._totalsLoads[coin] && this._totalsLoads[coin].promise === promise)
                delete this._totalsLoads[coin];
        }
    }
}

module.exports = EntityNetworkReaders.prototype;
