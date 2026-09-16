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
 * XChain Explorer - the composed validator detail page
 *
 * getValidator resolves a pubkey or staking address to one validator and
 * composes every section its page shows. The COLLECT trail it shares with the
 * address staking panel lives in address_staking.js, and the per-pubkey
 * capability rows beside the capability list in validators.js.
 *
 * One part of src/db/readers/staking_governance.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// Resolve the page QUERY (a signing pubkey or a staking address) to the one
// validator it names, in two unique point reads and then one indexed lookup on
// stakes. Returns null when the name exists nowhere on this chain, which the
// caller answers with an empty page rather than an error.
async function resolveValidatorIdentity(db, config, search){
    let pubkeyRow  = await db.doQuery(config,
        'SELECT id FROM index_pubkeys WHERE pubkey=? LIMIT 1', [search]);
    let addressRow = await db.doQuery(config,
        'SELECT id FROM index_addresses WHERE address=? LIMIT 1', [search]);
    let pubkeyId  = (pubkeyRow  && pubkeyRow.length)  ? Number(pubkeyRow[0].id)  : null;
    let addressId = (addressRow && addressRow.length) ? Number(addressRow[0].id) : null;
    // Neither name exists anywhere on this chain: answer without touching `stakes`.
    if(pubkeyId === null && addressId === null)
        return null;
    // Only the resolved side is bound, so a QUERY that is unambiguously one form
    // never carries a dead placeholder against the other column's index.
    let idClauses = [];
    let idArgs    = [];
    if(pubkeyId !== null){  idClauses.push('m.signing_pubkey_id=?'); idArgs.push(pubkeyId);  }
    if(addressId !== null){ idClauses.push('m.source_id=?');         idArgs.push(addressId); }
    // Identity spine. status='valid' matches getValidators' own active-set rule, so the
    // page cannot resolve an identity off a rejected STAKE.
    let identity = await db.doQuery(config,
        `SELECT
                a3.pubkey  as signing_pubkey,
                a2.address as source,
                m.action_index as stake_action_index,
                m.version,
                m.activation_block,
                m.deactivation_block,
                m.block_index
            FROM
                stakes m
                LEFT JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND (` + idClauses.join(' OR ') + `)
            ORDER BY m.action_index DESC
            LIMIT 1`, idArgs);
    if(!identity || !identity.length)
        return null;
    return identity[0];
}

// The stake spine of the page: the active-stake aggregate and the STAKE and
// UNSTAKE position lists, all keyed by the resolved signing pubkey.
async function validatorStakeSections(db, config, pubkey, limit){
    // Active stake: an aggregate over ONE pubkey's rows (signing_pubkey_id is indexed),
    // never a GROUP BY across validators. deactivation_block IS NULL is what "still
    // active" means on this ledger; a superseded row carries the height it stopped at.
    let totals = await db.doQuery(config,
        `SELECT
                count(*) as position_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as active_stake
            FROM
                stakes m
                LEFT JOIN index_pubkeys  a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND a3.pubkey=? AND m.deactivation_block IS NULL`, [pubkey]);

    let stakes = await db.doQuery(config,
        `SELECT
                m.action_index,
                m.version,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

    let unstakes = await db.doQuery(config,
        `SELECT
                m.action_index,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);
    return { totals, stakes, unstakes };
}

// The delegation history: delegations made to this key, and the revocations that ended them.
async function validatorDelegationSections(db, config, pubkey, limit){
    let delegations = await db.doQuery(config,
        `SELECT
                m.action_index,
                a2.address as source,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                delegations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

    // Key revocations belong with the delegation history rather than in a section of
    // their own: a DELEGATE v2/v3 revocation is the event that ENDS a delegated key's
    // validity, and reading it apart from the delegation it ends inverts the meaning.
    let revocations = await db.doQuery(config,
        `SELECT
                m.action_index,
                a2.address as source,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stake_key_revocations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);
    return { delegations, revocations };
}

