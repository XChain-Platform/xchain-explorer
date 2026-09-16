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
 * XChain Explorer - contract stake and vote delegation lists
 *
 * The contract-targeted staking ledger (contract_stakes, contract_unstakes,
 * contract_delegations) and the VOTE v3 per-token delegation log. Kept apart
 * from the capability stake lists because they read a different ledger with
 * its own target contract and tick columns.
 *
 * One part of src/db/readers/staking_governance.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

class ContractStakeReaders {
    async getContractStakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.version,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getContractUnstakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.cooldown_end_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of CONTRACT DELEGATION actions (DELEGATE v1/v3, type in {address, block, contract}).
    // Mirrors getContractStakes; contract_delegations carries no amount/version; the delegation
    // re-points a stake's signing pubkey, with activation/deactivation block bounds.
    async getContractDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of VOTE v3 delegation rows (liquid democracy, type in {tick, delegator,
    // delegate, block}). vote_delegations is an APPEND-ONLY event log: a holder can set,
    // re-point, or clear (revoke) their standing per-token delegation, and every one of
    // those actions writes a NEW row rather than mutating the old one, so a naive
    // SELECT * shows every revoked/superseded delegation as if it were still live.
    //
    // The live delegation for a (tick_id, delegator) is its LATEST row (highest
    // action_index), and only if that latest row is not a CLEAR (delegate_address_id IS
    // NOT NULL). This mirrors xchain-indexer's Database#getActiveDelegations (which feeds
    // getPollTally) exactly, minus its `block_index <= ?` bound: that bound answers "what
    // was live AT some past height", which a poll close needs; this list answers "what is
    // live now", so the bound is simply omitted. Every TYPE narrows WHICH keys are shown,
    // never what "live" means.
    //
    // Implemented as a correlated MAX on the (tick_id, delegator_address_id) key, in the
    // outer WHERE where the paging cursor also lives - never a GROUP BY over a "newest N
    // rows" derived table, which is the defect class that a cursor applied OUTSIDE the
    // window silently truncates.
    async getVoteDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        t3.tick,
                        dgr.address as delegator,
                        dg.address as delegate,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2  ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4  ON (a4.id=a1.action_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }
}

module.exports = ContractStakeReaders.prototype;
