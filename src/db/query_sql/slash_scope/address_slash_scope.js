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
 * XChain Explorer - which contract slashes belong to one address
 *
 * slash_events names the signing key that was slashed and nothing else, so an
 * address reaches its slashes through the keys its stake rows carry. The key on
 * a stake row is not stable: a DELEGATE v1 rotation rewrites it in place on every
 * surviving contract_stakes and contract_unstakes row of the slot and journals the
 * key it replaced in contract_delegation_rotations. A slash recorded under the
 * old key therefore no longer matches any current row of the address.
 *
 * Two rules attribute a slash to the address:
 *   current  the slashed key is the key a contract_stakes row of the address
 *            carries now;
 *   rotated  a stake or unstake row of the address, on the slashed contract, was
 *            rotated off the slashed key, and the slash fell inside the span the
 *            row held that key: from the previous rotation of the row (or the
 *            row's own block when it was never rotated before) up to the rotation
 *            that replaced the key. A rotation runs ahead of its block's
 *            transactions, so a slash in the rotation's own block already used the
 *            new key and is excluded. Old keys are not reserved, so without the
 *            span a later holder of the same key would pass its slashes to this
 *            address.
 *
 * Each branch is driven from the address's own rows into slash_events by its
 * signing_pubkey_id index and from a stake row into the journal by its
 * (target_table, stake_action_index, block_index) index. The address is resolved once,
 * through the one placeholder, and both call sites bind a single value.
 *
 ********************************************************************/

'use strict';

const STAKE_LEDGERS = ['contract_stakes', 'contract_unstakes'];

// Slashes under a key the address's row in one ledger held before a rotation.
function rotatedBranch(ledger){
    return `SELECT x.id FROM held_by a
                    INNER JOIN ${ledger} sr ON (sr.source_id=a.id)
                    INNER JOIN contract_delegation_rotations r
                        ON (r.target_table='${ledger}' AND r.stake_action_index=sr.action_index)
                    INNER JOIN slash_events x
                        ON (x.signing_pubkey_id=r.prev_signing_pubkey_id
                            AND x.target_contract_index=sr.target_contract_index)
                WHERE x.block_index<r.block_index
                  AND x.block_index>=COALESCE(
                        (SELECT MAX(p.block_index) FROM contract_delegation_rotations p
                         WHERE p.target_table=r.target_table
                           AND p.stake_action_index=r.stake_action_index
                           AND p.block_index<r.block_index),
                        sr.block_index)`;
}

// The predicate over slash_events aliased m, with one placeholder for the address.
// The branches sit in a derived table so the server builds the id set once; a UNION
// directly under IN is run once per slash row instead.
function addressSlashScope(){
    return `m.id IN (
            SELECT hit.id FROM (
                WITH held_by AS (SELECT id FROM index_addresses WHERE address=?)
                SELECT x.id FROM held_by a
                        INNER JOIN contract_stakes cs ON (cs.source_id=a.id)
                        INNER JOIN slash_events x ON (x.signing_pubkey_id=cs.signing_pubkey_id)
                UNION
                ${STAKE_LEDGERS.map(rotatedBranch).join('\n                UNION\n                ')}
            ) hit
        )`;
}

module.exports = { addressSlashScope };
