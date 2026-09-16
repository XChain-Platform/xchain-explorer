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
 * XChain Explorer - oracle readers
 *
 * Provides one prototype part composed by src/db/readers/polls_bets.js.
 *
 ********************************************************************/

'use strict';

class OracleReaders {

    // Oracle track record for one address (§11.1). This IS the v0 reputation system:
    // there is no bonding or staking behind it, and the record is PER-ADDRESS, so an
    // oracle can start fresh at any time. Callers MUST surface that caveat; an empty
    // history means unknown, not safe. "Resolved on time" is deliberately absent: a
    // resolve past expire_at is rejected by format 3, so every resolve is in-window
    // by construction and the distinction would be vacuous.
    async getOracleStats(config){
        let args  = [config.data.search];
        let query = `SELECT
                        fs.status as feed_status,
                        count(*)  as feeds
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE a2.address=?
                    GROUP BY fs.status`;
        let rows  = await this.doQuery(config, query, args) || [];
        let counts = { open: 0, closed: 0, resolved: 0, resolved_void: 0, cancelled: 0, expired: 0 };
        let total  = 0;
        for(const r of rows){
            if(r.feed_status in counts) counts[r.feed_status] = Number(r.feeds);
            total += Number(r.feeds);
        }
        // Active = still able to take or settle bets. Kept explicit rather than
        // derived by the caller so the market list and the oracle page agree.
        let active = counts.open + counts.closed;
        let fees   = await this.getOracleFeesEarned(config, config.data.search);
        let price  = await this.getOraclePriceRecord(config, config.data.search);
        return [{ address: config.data.search, total_feeds: total, active_feeds: active,
                  counts, fees_earned: fees, price,
                  reputation_caveat: 'Per-address record with no bonding; addresses are free to create, so an empty history means unknown, not safe.' }];
    }

    // PRICE v1 half of the per-address oracle track record. A price publisher is an
    // oracle too, but its rounds land in the hub-mirrored oracle_prices table, not
    // bet_feeds, so the stats above are blind to it and the page reported an active
    // publisher as all zeros. Aggregated per published pair (COIN/TICK/FIAT) with
    // the round counts and publish window; the individual rounds are served by
    // getOraclePrices. Returns null (a "cannot know", distinct from the zero-pair
    // record {total_publishes:0, pairs:[]}) when this node has no co-located hub DB:
    // oracle_prices is mirror-only and the betting record must still answer.
    async getOraclePriceRecord(config, address){
        let src = null;
        try {
            src = this.oracleMirrorSource(config, 'oracle_prices');
        } catch(e) {
            return null;
        }
        let rows = await this.doQuery(config,
            `SELECT
                m.coin,
                m.tick,
                m.fiat,
                count(*) as publishes,
                MIN(m.block_time) as first_publish,
                MAX(m.block_time) as last_publish
            FROM
                ${src.table} m
            WHERE
                m.source_address=?
            GROUP BY m.coin, m.tick, m.fiat
            ORDER BY last_publish DESC`, [address]) || [];
        let record = { total_publishes: 0, pairs: [] };
        for(const r of rows){
            // Counts and epoch times can arrive as BigInt; normalize so the JSON is
            // plain numbers (values are far below 2^53).
            let publishes = Number(r.publishes);
            record.total_publishes += publishes;
            record.pairs.push({
                coin: r.coin, tick: r.tick, fiat: r.fiat, publishes,
                first_publish: this.util.isNull(r.first_publish) ? null : Number(r.first_publish),
                last_publish:  this.util.isNull(r.last_publish)  ? null : Number(r.last_publish)
            });
        }
        return record;
    }

    // What an oracle has actually EARNED, per wager token (§11.1's "fees earned").
    //
    // The earning event is one ledger row and only one: settlement credits the feed
    // source a single amount carrying the FEE percent of the pot PLUS the rounding
    // dust (bet.js, §7), and only on the resolve path - a void, a cancel and an
    // expiry all pay the oracle nothing. So the sum is over `credits` rows attached
    // to a BET resolve action.
    //
    // The identity test is what makes it exact, and it is not decoration: a WINNING
    // BETTOR's payout is also a credit inside that same resolve action, so filtering
    // on the credited address alone would report other people's winnings as this
    // address's fee income the moment it ever bet on someone else's market. Requiring
    // the credited address to BE the address that submitted the resolve excludes them,
    // because format 3 is owner-only and format 2 rejects a bet from the feed source,
    // so within one resolve the oracle is credited exactly once and never as a bettor.
    async getOracleFeesEarned(config, address){
        let query = `SELECT
                        tk.tick,
                        count(*) as resolves,
                        SUM(CAST(c.amount AS DECIMAL(65,18))) as amount
                    FROM
                        credits c
                        INNER JOIN bet_resolves    br ON (br.action_index=c.action_index)
                        INNER JOIN actions         a1 ON (a1.action_index=br.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses ra ON (ra.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses ca ON (ca.id=c.address_id)
                        LEFT  JOIN index_tickers   tk ON (tk.id=c.tick_id)
                    WHERE ca.address=? AND ra.address=?
                    GROUP BY tk.tick
                    ORDER BY tk.tick ASC`;
        let rows = await this.doQuery(config, query, [address, address]) || [];
        // DECIMAL(65,18) sums arrive with an 18-place tail whatever the token's own
        // DECIMALS, so trim it here rather than in each renderer. Display only: no
        // consensus path reads this method.
        return rows.map(r => ({ tick: r.tick, resolves: Number(r.resolves),
                                amount: this.trimAmountTail(r.amount) }));
    }

    // Strip the zero tail a DECIMAL sum leaves behind ('0.175000000000000000' ->
    // '0.175'), leaving a whole number bare ('12.000...' -> '12'). Never touches a
    // significant digit, and returns non-numeric input unchanged.
    trimAmountTail(value){
        if(this.util.isNull(value)) return '0';
        let s = String(value);
        if(!/^-?\d+\.\d+$/.test(s)) return s;
        return s.replace(/0+$/, '').replace(/\.$/, '');
    }
}

module.exports = OracleReaders.prototype;
