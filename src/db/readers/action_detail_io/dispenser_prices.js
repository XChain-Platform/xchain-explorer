/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Explorer - dispenser price-source availability
 *
 * Provides the batched price freshness flag shared by dispenser detail and
 * list API rows.
 *
 ********************************************************************/

'use strict';

const PRICE_WINDOW_SECONDS = 86400;

function snapshotSql(table, pairCount){
    const placeholders = new Array(pairCount).fill('?').join(',');
    return `SELECT
                m.coin_pair,
                m.price,
                m.block_timestamp
            FROM
                ${table} m
            WHERE
                m.coin_pair IN (${placeholders}) AND
                m.status='finalized' AND
                m.price IS NOT NULL AND
                m.block_timestamp BETWEEN ? AND ?
            ORDER BY m.block_timestamp DESC, m.round_number DESC`;
}

function oracleSql(table, rows){
    const clauses = rows.map(() => '(m.source_address=? AND m.coin=? AND m.tick=? AND m.fiat=?)');
    return `SELECT
                m.source_address,
                m.coin,
                m.tick,
                m.fiat,
                m.value,
                m.effective_at
            FROM
                ${table} m
            WHERE
                m.effective_at BETWEEN ? AND ? AND
                (${clauses.join(' OR ')})
            ORDER BY m.effective_at DESC, m.action_index DESC`;
}

function lifecycleStatus(db, row){
    if(!db.util.isNull(row.current_status)) return String(row.current_status);
    if(row.state && !db.util.isNull(row.state.status)) return String(row.state.status);
    return null;
}

function checksPrice(db, row){
    return String(row.status) === 'valid' && lifecycleStatus(db, row) === 'open'
        && !db.util.isNull(row.fiat_code);
}

function pairFor(row){
    return String(row.get_coin) + '/' + String(row.fiat_code);
}

function oracleKey(row){
    return JSON.stringify([row.source_address || row.oracle_address, row.coin || row.give_coin,
        row.tick || row.give_tick, row.fiat || row.fiat_code]);
}

function groupRows(rows, keyFn){
    const grouped = new Map();
    for(const row of (rows || [])){
        const key = keyFn(row);
        if(!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    }
    return grouped;
}

function hasUsablePrice(db, row, snapshots, oraclePrices, tip){
    const pairRows = snapshots.get(pairFor(row)) || [];
    if(db.util.isNull(row.oracle_address)){
        return pairRows.some((price) => {
            const at = Number(price.block_timestamp);
            return Number.isFinite(at) && at >= tip - PRICE_WINDOW_SECONDS && at <= tip;
        });
    }
    const candidates = oraclePrices.get(oracleKey(row)) || [];
    return candidates.some((oracle) => {
        const effectiveAt = Number(oracle.effective_at);
        if(!Number.isFinite(effectiveAt) || effectiveAt < tip - PRICE_WINDOW_SECONDS || effectiveAt > tip)
            return false;
        return pairRows.some((price) => {
            const at = Number(price.block_timestamp);
            return Number.isFinite(at) && at >= effectiveAt - PRICE_WINDOW_SECONDS && at <= effectiveAt;
        });
    });
}

class DispenserPriceReaders {
    // Report whether each dispenser lacks the price inputs settlement accepts at
    // the current indexed tip. Non-fiat and non-open rows always report false.
    async getDispenserPriceStaleBatch(config, rows){
        const result = {};
        for(const row of (rows || [])) result[String(row.action_index)] = false;
        const eligible = (rows || []).filter((row) => checksPrice(this, row));
        if(!eligible.length) return result;
        const tip = Number(await this.getMaxBlockTime(config));
        if(!Number.isFinite(tip) || tip <= 0){
            for(const row of eligible) result[String(row.action_index)] = true;
            return result;
        }
        const pairs = [...new Set(eligible.map(pairFor))];
        const snapshotTable = this.oracleMirrorSource(config, 'price_snapshots').table;
        const snapshotArgs = [...pairs, tip - (2 * PRICE_WINDOW_SECONDS), tip];
        const snapshotRows = await this.doQuery(config, snapshotSql(snapshotTable, pairs.length), snapshotArgs) || [];
        const snapshots = groupRows(snapshotRows, (row) => String(row.coin_pair));
        const modeB = eligible.filter((row) => !this.util.isNull(row.oracle_address));
        let oraclePrices = new Map();
        if(modeB.length){
            const unique = [...new Map(modeB.map((row) => [oracleKey(row), row])).values()];
            const oracleTable = this.oracleMirrorSource(config, 'oracle_prices').table;
            const oracleArgs = [tip - PRICE_WINDOW_SECONDS, tip];
            for(const row of unique)
                oracleArgs.push(row.oracle_address, row.give_coin, row.give_tick, row.fiat_code);
            const oracleRows = await this.doQuery(config, oracleSql(oracleTable, unique), oracleArgs) || [];
            oraclePrices = groupRows(oracleRows, oracleKey);
        }
        for(const row of eligible)
            result[String(row.action_index)] = !hasUsablePrice(this, row, snapshots, oraclePrices, tip);
        return result;
    }
}

module.exports = DispenserPriceReaders.prototype;
