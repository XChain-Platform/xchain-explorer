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
 * XChain Explorer - the per-token rich list
 *
 * One part of src/db/readers/entities.js (the entry composes it through
 * composeReaderParts). The holder ranking for one token and the two pure
 * helpers that turn a page of balance rows into the percentages it shows.
 *
 * The helpers stay with their only caller: they encode which balances count
 * toward circulating supply, which is a property of this ranking and not a
 * general-purpose sum.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// The token row a rich list is a ranking of, or null when the tick was never
// issued. A module function rather than a method: Database.prototype carries the
// family's public readers and nothing else, so a cut made for length adds no name
// to it. Same for the three below.
async function richListToken(db, config, tickId){
    let tokenRow = await db.doQuery(config,
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
    if(!tokenRow || !tokenRow.length) return null;
    return tokenRow[0];
}

// The holder census the shares are measured against: how many addresses hold any
// of the token, and how much they hold between them.
async function richListCensus(db, config, tickId){
    // Holder census. Zero balances are excluded from BOTH the count and the ranking:
    // an address that once held the token and sent it all away is not a holder, and
    // counting it inflates the denominator of every "share of holders" figure a
    // reader might compute. amount is a VARCHAR, so the comparison is on the CAST.
    let census = await db.doQuery(config,
        `SELECT
                count(*) as holder_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as held_total
            FROM balances m
            WHERE m.tick_id=? AND CAST(m.amount AS DECIMAL(65,18)) > 0`, [tickId]);
    let holderCount = (census && census.length) ? Number(census[0].holder_count) : 0;
    let heldTotal   = (census && census.length) ? String(census[0].held_total)   : '0';
    return { holderCount, heldTotal };
}

// One page of holders, largest first, with the offset it was read at: the ranks the
// caller stamps have to start from the same offset the query skipped.
async function richListHolders(db, config, tickId, limit){
    // The page offset is applied to the QUERY as well as to the rank numbers
    // below. Seeding the ranks alone made page 2 return the same top-N addresses
    // relabelled 101..200, which is worse than restarting at 1: it names the
    // largest holder as the 101st. Same OFFSET idiom getData uses for API paging.
    let offset = Number(config.type == 'api' && config.data.sql && db.util.isNumeric(config.data.sql.apiOffset)
        ? Number(config.data.sql.apiOffset) : 0);
    let holders = await db.doQuery(config,
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
    return { holders, offset };
}

// The rich list response body: the token's own supply figures, the census, and the
// two concentration readings a reader actually wants from a ranking.
function richListBody(db, token, parts){
    let { supply, holderCount, heldTotal, ranked } = parts;
    return {
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
            ? db.supplyPercent(db.supplySum(ranked.slice(0, 10)), supply)
            : null,
        holders:         ranked
    };
}

class EntityRichListReaders {
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
        let token = await richListToken(this, config, tickId);
        if(!token) return [null];

        let { holderCount, heldTotal } = await richListCensus(this, config, tickId);
        let { holders, offset } = await richListHolders(this, config, tickId, limit);

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
        return [richListBody(this, token, { supply, holderCount, heldTotal, ranked })];
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

module.exports = EntityRichListReaders.prototype;
