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
 * SQL text for the detail handlers of the staking family: STAKE, UNSTAKE,
 * DELEGATE, COLLECT and SLASH. Each constant is one whole statement that
 * src/action-detail/staking.js hands to action_detail_io.js or runs
 * itself; the action-detail golden pins every one.
 ********************************************************************/

'use strict';

// Read one COLLECT reward claim.
const COLLECT_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    m.action_index,
                    a3.address as source,
                    m.amount,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    s1.status
                FROM
                    reward_claims m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                WHERE
                    m.action_index=?
                LIMIT 1`;

// Read one DELEGATE across the capability, contract and stake-key revocation tables.
const DELEGATE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                    cd.target_contract_index,
                    tk.tick,
                    COALESCE(d.activation_block, cd.activation_block) as activation_block,
                    COALESCE(d.deactivation_block, cd.deactivation_block) as deactivation_block,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    t1.data as wire_data,
                    COALESCE(ds.status, cds.status) as status,
                    pk3.pubkey as revoked_pubkey,
                    skr.deactivation_block as revocation_deactivation_block
                FROM
                    actions a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN delegations        d  ON (d.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=d.signing_pubkey_id)
                    LEFT  JOIN index_statuses     ds ON (ds.id=d.status_id)
                    LEFT  JOIN contract_delegations cd ON (cd.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cd.signing_pubkey_id)
                    LEFT  JOIN index_tickers      tk ON (tk.id=cd.tick_id)
                    LEFT  JOIN index_statuses     cds ON (cds.id=cd.status_id)
                    LEFT  JOIN stake_key_revocations skr ON (skr.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk3 ON (pk3.id=skr.signing_pubkey_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

// Find the newest contract delegation a v3 revoke targeted, by source, key, contract and tick.
const DELEGATE_CONTRACT_REVOKE_PARENT = `SELECT cd.activation_block, cd.deactivation_block, cds.status
                           FROM contract_delegations cd
                           INNER JOIN index_addresses a  ON (a.id=cd.source_id)
                           INNER JOIN index_pubkeys   pk ON (pk.id=cd.signing_pubkey_id)
                           INNER JOIN index_tickers   tk ON (tk.id=cd.tick_id)
                           LEFT  JOIN index_statuses  cds ON (cds.id=cd.status_id)
                          WHERE a.address=? AND pk.pubkey=? AND cd.target_contract_index=? AND tk.tick=?
                          ORDER BY cd.action_index DESC LIMIT 1`;

// Find the newest capability delegation a v2 revoke targeted, by source and key.
const DELEGATE_CAPABILITY_REVOKE_PARENT = `SELECT d.activation_block, d.deactivation_block, ds.status
                           FROM delegations d
                           INNER JOIN index_addresses a  ON (a.id=d.source_id)
                           INNER JOIN index_pubkeys   pk ON (pk.id=d.signing_pubkey_id)
                           LEFT  JOIN index_statuses  ds ON (ds.id=d.status_id)
                          WHERE a.address=? AND pk.pubkey=?
                          ORDER BY d.action_index DESC LIMIT 1`;

// Read one SLASH proof with the slash event it produced.
const SLASH_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    pk.pubkey as slashed_pubkey,
                    m.capability,
                    m.equiv_key,
                    m.amount,
                    m.bounty_amount,
                    m.treasury_amount,
                    sub.address as submitter,
                    dst.address as destination,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index
                FROM
                    actions a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN capability_slash_events m ON (m.slash_action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk  ON (pk.id=m.signing_pubkey_id)
                    LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                    LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

// Read one STAKE across the capability and contract stake tables.
const STAKE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                    COALESCE(s.version, cs.version) as version,
                    COALESCE(s.amount, cs.amount) as amount,
                    cs.target_contract_index,
                    tk.tick,
                    COALESCE(s.activation_block, cs.activation_block) as activation_block,
                    COALESCE(s.deactivation_block, cs.deactivation_block) as deactivation_block,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    COALESCE(ss.status, css.status) as status
                FROM
                    actions a1
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN stakes             s  ON (s.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=s.signing_pubkey_id)
                    LEFT  JOIN index_statuses     ss ON (ss.id=s.status_id)
                    LEFT  JOIN contract_stakes    cs ON (cs.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cs.signing_pubkey_id)
                    LEFT  JOIN index_tickers      tk ON (tk.id=cs.tick_id)
                    LEFT  JOIN index_statuses     css ON (css.id=cs.status_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

// Read one UNSTAKE across the capability and contract unstake tables.
const UNSTAKE_DETAIL = `SELECT
                    a2.action,
                    a1.action_format,
                    a1.action_index,
                    a3.address as source,
                    COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                    COALESCE(u.amount, cu.amount) as amount,
                    COALESCE(u.cooldown_end_block, cu.cooldown_end_block) as cooldown_end_block,
                    cu.target_contract_index,
                    tk.tick,
                    b1.block_index,
                    b1.block_time as timestamp,
                    t2.hash as tx_hash,
                    t1.tx_index,
                    COALESCE(us.status, cus.status) as status
                FROM
                    actions a1
                    INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    LEFT  JOIN index_addresses    a3 ON (a3.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN unstakes           u  ON (u.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=u.signing_pubkey_id)
                    LEFT  JOIN index_statuses     us ON (us.id=u.status_id)
                    LEFT  JOIN contract_unstakes  cu ON (cu.action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cu.signing_pubkey_id)
                    LEFT  JOIN index_tickers      tk ON (tk.id=cu.tick_id)
                    LEFT  JOIN index_statuses     cus ON (cus.id=cu.status_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;

module.exports = {
    COLLECT_DETAIL,
    DELEGATE_DETAIL,
    DELEGATE_CONTRACT_REVOKE_PARENT,
    DELEGATE_CAPABILITY_REVOKE_PARENT,
    SLASH_DETAIL,
    STAKE_DETAIL,
    UNSTAKE_DETAIL
};
