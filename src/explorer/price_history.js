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
 * XChain Explorer - token price history: GET /{COIN}/api/price_history
 *
 * ?assets=A,B,C&interval=hour|day&from=&to=&fiat=USD&quote=BTC
 *
 * Per asset, up to two downsampled series, each naming where it came from:
 *
 *   oracle  ASSET/FIAT from the hub-mirrored price_snapshots rounds, in fiat
 *   dex     ASSET/QUOTE from valid order_matches fills, in the quote coin
 *
 * Buckets start on UTC interval boundaries; a point is the LAST price inside
 * its bucket, and a bucket with no price has no point (nothing is carried
 * forward or zero-filled). An asset with no data in a source has no series
 * from it, and one with no data anywhere is listed under `missing`.
 *
 * Installed onto XChainExplorer.prototype by explorer/install.js.
 *
 ********************************************************************/

'use strict';

const { coinReadGate } = require('./coin_read_gate.js');

const INTERVALS = { hour: 3600, day: 86400 };

// Bounds on one request: assets named, and points in any one series. A wider
// range is refused rather than truncated, so a short answer never reads as a
// short history.
const PRICE_ASSETS_MAX = 50;
const PRICE_POINTS_MAX = 1000;

// Range served when the caller names no `from`.
const DEFAULT_SPAN = { hour: 7 * 86400, day: 365 * 86400 };

const ASSET_MAX_LENGTH = 250;
const FIAT_PATTERN     = /^[A-Z]{2,10}$/;

function refusal(error, code){
    return { refusal: { error, code } };
}

// assets=A,B,C splits on commas; a repeated assets= param is taken entry by
// entry and not split, which is how a ticker containing a comma is named.
function parseAssets(raw){
    const list = Array.isArray(raw)
        ? raw.map(String)
        : (typeof raw === 'string' ? raw.split(',') : []);
    const assets = [];
    for(const entry of list){
        const asset = entry.trim();
        if(asset.length === 0 || asset.length > ASSET_MAX_LENGTH || /[\u0000-\u001f]/.test(asset))
            return refusal('assets must be non-empty tickers of at most ' + ASSET_MAX_LENGTH + ' characters', 'INVALID_ASSETS');
        if(!assets.includes(asset)) assets.push(asset);
    }
    if(assets.length === 0)
        return refusal('assets is required: a comma-separated list of tickers', 'INVALID_ASSETS');
    if(assets.length > PRICE_ASSETS_MAX)
        return refusal('Too many assets (max ' + PRICE_ASSETS_MAX + ')', 'TOO_MANY_ASSETS');
    return { assets };
}

function parseTime(util, raw, fallback){
    if(raw === undefined || raw === null || raw === '') return { value: fallback };
    if(!util.isSafeIntegerParam(raw)) return { invalid: true };
    return { value: Number(raw) };
}

/**
 * Resolve the bucket grid: the first and last bucket starts and the interval.
 * Returns { range } or { refusal } carrying the 400 body.
 */
function parseRange(util, query, nowSeconds){
    const name = (query.interval === undefined) ? 'day' : String(query.interval).toLowerCase();
    if(!Object.prototype.hasOwnProperty.call(INTERVALS, name))
        return refusal('interval must be hour or day', 'INVALID_INTERVAL');
    const interval = INTERVALS[name];
    const to   = parseTime(util, query.to, nowSeconds);
    if(to.invalid) return refusal('to must be a unix timestamp in seconds', 'INVALID_RANGE');
    const from = parseTime(util, query.from, Math.max(0, to.value - DEFAULT_SPAN[name]));
    if(from.invalid) return refusal('from must be a unix timestamp in seconds', 'INVALID_RANGE');
    if(from.value > to.value) return refusal('from must not be later than to', 'INVALID_RANGE');
    const start     = from.value - (from.value % interval);
    const lastStart = to.value - (to.value % interval);
    if((lastStart - start) / interval + 1 > PRICE_POINTS_MAX)
        return refusal('Range holds more than ' + PRICE_POINTS_MAX + ' ' + name + ' buckets; narrow from/to or use a wider interval', 'RANGE_TOO_LARGE');
    return { range: { name, interval, start, lastStart } };
}

function parseLabel(raw, fallback, pattern){
    if(raw === undefined || raw === null || raw === '') return fallback;
    const value = String(raw).trim().toUpperCase();
    return (pattern.test(value)) ? value : null;
}

// Request labels compared the way the database compares them: exact first,
// then case-blind, since coin_pair and coin columns use a case-blind collation.
function assetFinder(assets){
    const lower = new Map(assets.map((asset) => [asset.toLowerCase(), asset]));
    return (label) => assets.includes(label) ? label : (lower.get(String(label).toLowerCase()) || null);
}

function oracleSeries(util, assets, fiat, rows){
    const byPair = new Map(assets.map((asset) => [(asset + '/' + fiat).toLowerCase(), asset]));
    const series = new Map();
    for(const row of rows){
        const asset = byPair.get(String(row.coin_pair).toLowerCase());
        if(!asset) continue;
        if(!series.has(asset))
            series.set(asset, { asset, source: 'oracle', pair: asset + '/' + fiat, quote: fiat, points: [] });
        series.get(asset).points.push({ t: Number(row.t), price: String(util.plainDecimal(row.price)), at: Number(row.block_timestamp) });
    }
    return series;
}