// Key rotations naming this key on either side, and the reward accrual rows
// behind the claimable figure collectTrail reconciles.
async function validatorRotationAndRewardRows(db, config, pubkey, limit){
    // Rotations name BOTH the key they replaced and the key they installed, so this key
    // is on either side of the pair and both are matched. See the frontier note: neither
    // pubkey column is indexed on contract_delegation_rotations today.
    let rotations = await db.doQuery(config,
        `SELECT
                m.id,
                m.target_table,
                m.delegation_action_index,
                m.stake_action_index,
                pp.pubkey as prev_signing_pubkey,
                np.pubkey as new_signing_pubkey,
                m.block_index,
                b1.block_time as timestamp
            FROM
                contract_delegation_rotations m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys pp ON (pp.id=m.prev_signing_pubkey_id)
                LEFT  JOIN index_pubkeys np ON (np.id=m.new_signing_pubkey_id)
            WHERE (pp.pubkey=? OR np.pubkey=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey, pubkey]);

    let rewards = await db.doQuery(config,
        `SELECT
                m.id,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                m.derive_block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
    return { rotations, rewards };
}

// Both slash families: either one alone understates what this validator had burned.
async function validatorSlashSections(db, config, pubkey, limit){
    // Both slash families. capability_slash_events is the equivocation bond-burn against
    // a CONSENSUS validator (keyed by the signing pubkey directly); slash_events is the
    // contract-stake burn emitted by an EXECUTE (also keyed by the staker's pubkey). One
    // family alone understates exposure, which is why the page carries both. The row
    // shape matches getCapabilitySlashEvents and the address staking panel (slashed
    // key + submitter + destination), so the same slash reads identically wherever
    // it surfaces.
    let capabilitySlashes = await db.doQuery(config,
        `SELECT
                m.id,
                m.slash_action_index,
                a3.pubkey as slashed_pubkey,
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
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

    let contractSlashes = await db.doQuery(config,
        `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
    return { capabilitySlashes, contractSlashes };
}

// The two quality legs: full-node verification challenges and per-provider attestation stats.
async function validatorAttestationSections(db, config, pubkey, limit){
    let nodeproofs = await db.doQuery(config,
        `SELECT
                m.id,
                m.action_index,
                m.challenge_id,
                m.epoch_height,
                m.target_height,
                a3.address as staking_source,
                m.passed,
                m.block_index,
                b1.block_time as timestamp
            FROM
                full_node_verifications m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses a3 ON (a3.id=m.source_id)
            WHERE pk.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

    // Attestation quality is keyed by the RAW pubkey string (attest_validator_stats has
    // no index_pubkeys id), one row per provider the validator serves.
    let attestationQuality = await db.doQuery(config,
        `SELECT
                m.id,
                m.validator_pubkey,
                m.provider_id,
                m.fulfilled_count,
                m.missed_count,
                m.slashed_count,
                m.quality_score,
                m.last_updated_block
            FROM
                attest_validator_stats m
            WHERE m.validator_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
    return { nodeproofs, attestationQuality };
}

class ValidatorDetailReaders {
    // Composed VALIDATOR detail (M4.1). QUERY is EITHER the Ed25519 signing pubkey or the
    // staking address: both name the same validator in circulation (/validators renders both
    // columns, a hub registry entry is keyed by pubkey, a reward accrual and its COLLECT are
    // keyed by address), so the page answers to either without the caller having to say
    // which it holds.
    //
    // The QUERY is resolved to IDs FIRST, in two unique point reads, and only then does the
    // spine touch `stakes`. The obvious one-query form (`WHERE a3.pubkey=? OR a2.address=?`
    // over the joined aliases) reads correctly and scans the whole stakes table: an OR
    // spanning two different joined tables leaves the optimizer no driving table but `stakes`
    // itself. Resolving first puts the OR on two INDEXED columns of `stakes`
    // (signing_pubkey_id, source_id), which index-merges. The single-predicate list legs
    // below keep the joined-alias form: one null-rejecting equality lets the optimizer
    // convert the LEFT JOIN and drive from the unique index, which an OR does not.
    //
    // Reward accounting is per-ADDRESS, not per-pubkey, which is why the claimable figure
    // comes from collectTrail (address_staking.js) and carries that rule's comment.
    //
    // The capability leg is validatorCapabilityRows, which lives beside the list-view
    // reader it degrades with (validators.js) and carries that rule's comment.
    async getValidator(config){
        let limit  = this.detailLimit(config);
        let search = config.data.search;
        let row = await resolveValidatorIdentity(this, config, search);
        if(!row)
            return [null];
        let pubkey = row.signing_pubkey;
        let source = row.source;

        let { totals, stakes, unstakes } = await validatorStakeSections(this, config, pubkey, limit);

        let { delegations, revocations } = await validatorDelegationSections(this, config, pubkey, limit);

        let { rotations, rewards } = await validatorRotationAndRewardRows(this, config, pubkey, limit);

        let claimable = await this.collectTrail(config, source, limit);

        let { capabilitySlashes, contractSlashes } = await validatorSlashSections(this, config, pubkey, limit);

        let { nodeproofs, attestationQuality } = await validatorAttestationSections(this, config, pubkey, limit);

        let capabilities = await this.validatorCapabilityRows(config, pubkey, limit);

        // The hub registry decorates, never gates: getFederationRegistry returns null when
        // no registry is reachable at all, and null means UNKNOWN, not "unregistered".
        let registry = await this.getFederationRegistry(config);
        let entry    = (registry && pubkey) ? registry[String(pubkey).toLowerCase()] : null;

        return [{
            query:              search,
            signing_pubkey:     pubkey,
            source:             source,
            stake_action_index: row.stake_action_index,
            version:            row.version,
            activation_block:   row.activation_block,
            deactivation_block: row.deactivation_block,
            block_index:        row.block_index,
            registry:           (entry) ? entry : null,
            registry_known:     (registry !== null),
            active_stake:       this.util.bcformat((totals && totals.length) ? totals[0].active_stake : 0, 8),
            position_count:     (totals && totals.length) ? Number(totals[0].position_count) : 0,
            capabilities:       capabilities,
            stakes:             stakes      || [],
            unstakes:           unstakes    || [],
            delegations:        delegations || [],
            revocations:        revocations || [],
            rotations:          rotations   || [],
            rewards:            rewards     || [],
            rewards_total:      claimable.rewards_total,
            collected_total:    claimable.collected_total,
            claimable:          claimable.claimable,
            collects:           claimable.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || [],
            nodeproofs:              nodeproofs        || [],
            attestation_quality:     attestationQuality || []
        }];
    }
}

module.exports = ValidatorDetailReaders.prototype;
