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
 * XChain Explorer - downsampled price series for many assets
 *
 * The statements behind GET /{COIN}/api/price_history, one per source plus
 * the DEX window's block bounds. Each covers every requested asset at once and
 * downsamples in SQL, so the count never grows with the asset count or range:
 *
 *   oracle  one range read of price_snapshots on (coin_pair, block_timestamp),
 *           grouped to each bucket's last finalized round, joined back for its price
 *   dex     the last valid order_matches fill in each bucket, read over the
 *           range's action_index window (fills are sparse beside oracle rounds)
 *
 * One part of src/db/readers/wallet_reads.js; `this` is the Database instance.
 *
 ********************************************************************/

'use strict';

const { resolveBlockWindow, actionWindowTerms, placeholders } = require('./action_window.js');

// The latest finalized timestamp in each bucket comes from one range read over
// the window's rounds, and the join back on (coin_pair, block_timestamp) fetches
// its round. Cost grows with the rounds in the window, not the points served.
// Two rounds sharing that timestamp both come back; the reader keeps the higher id.
function oracleBucketsSql(table, pairCount){
    return `SELECT
                        g.coin_pair,
                        g.t,
                        p.id,
                        p.price,
                        p.block_timestamp
                    FROM (
                        SELECT
                            m.coin_pair,
                            (m.block_timestamp - (m.block_timestamp % ?)) as t,
                            MAX(m.block_timestamp) as last_at
                        FROM ${table} m
                        WHERE m.coin_pair IN (` + placeholders(pairCount) + `)
                            AND m.block_timestamp >= ? AND m.block_timestamp < ?
                            AND m.status='finalized' AND m.price IS NOT NULL
                        GROUP BY m.coin_pair, t
                    ) g
                        INNER JOIN ${table} p ON (p.coin_pair=g.coin_pair AND p.block_timestamp=g.last_at)
                    WHERE p.status='finalized' AND p.price IS NOT NULL
                    ORDER BY g.coin_pair, g.t, p.id`;
}

// One row per pair and bucket: the highest id among rounds tied on the last timestamp.
function lastPerBucket(rows){
    const kept = new Map();
    for(const row of rows || [])
        kept.set(String(row.coin_pair).toLowerCase() + '\u0000' + row.t, row);
    return [...kept.values()];
}

// A fill counts for an asset when one side is the asset and the other the quote,
// labelled COALESCE(ticker, coin) exactly as /market/{TICK1}/{TICK2}/history does.
function dexBucketsSql(assetCount, windowTerms){
    const assets = placeholders(assetCount);
    const where  = [
        `s1.status='valid'`,
        ...windowTerms,
        'b1.block_time >= ? AND b1.block_time < ?',
        `((COALESCE(t1.tick, c1.coin) IN (` + assets + `) AND COALESCE(t2.tick, c2.coin)=?)
                            OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin) IN (` + assets + `)))`
    ];
    return `SELECT
                        g.give_label,
                        g.get_label,
                        g.t,
                        g.fills,
                        g.last_action,
                        g.last_time,
                        om.give_amount,
                        om.get_amount
                    FROM (
                        SELECT
                            COALESCE(t1.tick, c1.coin) as give_label,
                            COALESCE(t2.tick, c2.coin) as get_label,
                            (b1.block_time - (b1.block_time % ?)) as t,
                            COUNT(*) as fills,
                            MAX(m.action_index) as last_action,
                            MAX(b1.block_time) as last_time
                        FROM
                            order_matches m
                            INNER JOIN actions        a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_statuses s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_tickers  t1 ON (t1.id=m.give_tick_id)
                            LEFT  JOIN index_tickers  t2 ON (t2.id=m.get_tick_id)
                            LEFT  JOIN index_coins    c1 ON (c1.id=m.give_coin_id)
                            LEFT  JOIN index_coins    c2 ON (c2.id=m.get_coin_id)
                        WHERE ` + where.join(`
                            AND `) + `
                        GROUP BY give_label, get_label, t
                    ) g
                        INNER JOIN order_matches om ON (om.action_index=g.last_action)
                    ORDER BY g.t`;
}

class PriceHistoryReaders {
    /**
     * The last finalized oracle price per `interval` bucket for each pair, over
     * buckets starting at `start` through `lastStart`. Rows: { coin_pair, t,
     * price, block_timestamp }; a bucket with no round has no row.
     */
    async getOraclePriceBuckets(config, pairs, { start, lastStart, interval }){
        if(!pairs.length) return [];
        const table = this.oracleMirrorSource(config, 'price_snapshots').table;
        const args  = [interval, ...pairs, start, lastStart + interval];
        return lastPerBucket(await this.doQuery(config, oracleBucketsSql(table, pairs.length), args));
    }

    /**
     * The last valid DEX fill per `interval` bucket between each asset and
     * `quote`, both orientations. Rows: { give_label, get_label, t, fills,
     * last_action, last_time, give_amount, get_amount }.
     */
    async getDexPriceBuckets(config, assets, quote, { start, lastStart, interval }){
        if(!assets.length) return [];
        const end    = lastStart + interval;
        const blocks = await resolveBlockWindow(this, config, start, end - 1);
        if(blocks.empty) return [];
        const window = actionWindowTerms('m.action_index', blocks);
        const args   = [interval, ...window.args, start, end, ...assets, quote, quote, ...assets];
        const rows   = await this.doQuery(config, dexBucketsSql(assets.length, window.terms), args);
        return rows || [];
    }
}

module.exports = PriceHistoryReaders.prototype;
