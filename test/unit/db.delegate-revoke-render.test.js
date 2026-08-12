/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * getActionData rendering for DELEGATE revoke actions after the
 * DELEGATE_REVOKE_NO_REINSERT flag-day .
 *
 * At/after the flag-day (BTC 963000,  cohort) a v2 capability-revoke and a
 * v3 contract-revoke deactivate the PARENT delegation row and write NO row of
 * their own keyed by the revoking action's action_index (v3 never did). The main
 * DELEGATE detail query joins `delegations` / `contract_delegations` on
 * a1.action_index, so those joins return nothing and the action page blanks.
 * getActionData now resolves the revoke target from the transaction's decoded
 * wire (signing_pubkey, plus target_contract_index + tick for v3) and looks up
 * the parent row by (source, signing_pubkey[, target_contract_index, tick]).
 *
 * doQuery is stubbed with a keyword router: no real MariaDB pool is needed and
 * the SQL text decides which canned rows come back.
 */

'use strict';

const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() { return new Database(mockExplorer); }
function cfg() { return makeConfig({ coin: 'BTC' }); }

const PUBKEY = 'a'.repeat(64); // 64-hex Ed25519 signing pubkey

// Route doQuery on SQL substrings. `opts`:
//   mainRows   -> the DELEGATE detail branch row(s)
//   v2Parent   -> parent delegations lookup row (v2 capability revoke)
//   v3Parent   -> parent contract_delegations lookup row (v3 contract revoke)
function makeDoQuery(opts) {
    const o = Object.assign({ mainRows: [], v2Parent: null, v3Parent: null }, opts);
    return async function(config, sql, args) {
        const q = String(sql);
        // getActionType: a2.action from actions, no block_index column
        if(q.includes('a2.action') && q.includes('actions a1') && !q.includes('block_index'))
            return [{ action: 'DELEGATE' }];
        // DELEGATE detail branch (drives from actions, joins stake_key_revocations)
        if(q.includes('stake_key_revocations skr'))
            return o.mainRows;
        // v3 parent contract_delegations resolution 
        if(q.includes('contract_delegations cd') && q.includes('cd.target_contract_index=?'))
            return o.v3Parent ? [o.v3Parent] : [];
        // v2 parent delegations resolution 
        if(q.includes('FROM delegations d') || (q.includes('delegations d') && q.includes('ORDER BY d.action_index DESC')))
            return o.v2Parent ? [o.v2Parent] : [];
        // ledger effects
        if(q.includes('credits c1')) return [];
        if(q.includes('debits d1'))  return [];
        if(q.includes('escrows e1')) return [];
        if(q.includes('fees f1'))    return [];
        if(q.includes('transactions t1') && q.includes('t2.hash=?')) return []; // getTransactionData
        return [];
    };
}

// A v2 capability-revoke row as it comes back AFTER the flag-day: the action row
// resolves (source/block/tx) but the delegations join produced no signing_pubkey.
function v2RevokeMainRow(wire) {
    return {
        action: 'DELEGATE', action_format: 2, action_index: 500, source: 'bc1qsource',
        signing_pubkey: null, target_contract_index: null, tick: null,
        activation_block: null, deactivation_block: null,
        block_index: 969600, timestamp: 1790820000, tx_hash: 'deadbeef', tx_index: 88,
        wire_data: wire, status: null, revoked_pubkey: null, revocation_deactivation_block: null
    };
}

function v3RevokeMainRow(wire) {
    return {
        action: 'DELEGATE', action_format: 3, action_index: 501, source: 'bc1qsource',
        signing_pubkey: null, target_contract_index: null, tick: null,
        activation_block: null, deactivation_block: null,
        block_index: 969600, timestamp: 1790820000, tx_hash: 'cafebabe', tx_index: 89,
        wire_data: wire, status: null, revoked_pubkey: null, revocation_deactivation_block: null
    };
}

