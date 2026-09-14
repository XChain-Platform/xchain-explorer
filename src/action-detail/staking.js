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

const sql = require('../db/action_detail/staking_sql.js');

const COLLECT = {
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.COLLECT_DETAIL;
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
        query = sql.DELEGATE_DETAIL;
        return { query, query2, query3 };
    },
    // DELEGATE revoke de-blank. The v2 capability-revoke and v3
    // contract-revoke variants deactivate the PARENT delegation row and, at/after
    // the DELEGATE_REVOKE_NO_REINSERT flag-day (BTC 963000), write NO
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
            let seg = db.parseDelegateRevokeWire(data['wire_data'], fmt);
            if(seg && seg.pubkey){
                data['signing_pubkey'] = seg.pubkey;
                let prow;
                if(fmt===3){
                    data['target_contract_index'] = seg.target;
                    data['tick'] = seg.tick;
                    prow = await db.doQuery(config,
                        sql.DELEGATE_CONTRACT_REVOKE_PARENT,
                        [data['source'], seg.pubkey.toLowerCase(), Number(seg.target), seg.tick]);
                } else {
                    prow = await db.doQuery(config,
                        sql.DELEGATE_CAPABILITY_REVOKE_PARENT,
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
        query = sql.SLASH_DETAIL;
        return { query, query2, query3 };
    },
};

const STAKE = {
    // STAKE action (v1/v2 capability stake → stakes; v3 contract-targeted → contract_stakes)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.STAKE_DETAIL;
        return { query, query2, query3 };
    },
};

const UNSTAKE = {
    // UNSTAKE action (v0 capability → unstakes; v1 contract-targeted → contract_unstakes)
    queries() {
        let query  = null;
        let query2 = null;
        let query3 = null;
        query = sql.UNSTAKE_DETAIL;
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