// Which requested asset a fill prices against the quote, and on which side.
function fillSide(find, quote, row){
    const isQuote = (label) => String(label).toLowerCase() === quote.toLowerCase();
    const giver = find(row.give_label);
    if(giver && isQuote(row.get_label)) return { asset: giver, assetGives: true };
    const getter = find(row.get_label);
    if(getter && isQuote(row.give_label)) return { asset: getter, assetGives: false };
    return null;
}

// One point per asset and bucket: the later of the two orientations' last fills,
// priced in quote units per whole asset as /market/{ASSET}/{QUOTE}/history does.
function dexSeries(util, assets, quote, rows){
    const find   = assetFinder(assets);
    const latest = new Map();
    for(const row of rows){
        const side = fillSide(find, quote, row);
        if(!side || !util.bcgt(row.give_amount, 0) || !util.bcgt(row.get_amount, 0)) continue;
        const price = side.assetGives ? util.getPrice(row.get_amount, row.give_amount) : util.getPrice(row.give_amount, row.get_amount);
        const point = { asset: side.asset, t: Number(row.t), price: util.bcnum(price).toFixed(), at: Number(row.last_time),
            fills: Number(row.fills), last_action: Number(row.last_action) };
        const key   = side.asset + '\u0000' + point.t;
        const prior = latest.get(key);
        const keep  = (prior && prior.last_action > point.last_action) ? prior : point;
        if(prior) keep.fills = prior.fills + point.fills;
        latest.set(key, keep);
    }
    const series = new Map();
    for(const point of [...latest.values()].sort((x, y) => x.t - y.t)){
        if(!series.has(point.asset))
            series.set(point.asset, { asset: point.asset, source: 'dex', pair: point.asset + '/' + quote, quote, points: [] });
        series.get(point.asset).points.push({ t: point.t, price: point.price, at: point.at, fills: point.fills });
    }
    return series;
}

class PriceHistoryReads {

    async processPriceHistoryRequest(req, res){
        const query  = (req.query && typeof req.query === 'object') ? req.query : {};
        const assets = parseAssets(query.assets);
        if(assets.refusal) return this.sendBatchJson(res, 400, assets.refusal);
        const range  = parseRange(this.util, query, Math.floor(Date.now() / 1000));
        if(range.refusal) return this.sendBatchJson(res, 400, range.refusal);
        const coin = String((req.params && req.params.coin) || '').toUpperCase();
        const gate = await coinReadGate(this, coin, res);
        if(gate.refusal) return this.sendBatchJson(res, 503, gate.refusal);
        const fiat  = parseLabel(query.fiat, 'USD', FIAT_PATTERN);
        const coinCode = this.parseCoinCode(coin, gate.config);
        const quote = (query.quote === undefined || query.quote === '') ? (coinCode ? coinCode.coin : null) : String(query.quote).trim();
        if(fiat === null || quote === null || quote.length === 0 || quote.length > ASSET_MAX_LENGTH)
            return this.sendBatchJson(res, 400, { error: 'fiat must be a currency code and quote a coin or ticker', code: 'INVALID_QUOTE' });
        const out = await this.readPriceHistory({ coin, data: {} }, assets.assets, fiat, quote, range.range);
        return this.sendBatchJson(res, 200, out);
    }

    // Which sources this coin can serve. The oracle rounds live only in the
    // co-located hub mirror, so a coin without one reports the source as
    // unavailable rather than answering as if no prices exist.
    oracleAvailability(coin){
        const gate = this.mirrorGate(coin);
        if(gate.blocked) return { available: false, code: gate.blocked };
        try { this.db.oracleMirrorSource({ coin }, 'price_snapshots'); }
        catch(_){ return { available: false, code: 'ORACLE_SOURCE_NOT_CONFIGURED' }; }
        return { available: true };
    }

    // One statement per source, each covering every asset.
    async readPriceHistory(dbConfig, assets, fiat, quote, range){
        const oracle = this.oracleAvailability(dbConfig.coin);
        const pairs  = assets.map((asset) => asset + '/' + fiat);
        const oracleRows = oracle.available ? await this.db.getOraclePriceBuckets(dbConfig, pairs, range) : [];
        const dexAssets  = assets.filter((asset) => asset.toLowerCase() !== quote.toLowerCase());
        const dexRows    = await this.db.getDexPriceBuckets(dbConfig, dexAssets, quote, range);
        const fromOracle = oracleSeries(this.util, assets, fiat, oracleRows);
        const fromDex    = dexSeries(this.util, dexAssets, quote, dexRows);
        const series = [];
        for(const asset of assets){
            if(fromOracle.has(asset)) series.push(fromOracle.get(asset));
            if(fromDex.has(asset)) series.push(fromDex.get(asset));
        }
        return {
            interval:         range.name,
            interval_seconds: range.interval,
            from:             range.start,
            to:               range.lastStart + range.interval - 1,
            fiat,
            quote,
            price_unit:       'quote units per 1 whole unit of the asset',
            sources:          { oracle, dex: { available: true } },
            series,
            missing:          assets.filter((asset) => !fromOracle.has(asset) && !fromDex.has(asset))
        };
    }
}

module.exports = { methods: PriceHistoryReads.prototype, PRICE_ASSETS_MAX, PRICE_POINTS_MAX };
