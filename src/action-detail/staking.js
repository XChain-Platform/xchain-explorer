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
 * Detail handlers for the staking family: STAKE, UNSTAKE, DELEGATE, COLLECT
 * and the permissionless SLASH proof.
 ********************************************************************/

'use strict';

const COLLECT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
        return { query, query2, query3 };
    },
};

const DELEGATE = {
    // DELEGATE action (v0/v2 capability -> delegations; v1/v3 contract-targeted -> contract_delegations).
    // A DELEGATE may also write a stake_key_revocations row (revocation variant);
    // revoked_pubkey and deactivation_block are NULL when no revocation occurred.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
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
        return { query, query2, query3 };
    },
    // DELEGATE revoke de-blank . The v2 capability-revoke and v3
    // contract-revoke variants deactivate the PARENT delegation row and, at/after
    // the DELEGATE_REVOKE_NO_REINSERT flag-day (BTC 963000,  cohort), write NO
    // row of their own keyed by the revoking action's action_index (v3 never did).
    // The main query's `delegations` / `contract_delegations` joins are on
    // a1.action_index, so they return nothing and the page renders blank. Resolve
    // the revoke target from the transaction's decoded wire (signing_pubkey, plus
    // target_contract_index + tick for v3), then look up the parent row by
    // (source, signing_pubkey[, target_contract_index, tick]) to surface its
    // activation/deactivation window + status. Rotates (signing_pubkey already set
    // via pk1/pk2) and stake-key revokes (revoked_pubkey set via
    // stake_key_revocations) are left untouched. Backward compatible: below the
    // flag-day a v2 revoke still carries its own delegations row so this no-ops.
    async afterMain({ db, config }, data) {
        let fmt = Number(data['action_format']);
        if((fmt===2 || fmt===3) && db.util.isNull(data['signing_pubkey']) && db.util.isNull(data['revoked_pubkey'])){
            let seg = db._parseDelegateRevokeWire(data['wire_data'], fmt);
            if(seg && seg.pubkey){
                data['signing_pubkey'] = seg.pubkey;
                let prow;
                if(fmt===3){
                    data['target_contract_index'] = seg.target;
                    data['tick'] = seg.tick;
                    prow = await db.doQuery(config,
                        `SELECT cd.activation_block, cd.deactivation_block, cds.status
                           FROM contract_delegations cd
                           INNER JOIN index_addresses a  ON (a.id=cd.source_id)
                           INNER JOIN index_pubkeys   pk ON (pk.id=cd.signing_pubkey_id)
                           INNER JOIN index_tickers   tk ON (tk.id=cd.tick_id)
                           LEFT  JOIN index_statuses  cds ON (cds.id=cd.status_id)
                          WHERE a.address=? AND pk.pubkey=? AND cd.target_contract_index=? AND tk.tick=?
                          ORDER BY cd.action_index DESC LIMIT 1`,
                        [data['source'], seg.pubkey.toLowerCase(), Number(seg.target), seg.tick]);
                } else {
                    prow = await db.doQuery(config,
                        `SELECT d.activation_block, d.deactivation_block, ds.status
                           FROM delegations d
                           INNER JOIN index_addresses a  ON (a.id=d.source_id)
                           INNER JOIN index_pubkeys   pk ON (pk.id=d.signing_pubkey_id)
                           LEFT  JOIN index_statuses  ds ON (ds.id=d.status_id)
                          WHERE a.address=? AND pk.pubkey=?
                          ORDER BY d.action_index DESC LIMIT 1`,
                        [data['source'], seg.pubkey.toLowerCase()]);
                }
                if(prow && prow.length){
                    data['activation_block']   = prow[0].activation_block;
                    data['deactivation_block'] = prow[0].deactivation_block;
                    if(db.util.isNull(data['status'])) data['status'] = prow[0].status;
                }
            }
        }
        delete data['wire_data'];
    },
};

const SLASH = {
    // SLASH action (permissionless equivocation proof -> capability_slash_events). Drives
    // from `actions` so the wire action always resolves even before the slash event row is
    // joined; capability_slash_events.slash_action_index points back to this SLASH action.
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN capability_slash_events m ON (m.slash_action_index=a1.action_index)
                    LEFT  JOIN index_pubkeys      pk  ON (pk.id=m.signing_pubkey_id)
                    LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                    LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                WHERE
                    a1.action_index=?
                LIMIT 1`;
        return { query, query2, query3 };
    },
};

const STAKE = {
    // STAKE action (v1/v2 capability stake → stakes; v3 contract-targeted → contract_stakes)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
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
        return { query, query2, query3 };
    },
};

const UNSTAKE = {
    // UNSTAKE action (v0 capability → unstakes; v1 contract-targeted → contract_unstakes)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = `SELECT
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
                    LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
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
        return { query, query2, query3 };
    },
    // UNSTAKE v2 (cooldown-completion): the synthetic completion action
    // writes only the return credit - no unstakes / contract_unstakes row -
    // so amount / signing_pubkey / cooldown_end_block come back NULL. Surface
    // the returned credit as the amount (and its tick) so the detail page
    // shows the value returned instead of an empty '-'. v0/v1 UNSTAKEs keep
    // their own amount and are unaffected (this only fires when amount is NULL).
    afterEffects({ db }, data) {
        if(db.util.isNull(data['amount']) && Array.isArray(data.credits) && data.credits.length){
            data['amount'] = data.credits[0].amount;
            if(db.util.isNull(data['tick']))
                data['tick'] = data.credits[0].tick;
        }
    },
};

module.exports = {
    COLLECT,
    DELEGATE,
    SLASH,
    STAKE,
    UNSTAKE
};
