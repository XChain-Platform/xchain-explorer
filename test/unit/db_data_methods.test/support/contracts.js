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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

const { sinon, expect, configInfo, mockResults, makeDb, cfg } = require('./helpers.js');

let db;

// A minimal contract row as returned by the SELECT (manifest columns vary).
function contractRow(overrides = {}) {
    return Object.assign({
        action:            'DEPLOY',
        action_index:      900,
        action_format:     0,
        source:            'deployerAddr',
        code:              'module.exports={}',
        code_hash:         'abc123',
        api_version:       1,
        cooldown_blocks:   null,
        slash_destination: null,
        block_index:       500,
        timestamp:         1700000000,
        tx_hash:           'tx900',
        tx_index:          90,
        status:            'valid',
        permissions:       null,
        max_take_bps:      null
    }, overrides);
}

const baseCfg = () => cfg({ data: { search: '900', sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 } } });

// getContract is a single-record data method (returns [data]); it LEFT JOINs
// the contract's permissions manifest.
describe('Database#getContract', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when no contract found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const [data] = await db.getContract(baseCfg());
        expect(data).to.be.null;
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        const [data] = await db.getContract(baseCfg());
        expect(data).to.be.null;
    });

    it('returns the contract row with permissions=null / max_take_bps=null when no manifest', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow()]);
        const [data] = await db.getContract(baseCfg());
        expect(data.action_index).to.equal(900);
        expect(data.permissions).to.equal(null);
        expect(data.max_take_bps).to.equal(null);
    });

    // openapi's info.description promises chain indices are exact decimal
    // strings on REST, and utility.jsonStringify delivers that only while the value is
    // still the driver's BIGINT. A Number() coercion here collapsed 9007199254740995
    // onto ...96 and disagreed with block_index in this same row.
    it('leaves a BIGINT action_index exact rather than coercing it to a Number', async () => {
        const big = BigInt('9007199254740995');
        sinon.stub(db, 'doQuery').resolves([contractRow({ action_index: big })]);
        const [data] = await db.getContract(baseCfg());
        expect(typeof data.action_index).to.equal('bigint');
        expect(String(data.action_index)).to.equal('9007199254740995');
    });

    it('parses a JSON permissions array and coerces max_take_bps to a number', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: '["send","mint"]', max_take_bps: '300' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.deep.equal(['send', 'mint']);
        expect(data.max_take_bps).to.equal(300);
    });

    it('falls back to permissions=null on malformed JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: 'not json' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.equal(null);
    });

    it('preserves an empty permissions array ("emits nothing")', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ permissions: '[]' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.permissions).to.deep.equal([]);
    });
});

describe('Database#getContract', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('LEFT JOINs contract_permissions on the contract action_index', async () => {
        // Capture only the FIRST query: getContract now issues a second
        // point-read for constructor params after the main select.
        let captured;
        sinon.stub(db, 'doQuery').callsFake(async (c, query) => { if(captured === undefined) captured = query; return [contractRow()]; });
        await db.getContract(baseCfg());
        expect(captured).to.include('LEFT  JOIN contract_permissions cp');
        expect(captured).to.include('cp.contract_index=m.action_index');
    });

    it('sets code_hash_ok=true when code_hash matches sha256(code)', async () => {
        const crypto = require('crypto');
        const code   = 'module.exports = { run: function(xchain){ return 1; } };';
        const hash   = crypto.createHash('sha256').update(code).digest('hex');
        sinon.stub(db, 'doQuery').resolves([contractRow({ code, code_hash: hash })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.code_hash_ok).to.equal(true);
    });

    it('flags a corrupted row with code_hash_ok=false', async () => {
        sinon.stub(db, 'doQuery').resolves([contractRow({ code: 'module.exports={}', code_hash: 'not-the-real-hash' })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.code_hash_ok).to.equal(false);
    });

    it('extracts the AST method list into `methods`', async () => {
        const code = 'module.exports = { transfer: function(xchain){}, balanceOf: (xchain) => 1 };';
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['balanceOf', 'transfer']);
    });

    it('returns methods=null when the source shape is unrecognized', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code: 'syntax error (', code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.methods).to.equal(null);
    });

    it('surfaces constructor params from the contract_executions constructor row', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
            if(q.includes('contract_executions')){
                expect(q).to.include("method_name='constructor'");
                expect(a[0]).to.equal(900); // the contract's own action_index
                return [{ input_params: 'alice|1000' }];
            }
            return [contractRow()];
        });
        const [data] = await db.getContract(baseCfg());
        expect(data.constructor_params).to.equal('alice|1000');
    });
});

