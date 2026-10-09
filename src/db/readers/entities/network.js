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
 * XChain Explorer - the mempool feed, /api/network and action totals
 *
 ********************************************************************/

'use strict';

const coinsRegistry = require('../../../coins');
const { isMissingTableError } = require('../../schema_probe.js');
const { DbQueryError } = require('../../shared.js');
const DecoderConnector = require('../../../connectors/decoder.js');
const decoderReaders = require('../health/decoder.js');

const originalMempoolCount = decoderReaders.getDecoderMempoolCount;
const originalMempoolRows = decoderReaders.getDecoderMempoolRows;
const NODE_MEMPOOL_MAX_AGE_MS = 2 * 60 * 1000;

function decoderMempoolUrl(db, code, parsed){
    return DecoderConnector.resolveDecoderUrl(
        parsed ? parsed.coin    : null,
        parsed ? parsed.network : null,
        (db.decoderApiUrl || {})[code] || null);
}

function ageNodeMempoolCount(snapshot, now){
    if(!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, 'node_updated_at'))
        return snapshot;
    const updatedAt = Number(snapshot.node_updated_at);
    if(Number.isFinite(updatedAt) && updatedAt > 0 && (now - updatedAt) < NODE_MEMPOOL_MAX_AGE_MS)
        return snapshot;
    return Object.assign({}, snapshot, { node_tx_count: null });
}

function cacheSnapshot(db, code, entry){
    db._mempoolApiCache[code] = entry;
    return entry.v;
}

function snapshotValue(reply, now){
    const reportedOkAt = Number(reply.read_ok_at);
    const okAt = Number.isFinite(reportedOkAt) && reportedOkAt > 0
        ? reportedOkAt : (reply.stale === true ? null : now);
    const value = {
        node_tx_count: (typeof reply.node_tx_count === 'number' && reply.node_tx_count >= 0)
            ? reply.node_tx_count : null,
        total: Number(reply.total) || 0,
        rows: reply.rows,
        read_ok_at: okAt
    };
    if(Object.prototype.hasOwnProperty.call(reply, 'node_updated_at'))
        value.node_updated_at = reply.node_updated_at;
    return { okAt, value: ageNodeMempoolCount(value, now) };
}

async function getDecoderMempoolSnapshot(config){
    const code = config.coin;
    const ttl  = parseInt(this.configInfo.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
    const now  = Date.now();
    this._mempoolApiCache = this._mempoolApiCache || {};
    const hit = this._mempoolApiCache[code];
    if(hit && (now - hit.t) < ttl) return ageNodeMempoolCount(hit.v, now);
    const parsed = await this.parseCoinCode(code);
    const url = decoderMempoolUrl(this, code, parsed);
    if(!url) return null;
    try {
        const reply = await new DecoderConnector(url).getmempool(500);
        if(!reply || !Array.isArray(reply.rows))
            return cacheSnapshot(this, code, { t: now, v: null, okAt: null, malformed: true });
        const { okAt, value } = snapshotValue(reply, now);
        if(reply.stale === true){
            const usable = okAt && (now - okAt) < 2 * ttl ? value : null;
            return cacheSnapshot(this, code,
                { t: now - ttl, v: usable, okAt, stale: true, unavailable: usable === null });
        }
        return cacheSnapshot(this, code, { t: now, v: value, okAt });
    } catch(e){
        const okAt = hit ? hit.okAt : undefined;
        const value = hit && hit.v && Number.isFinite(Number(okAt)) && (now - Number(okAt)) < 2 * ttl
            ? ageNodeMempoolCount(hit.v, now) : null;
        const stale = Boolean(hit && hit.stale);
        return cacheSnapshot(this, code,
            { t: stale ? now - ttl : now, v: value, okAt, stale, unavailable: value === null });
    }
}

async function getDecoderMempoolCount(config){
    const parsed = await this.parseCoinCode(config.coin);
    const configured = Boolean(decoderMempoolUrl(this, config.coin, parsed));
    const snapshot = await this.getDecoderMempoolSnapshot(config);
    if(snapshot) return snapshot.total;
    if(configured) return null;
    return originalMempoolCount.call(this, config);
}

async function getDecoderMempoolRows(config, limit){
    const parsed = await this.parseCoinCode(config.coin);
    const configured = Boolean(decoderMempoolUrl(this, config.coin, parsed));
    const snapshot = await this.getDecoderMempoolSnapshot(config);
    if(snapshot){
        const max = Math.max(1, Math.min(Number(limit) || 200, 500));
        return snapshot.rows.slice(0, max);
    }
    if(configured) return null;
    return originalMempoolRows.call(this, config, limit);
}

for(const [name, value] of Object.entries({
    getDecoderMempoolSnapshot,
    getDecoderMempoolCount,
    getDecoderMempoolRows
})){
    const descriptor = Object.getOwnPropertyDescriptor(decoderReaders, name);
    Object.defineProperty(decoderReaders, name, Object.assign({}, descriptor, { value }));
}

async function resolveCoinIdentity(db, config){
    let code = config.coin;
    let coinName = String(code), coinTick = String(code);
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
    return {
        block : block,
        time  : blockTime,
        unconfirmed: unconfirmed,
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
    // Reads one bounded mempool window and applies address/token filters in JS.
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
        const code   = config.coin;
        const parsed = await this.parseCoinCode(code);
        const url    = DecoderConnector.resolveDecoderUrl(
                         parsed ? parsed.coin    : null,
                         parsed ? parsed.network : null,
                         (this.decoderApiUrl || {})[code] || null);
        if(!url)
            return { rows: await this.getDecoderMempoolRows(config, limit), read_ok_at: Date.now() };
        const ttl  = parseInt(this.configInfo.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
        const snap = await this.getDecoderMempoolSnapshot(config);
        const hit  = (this._mempoolApiCache || {})[code];
        const okAt = snap && snap.read_ok_at ? snap.read_ok_at : hit && hit.okAt;
        if(!snap || !okAt || (Date.now() - okAt) >= 2 * ttl)
            return null;
        const max = Math.max(1, Math.min(Number(limit) || 200, 500));
        return { rows: snap.rows.slice(0, max), read_ok_at: okAt };
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
