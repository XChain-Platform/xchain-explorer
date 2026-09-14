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
 * Additional unit tests for uncovered methods in src/db/index.js
 *
 * Covers (SQL-builder methods, return [query, args, count]):
 *   - getCoinpays, getCoinpayExpires, getCoinpayObligations
 *   - getMarkets, getMarket, getMarketOrders, getMarketHistory, getOrderbook
 *   - getActions, getAction, getBlocks
 *   - getSearch
 *   - getPublicKey, getTransactionData
 *   - getContracts, getContract, getContractState, getContractBalance
 *   - getExecutions, getExecution, getDeposits, getWithdrawals
 *   - getStakes, getValidators, getPrices, getPriceSnapshots, getDelegations
 *   - getValidatorRewards, getContractStakes, getContractUnstakes, getSlashEvents
 *   - getHistory
 *
 * Covers (helper/detail methods, stub doQuery):
 *   - getMaxBlockIndex, getMaxBlockTime, getMaxActionIndex
 *   - getGatedFileRaw, getBlocksSince, getActionsSince
 *   - getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo
 *   - getCoinpayObligation, getOrderMatchSettlement
 *   - getPublicKey, getTransactionData
 *   - getActionFeeData
 *   - getHistoryData (basic)
 *   - getActionSummaryData (basic pass-through)
 *
 * Covers (LRU cache helpers):
 *   - cacheGet, cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

const {
    configInfo,
    sinon,
    expect,
    makeConfig,
    mockResults,
    makeDb,
    cfg,
    makeActionConfig,
    baseRow,
    stubForType
} = require('./helpers.js');

describe('Database#getUnstakes', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getUnstakes(makeActionConfig('getUnstakes'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "unstakes" with amount + cooldown, ordered by m.action_index', async () => {
        const db = makeDb();
        const [query] = await db.getUnstakes(makeActionConfig('getUnstakes'));
        expect(query).to.include('unstakes m');
        expect(query).to.include('m.amount');
        expect(query).to.include('m.cooldown_end_block');
        expect(query).to.include('ORDER BY m.action_index');
    });

    // A ROLLCALL eviction writes an unstakes row with tx_index NULL (the indexer,
    // not a holder, wrote it - no broadcast transaction exists behind it). Joining
    // blocks off t1.block_index (a transaction that will never exist for this row)
    // drops the row from an INNER join it can never satisfy; a1.block_index is
    // NOT NULL on every action, synthetic or not, so that join stays INNER while
    // transactions degrades to LEFT so a NULL t1 keeps the row instead of erasing it.
    it('joins blocks off a1.block_index (INNER) and transactions off a1.tx_index (LEFT), in both the rows and count queries', async () => {
        const db = makeDb();
        const [query, , count] = await db.getUnstakes(makeActionConfig('getUnstakes'));
        for(const q of [query, count]){
            expect(q).to.include('INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)');
            expect(q).to.include('LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            // The pre-fix shape joined transactions INNER off a1.tx_index and then
            // chained blocks off t1.block_index; a synthetic row with tx_index NULL
            // satisfies neither and vanishes. Guard against that pattern coming back.
            expect(q).to.not.include('INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            expect(q).to.not.include('b1.block_index=t1.block_index');
        }
    });
});

// DELEGATE v2/v3 key revoke.
describe('Database#getStakeKeyRevocations', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getStakeKeyRevocations(makeActionConfig('getStakeKeyRevocations'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "stake_key_revocations" with the revoked key + deactivation block', async () => {
        const db = makeDb();
        const [query] = await db.getStakeKeyRevocations(makeActionConfig('getStakeKeyRevocations'));
        expect(query).to.include('stake_key_revocations m');
        expect(query).to.include('a3.pubkey as signing_pubkey');
        expect(query).to.include('m.deactivation_block');
    });
});

// COLLECT validator reward claim.
describe('Database#getCollects', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCollects(makeActionConfig('getCollects'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "reward_claims" with the claimed amount', async () => {
        const db = makeDb();
        const [query] = await db.getCollects(makeActionConfig('getCollects'));
        expect(query).to.include('reward_claims m');
        expect(query).to.include('m.amount');
        expect(query).to.include('ORDER BY m.action_index');
    });
});