describe('Database#getContract', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('leaves constructor_params null when the deploy had none', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [{ input_params: '' }] : [contractRow()]);
        const [data] = await db.getContract(baseCfg());
        expect(data.constructor_params).to.equal(null);
    });

    it('keys the introspection cache by the computed digest, not the stored code_hash', async () => {
        // Two rows claim the SAME stored code_hash but carry different code: a
        // corrupted/poisoned row must not seed the cache entry the honest
        // code's digest resolves to (or read it), in either order.
        let code = 'module.exports = { alpha: function(xchain){} };';
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'shared-claimed-hash' })]);
        let [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['alpha']);
        expect(data.code_hash_ok).to.equal(false);
        code = 'module.exports = { beta: function(xchain){} };';
        [data] = await db.getContract(baseCfg());
        expect(data.methods).to.deep.equal(['beta']);
    });

    it('serves the extracted abi block (cached with methods by computed digest)', async () => {
        const code = `module.exports = {
            abi: { version: 1, methods: { run: { summary: 'Run it', params: [ { name: 'x', type: 'string' } ] } } },
            run: function(xchain){}
        };`;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code, code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.abi.version).to.equal(1);
        expect(data.abi.methods.run.params).to.deep.equal([{ name: 'x', type: 'string' }]);
        expect(data.methods).to.deep.equal(['run']);
    });

    it('serves abi=null when the contract declares none', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
            q.includes('contract_executions') ? [] : [contractRow({ code: 'module.exports = { run: function(x){} };', code_hash: 'h-' + Math.random() })]);
        const [data] = await db.getContract(baseCfg());
        expect(data.abi).to.equal(null);
    });
});

describe('Database#getContract', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('wallet_url defaults, honors an override, and treats empty as explicit off', async () => {
        const prev = process.env.EXPLORER_WALLET_URL;
        try {
            delete process.env.EXPLORER_WALLET_URL;
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            let [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('https://wallet.xchain.io');
            sinon.restore();

            process.env.EXPLORER_WALLET_URL = 'https://wallet.example.test';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('https://wallet.example.test');
            sinon.restore();

            process.env.EXPLORER_WALLET_URL = '';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.wallet_url).to.equal('');
        } finally {
            if(prev === undefined) delete process.env.EXPLORER_WALLET_URL;
            else process.env.EXPLORER_WALLET_URL = prev;
        }
    });

    it('mirrors the EXPLORER_VM_QUERY_ENABLED flag into vm_query_enabled', async () => {
        const prev = process.env.EXPLORER_VM_QUERY_ENABLED;
        try {
            process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            let [data] = await db.getContract(baseCfg());
            expect(data.vm_query_enabled).to.equal(true);
            sinon.restore();

            process.env.EXPLORER_VM_QUERY_ENABLED = 'false';
            sinon.stub(db, 'doQuery').resolves([contractRow()]);
            [data] = await db.getContract(baseCfg());
            expect(data.vm_query_enabled).to.equal(false);
        } finally {
            if(prev === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
            else process.env.EXPLORER_VM_QUERY_ENABLED = prev;
        }
    });
});

describe('Database#getContractManifest', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns null when the contract has no manifest row', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getContractManifest(cfg(), 900)).to.equal(null);
    });

    it('returns null when doQuery returns false', async () => {
        sinon.stub(db, 'doQuery').resolves(false);
        expect(await db.getContractManifest(cfg(), 900)).to.equal(null);
    });

    it('returns null without querying for a null contract index', async () => {
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getContractManifest(cfg(), null)).to.equal(null);
        expect(q.called).to.be.false;
    });

    it('parses permissions JSON and coerces max_take_bps', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '["send"]', max_take_bps: '250' }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m).to.deep.equal({ permissions: ['send'], max_take_bps: 250 });
    });

    it('returns permissions=null (unrestricted) but a real max_take_bps', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: null, max_take_bps: '100' }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.equal(null);
        expect(m.max_take_bps).to.equal(100);
    });

    it('returns max_take_bps=null (global cap) when not set', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '[]', max_take_bps: null }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.deep.equal([]);
        expect(m.max_take_bps).to.equal(null);
    });

    it('falls back to permissions=null on malformed JSON', async () => {
        sinon.stub(db, 'doQuery').resolves([{ permissions: '{oops', max_take_bps: null }]);
        const m = await db.getContractManifest(cfg(), 900);
        expect(m.permissions).to.equal(null);
    });
});
