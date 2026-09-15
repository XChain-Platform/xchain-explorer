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
 * XChain Explorer - the composed address staking panel
 *
 * getAddressStaking answers, for one address, what is staked, what is cooling
 * down and when it matures, what is claimable, and what has been slashed. The
 * COLLECT trail behind "claimable" is here too; the validator page calls the
 * same method, so the two can never disagree.
 *
 * One part of src/db/readers/staking_governance.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// What this address has staked, on both ledgers: contract_stakes (targeted at one
// contract) and stakes (the consensus capability ledger).
async function addressPositionSections(db, config, address, limit){
    let positions = await db.doQuery(config,
        `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

    let capabilityPositions = await db.doQuery(config,
        `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);
    return { positions, capabilityPositions };
}

// What is cooling down on both ledgers, with maturity measured against the
// indexer tip so every explorer host answers identically.
async function addressCooldownSections(db, config, address, limit, tip){
    let cooldowns = await db.doQuery(config,
        `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

    let capabilityCooldowns = await db.doQuery(config,
        `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

    for(let row of [...(cooldowns || []), ...(capabilityCooldowns || [])]){
        let end = Number(row.cooldown_end_block);
        row.blocks_remaining = Math.max(0, end - tip);
        row.matured          = tip >= end;
    }
    return { cooldowns, capabilityCooldowns };
}

// The reward accruals behind the claimable figure, newest first.
async function addressRewardRows(db, config, address, limit){
    let rewards = await db.doQuery(config,
        `SELECT
                m.id,
                a3.pubkey as signing_pubkey,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a2.address=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);
    return rewards;
}

// Slash exposure, reached through the pubkeys this address staked with: each family
// is scoped by the ledger it actually burns from, never by one ledger for both.
async function addressSlashSections(db, config, address, limit){
    // Row shape matches getCapabilitySlashEvents and the validator page's slash
    // leg (slashed key + submitter + destination), so the same slash reads
    // identically wherever it surfaces.
    let capabilitySlashes = await db.doQuery(config,
        `SELECT
                m.id,
                m.slash_action_index,
                pk.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT s.signing_pubkey_id FROM stakes s
                    INNER JOIN index_addresses sa ON (sa.id=s.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

    let contractSlashes = await db.doQuery(config,
        `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                pk.pubkey as slashed_pubkey,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT cs.signing_pubkey_id FROM contract_stakes cs
                    INNER JOIN index_addresses sa ON (sa.id=cs.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);
    return { capabilitySlashes, contractSlashes };
}

class AddressStakingReaders {
    // Composed ADDRESS STAKING panel (M4.6). One address, four questions the raw tabs below
    // it cannot answer together: what is staked, what is cooling down and when it matures,
    // what is claimable, and what has been slashed out from under it.
    //
    // Maturity is computed against the indexer's own tip (getMaxBlockIndex), not wall clock,
    // so every explorer host answers identically and the number matches the consensus rule
    // that releases the funds.
    //
    // Slash exposure has to reach the address through the KEYS it staked with, because
    // neither slash table carries an address of the slashed party: capability_slash_events
    // and slash_events both name a signing pubkey. So each family is scoped by the pubkey set
    // this address staked, drawn from the ledger that family actually burns from (`stakes`
    // for the capability family, `contract_stakes` for the contract family). Scoping both
    // from one ledger would over- or under-report, depending which one was picked.
    async getAddressStaking(config){
        let limit   = this.detailLimit(config);
        let address = config.data.search;
        if(this.util.isNull(address)) return [null];
        let tip = await this.getMaxBlockIndex(config);

        let { positions, capabilityPositions } = await addressPositionSections(this, config, address, limit);

        let { cooldowns, capabilityCooldowns } = await addressCooldownSections(this, config, address, limit, tip);

        let trail = await this.collectTrail(config, address, limit);
        let rewards = await addressRewardRows(this, config, address, limit);

        let { capabilitySlashes, contractSlashes } = await addressSlashSections(this, config, address, limit);

        return [{
            address:              address,
            chain_tip:            tip,
            positions:            positions           || [],
            capability_positions: capabilityPositions || [],
            cooldowns:            cooldowns           || [],
            capability_cooldowns: capabilityCooldowns || [],
            rewards:              rewards             || [],
            rewards_total:        trail.rewards_total,
            collected_total:      trail.collected_total,
            claimable:            trail.claimable,
            collects:             trail.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || []
        }];
    }

    // The COLLECT trail for ONE staking address, shared by the validator page and the
    // address staking panel so the two can never disagree about what "claimable" means.
    // Accrual (validator_rewards) minus claims (reward_claims), both summed in SQL over an
    // indexed source_id lookup rather than over a fetched page, because a page-local sum
    // would silently under-report the moment a validator has more rows than one page.
    //
    // Reward accounting is per-ADDRESS, not per-pubkey: validator_rewards accrues to
    // (source_id, signing_pubkey_id) but reward_claims (the COLLECT trail) carries only
    // source_id, so a claimable figure can only be stated for the staking address. Both
    // totals are returned alongside the difference rather than the difference alone, because
    // a negative remainder means ledger drift and has to stay visible instead of clamping.
    async collectTrail(config, source, limit){
        let accrued = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM validator_rewards m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
             WHERE a2.address=?`, [source]);
        let claimed = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM reward_claims m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
             WHERE s1.status='valid' AND a2.address=?`, [source]);
        let collects = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                reward_claims m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [source]);
        // One wire type for all three figures: a fixed-8 decimal STRING, matching how
        // every other XCHAIN amount is serialized. The SQL sums come back at the CAST's
        // 18 decimal places and bcsub returns a mathjs bignumber OBJECT, so both are
        // formatted rather than passed through; an unformatted bignumber serializes as a
        // mathjs envelope, not as a number a page can print.
        let accruedTotal = (accrued && accrued.length) ? accrued[0].total : 0;
        let claimedTotal = (claimed && claimed.length) ? claimed[0].total : 0;
        return {
            rewards_total:   this.util.bcformat(accruedTotal, 8),
            collected_total: this.util.bcformat(claimedTotal, 8),
            claimable:       this.util.bcformat(this.util.bcsub(accruedTotal, claimedTotal, 8), 8),
            collects:        collects || []
        };
    }
}

module.exports = AddressStakingReaders.prototype;