// SLASH equivocation bond-burn, id-keyed.
describe('Database#getCapabilitySlashEvents', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCapabilitySlashEvents(makeActionConfig('getCapabilitySlashEvents', 'pubkey'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "capability_slash_events" with slash_action_index, ordered by m.id', async () => {
        const db = makeDb();
        const [query] = await db.getCapabilitySlashEvents(makeActionConfig('getCapabilitySlashEvents', 'pubkey'));
        expect(query).to.include('capability_slash_events m');
        expect(query).to.include('m.slash_action_index');
        expect(query).to.include('m.capability');
        expect(query).to.include('ORDER BY m.id');
    });
});

// User PRICE v1, hub-mirrored, id-keyed.
describe('Database#getOraclePrices', () => {
    // oracle_prices is hub-mirrored, same posture as price_snapshots and
    // cross_chain_matches: served only from the mandatory co-located hub DB.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query reads "oracle_prices" with tick/fiat/value, ordered by m.id', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(query).to.include('oracle_prices m');
        expect(query).to.include('m.tick');
        expect(query).to.include('m.fiat');
        expect(query).to.include('m.value');
        expect(query).to.include('ORDER BY m.id');
    });

    it('checkpoint hub DB configured -> database-qualifies oracle_prices (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token'));
        expect(query).to.include('`XChain_Hub`.oracle_prices m');
        expect(count).to.include('`XChain_Hub`.oracle_prices m');
    });

    it('no checkpoint hub DB -> fails loud (no silent empty local mirror)', async () => {
        const db = makeDb();
        let err = null;
        try { await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.include('oracle_prices');
    });

    it('rejects an unsafe hub DB identifier by failing loud', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getOraclePrices(makeActionConfig('getOraclePrices', 'token')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getCrossChainMatches', () => {
    // cross_chain_matches is hub-mirrored and served only from the mandatory co-located
    // hub DB. These structural tests configure that hub DB so the query builds;
    // the "no hub DB → fail loud" behavior is covered by its own test below.
    const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

    it('returns a 3-element array', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query selects both legs and the quorum proof from "cross_chain_matches"', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('cross_chain_matches m');
        expect(query).to.include('m.match_id');
        expect(query).to.include('m.a_action_index');
        expect(query).to.include('m.b_action_index');
        expect(query).to.include('m.validator_signatures');
        expect(query).to.include('m.snapshot_block');
    });

    it('ORDER BY uses m.id (mirror cursor, no action_index)', async () => {
        const db = makeDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('ORDER BY m.id');
    });

    it('no checkpoint hub DB → fails loud (no silent local-mirror fallback)', async () => {
        const db = makeDb();
        // checkpointDb is empty by default. The hub-mirrored cross_chain_matches table is
        // never replicated by xchain-sync, so a serving node MUST read it from the co-located
        // hub DB. Without one, getCrossChainMatches throws instead of serving stale local rows.
        let err = null;
        try { await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('checkpoint hub DB configured → database-qualifies to the hub table + network filter (count + data)', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        const [query, args, count] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches'));
        expect(query).to.include('`XChain_Hub`.cross_chain_matches m');
        expect(query).to.include('m.network = ?');
        expect(count).to.include('`XChain_Hub`.cross_chain_matches m');
        expect(count).to.include('m.network = ?');
        // type defaults to 'address' (no type filter `?`), so args = [network] only.
        expect(args).to.deep.equal(['mainnet']);
    });
});

describe('Database#getCrossChainMatches', () => {
    it('redirect with a type filter → args order is [search, network]', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        // type='status' adds one `?` (m.status=?) to sql.where.data, bound to config.data.search,
        // so the network `?` must bind AFTER it.
        const [, args] = await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches', 'status'));
        expect(args).to.deep.equal(['addr1', 'mainnet']);
    });

    it('rejects an unsafe hub DB identifier by failing loud (no local-mirror fallback)', async () => {
        const db = makeDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        // An unsafe configured identifier is a misconfiguration, not a reason to silently
        // serve the stale local mirror: throw rather than fall back.
        let err = null;
        try { await db.getCrossChainMatches(makeActionConfig('getCrossChainMatches')); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });
});

describe('Database#getCrossChainSettlements', () => {
    it('returns a 3-element array', async () => {
        const db = makeDb();
        const result = await db.getCrossChainSettlements(makeActionConfig('getCrossChainSettlements'));
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "cross_chain_settlements" joined to blocks for the timestamp', async () => {
        const db = makeDb();
        const [query] = await db.getCrossChainSettlements(makeActionConfig('getCrossChainSettlements'));
        expect(query).to.include('cross_chain_settlements m');
        expect(query).to.include('m.match_id');
        expect(query).to.include('m.local_action_index');
        expect(query).to.include('b1.block_time as timestamp');
    });
});
