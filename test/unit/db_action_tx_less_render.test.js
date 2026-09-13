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
 * getActionData rendering parity for system-synthesized (transaction-less /
 * row-less) actions.
 *
 * The indexer mints actions with no transaction (tx_index NULL) and, for some
 * variants, no domain-table row at all. These tests exercise the getActionData
 * control flow that keeps their public action pages from rendering blank:
 *   - the de-blank fallback (row-less variants, e.g. an XEXEC / CROSS_SETTLE
 *     whose domain row was reorg-dropped) surfaces baseline action / block /
 *     timestamp; the dedicated XEXEC / CROSS_SETTLE branches render the rich row
 *   - XCALL v1 result-markers resolve their callback by action_index + tag v1
 *   - ATTEST v2 expire tags its version from the action format (Expire badge)
 *   - UNSTAKE v2 cooldown-completion surfaces the returned credit as the amount
 *
 * doQuery is stubbed with a keyword router: no real MariaDB pool is needed and
 * the SQL text is matched to decide which canned rows come back.
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

// Build a doQuery stub that routes on SQL substrings. `opts`:
//   type            -> what getActionType returns
//   mainRows        -> rows the dedicated branch query returns (default [])
//   fallbackRow     -> baseline row the de-blank fallback returns
//   credits         -> credits rows (default [])
//   callbackByIndex -> row for cross_chain_call_callbacks WHERE action_index=?
function makeDoQuery(opts) {
    const o = Object.assign({ mainRows: [], credits: [], callbackByIndex: null }, opts);
    return async function(config, sql, args) {
        const q = String(sql);
        // getActionType: selects a2.action from actions with no block_index column
        if(q.includes('a2.action') && q.includes('actions a1') && !q.includes('block_index'))
            return [{ action: o.type }];
        // de-blank generic fallback
        if(q.includes('b1.block_index=a1.block_index') && q.includes('LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)')
           && !q.includes('unstakes') && !q.includes('attests') && !q.includes('xcalls') && !q.includes('contract_executions'))
            return o.fallbackRow ? [o.fallbackRow] : [];
        // XCALL v1 callback resolution by action_index
        if(q.includes('cross_chain_call_callbacks') && q.includes('action_index=?'))
            return o.callbackByIndex ? [o.callbackByIndex] : [];
        if(q.includes('cross_chain_call_callbacks') && q.includes('call_id=?')) return [];
        if(q.includes('cross_chain_call_executions')) return [];
        // ledger effects
        if(q.includes('credits c1')) return o.credits;
        if(q.includes('debits d1'))  return [];
        if(q.includes('escrows e1')) return [];
        if(q.includes('fees f1'))    return [];
        if(q.includes('transactions t1') && q.includes('t2.hash=?')) return []; // getTransactionData
        // dedicated branch queries (attests/xcalls/unstakes/contract_executions/...)
        return o.mainRows;
    };
}