describe('getActionData: DELEGATE revoke rendering after DELEGATE_REVOKE_NO_REINSERT  @regression', function() {

    it('v2 capability-revoke: resolves signing_pubkey from wire + parent activation window', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            mainRows: [ v2RevokeMainRow('DELEGATE|2|' + PUBKEY) ],
            v2Parent: { activation_block: 969000, deactivation_block: 969700, status: 'valid' }
        });
        const data = await db.getActionData(cfg(), 500);
        expect(data.action).to.equal('DELEGATE');
        expect(data.signing_pubkey).to.equal(PUBKEY);
        expect(Number(data.activation_block)).to.equal(969000);
        expect(Number(data.deactivation_block)).to.equal(969700);
        expect(data.status).to.equal('valid');
        expect(data).to.not.have.property('wire_data');
    });

    it('v3 contract-revoke: resolves pubkey + target_contract_index + tick from wire and parent row', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            mainRows: [ v3RevokeMainRow('DELEGATE|3|' + PUBKEY + '|7|PEPE') ],
            v3Parent: { activation_block: 3160000, deactivation_block: 3160500, status: 'valid' }
        });
        const data = await db.getActionData(cfg(), 501);
        expect(data.signing_pubkey).to.equal(PUBKEY);
        expect(String(data.target_contract_index)).to.equal('7');
        expect(data.tick).to.equal('PEPE');
        expect(Number(data.activation_block)).to.equal(3160000);
        expect(Number(data.deactivation_block)).to.equal(3160500);
        expect(data.status).to.equal('valid');
        expect(data).to.not.have.property('wire_data');
    });

    it('v2 revoke nested in a BATCH still extracts the DELEGATE segment', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            mainRows: [ v2RevokeMainRow('BATCH|0|SEND|0|bc1qdest|XCHAIN|1;DELEGATE|2|' + PUBKEY) ],
            v2Parent: { activation_block: 100, deactivation_block: 150, status: 'valid' }
        });
        const data = await db.getActionData(cfg(), 500);
        expect(data.signing_pubkey).to.equal(PUBKEY);
        expect(Number(data.deactivation_block)).to.equal(150);
    });

    it('v2 revoke renders pubkey even when the parent row is not found (reorg-dropped)', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            mainRows: [ v2RevokeMainRow('DELEGATE|2|' + PUBKEY) ],
            v2Parent: null
        });
        const data = await db.getActionData(cfg(), 500);
        expect(data.signing_pubkey).to.equal(PUBKEY); // not blank
        expect(data.activation_block).to.be.oneOf([null, undefined]);
    });

    it('stake-key revoke (revoked_pubkey set) is NOT overridden by the wire resolver', async function() {
        const db = makeDb();
        const REVOKED = 'b'.repeat(64);
        const row = v2RevokeMainRow('DELEGATE|2|' + PUBKEY);
        row.revoked_pubkey = REVOKED;
        row.revocation_deactivation_block = 969700;
        let v2ParentQueried = false;
        const base = makeDoQuery({ mainRows: [ row ] });
        db.doQuery = async function(config, sql, args) {
            if(String(sql).includes('ORDER BY d.action_index DESC')) v2ParentQueried = true;
            return base(config, sql, args);
        };
        const data = await db.getActionData(cfg(), 500);
        expect(data.revoked_pubkey).to.equal(REVOKED);
        expect(data.signing_pubkey).to.be.oneOf([null, undefined]); // wire resolver skipped
        expect(v2ParentQueried).to.equal(false);
    });

    it('capability rotate (v0) is untouched and drops wire_data from the response', async function() {
        const db = makeDb();
        const rotate = {
            action: 'DELEGATE', action_format: 0, action_index: 499, source: 'bc1qsource',
            signing_pubkey: PUBKEY, target_contract_index: null, tick: null,
            activation_block: 968000, deactivation_block: null,
            block_index: 968000, timestamp: 1790000000, tx_hash: 'aa', tx_index: 87,
            wire_data: 'DELEGATE|0|' + PUBKEY, status: 'valid',
            revoked_pubkey: null, revocation_deactivation_block: null
        };
        let parentQueried = false;
        const base = makeDoQuery({ mainRows: [ rotate ] });
        db.doQuery = async function(config, sql, args) {
            const q = String(sql);
            if(q.includes('ORDER BY d.action_index DESC') || q.includes('cd.target_contract_index=?')) parentQueried = true;
            return base(config, sql, args);
        };
        const data = await db.getActionData(cfg(), 499);
        expect(data.signing_pubkey).to.equal(PUBKEY);
        expect(data).to.not.have.property('wire_data');
        expect(parentQueried).to.equal(false);
    });
});