describe('getActionData: transaction-less / row-less action rendering @regression', function() {

    it('de-blanks a branchless mirror-injected type (XEXEC) with baseline fields', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            type: 'XEXEC',
            fallbackRow: { action: 'XEXEC', action_format: 0, action_index: 42, source: null,
                           block_index: 700, timestamp: 1700000000, tx_hash: null, tx_index: null },
            credits: [{ address: 'addrC', tick: 'XCHAIN', amount: '1.0' }]
        });
        const data = await db.getActionData(cfg(), 42);
        expect(data.action).to.equal('XEXEC');
        expect(data.block_index).to.equal(700);
        expect(data.timestamp).to.equal(1700000000);
        // Ledger effects still attach by action_index for the branchless type.
        expect(data.credits).to.be.an('array').with.lengthOf(1);
    });

    it('CROSS_SETTLE (branchless) also renders baseline instead of blank', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            type: 'CROSS_SETTLE',
            fallbackRow: { action: 'CROSS_SETTLE', action_format: 0, action_index: 43, source: null,
                           block_index: 701, timestamp: 1700000100, tx_hash: null, tx_index: null }
        });
        const data = await db.getActionData(cfg(), 43);
        expect(data.action).to.equal('CROSS_SETTLE');
        expect(data.block_index).to.equal(701);
    });

    it('XEXEC renders its cross_chain_call_executions row (call_id / result / gas / execute action)', async function() {
        const db = makeDb();
        db.doQuery = async function(config, sql, args) {
            const q = String(sql);
            if(q.includes('a2.action') && q.includes('actions a1') && !q.includes('block_index'))
                return [{ action: 'XEXEC' }];
            if(q.includes('cross_chain_call_executions m'))
                return [{ action: 'XEXEC', action_format: 0, action_index: 44, call_id: 'abc123',
                          execute_action_index: 45, result_status: 'ok', return_payload_b64: 'Zm9v',
                          gas_used: '12000', block_index: 710, timestamp: 1700000200, tx_hash: null, tx_index: null }];
            return [];
        };
        const data = await db.getActionData(cfg(), 44);
        expect(data.action).to.equal('XEXEC');
        expect(data.call_id).to.equal('abc123');
        expect(data.execute_action_index).to.equal(45);
        expect(data.result_status).to.equal('ok');
        expect(data.gas_used).to.equal('12000');
        expect(data.block_index).to.equal(710);
    });

    it('CROSS_SETTLE renders its cross_chain_settlements row (match_id / local offer / both legs)', async function() {
        const db = makeDb();
        db.doQuery = async function(config, sql, args) {
            const q = String(sql);
            if(q.includes('a2.action') && q.includes('actions a1') && !q.includes('block_index'))
                return [{ action: 'CROSS_SETTLE' }];
            if(q.includes('cross_chain_settlements m'))
                return [{ action: 'CROSS_SETTLE', action_format: 0, action_index: 46, match_id: 'm-99',
                          local_action_index: 47, a_chain: 'btc', a_action_index: 48, b_chain: 'doge',
                          b_action_index: 49, block_index: 720, timestamp: 1700000300, tx_hash: null, tx_index: null }];
            return [];
        };
        const data = await db.getActionData(cfg(), 46);
        expect(data.action).to.equal('CROSS_SETTLE');
        expect(data.match_id).to.equal('m-99');
        expect(data.local_action_index).to.equal(47);
        expect(data.a_chain).to.equal('btc');
        expect(data.b_action_index).to.equal(49);
        expect(data.block_index).to.equal(720);
    });

    it('XCALL v1 result-marker resolves the callback by action_index and tags version 1', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            type: 'XCALL',
            mainRows: [], // no xcalls row for a v1 marker
            fallbackRow: { action: 'XCALL', action_format: 1, action_index: 55, source: null,
                           block_index: 800, timestamp: 1700000200, tx_hash: null, tx_index: null },
            callbackByIndex: { call_id: 'deadbeef', result_status: 'ok', callback_block_index: 800 }
        });
        const data = await db.getActionData(cfg(), 55);
        expect(Number(data.version)).to.equal(1);
        expect(data.call_id).to.equal('deadbeef');
        expect(data.callback_delivery).to.be.an('object');
        expect(data.callback_delivery.callback_result_status).to.equal('ok');
    });

    it('ATTEST v2 expire tags version 2 from the action format (Expire badge, not Request v0)', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            type: 'ATTEST',
            mainRows: [], // v2 expire writes no attests row
            fallbackRow: { action: 'ATTEST', action_format: 2, action_index: 66, source: null,
                           block_index: 900, timestamp: 1700000300, tx_hash: null, tx_index: null }
        });
        const data = await db.getActionData(cfg(), 66);
        expect(Number(data.version)).to.equal(2);
        expect(data.signatures).to.be.an('array').that.is.empty;
    });

    it('UNSTAKE v2 completion surfaces the returned credit as the amount', async function() {
        const db = makeDb();
        db.doQuery = makeDoQuery({
            type: 'UNSTAKE',
            // FROM actions -> the reshaped branch still returns the action row (block/ts),
            // but amount/pubkey/cooldown are NULL (no unstakes/contract_unstakes row).
            mainRows: [{ action: 'UNSTAKE', action_format: 2, action_index: 77, source: null,
                         signing_pubkey: null, amount: null, cooldown_end_block: null,
                         target_contract_index: null, tick: null,
                         block_index: 1000, timestamp: 1700000400, tx_hash: null, tx_index: null, status: null }],
            credits: [{ address: 'staker1', tick: 'XCHAIN', amount: '5.0' }]
        });
        const data = await db.getActionData(cfg(), 77);
        expect(data.amount).to.equal('5.0');
        expect(data.tick).to.equal('XCHAIN');
        expect(data.block_index).to.equal(1000);
    });
});
