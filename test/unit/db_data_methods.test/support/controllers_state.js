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

// event() builds a token_controllers row.
function event(o) {
    return Object.assign({
        action_class: 'transfer', action_index: 1, contract_index: 50,
        is_unbind: 0, cooldown_blocks: 0, cooldown_end_block: null, block_index: 100
    }, o);
}

// Controller bindings apply a read-time cooldown reduction, mirroring the
// indexer's readEffectiveControllerMap / controllerEventIfGating.
describe('Database#getTokenControllerBindings', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns [] when the tick has no events', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTokenControllerBindings(cfg(), 'XCHAIN')).to.deep.equal([]);
    });

    it('returns [] when the tick id is unknown', async () => {
        sinon.stub(db, 'getTickId').resolves(null);
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getTokenControllerBindings(cfg(), 'NOPE')).to.deep.equal([]);
        // resolveControllerBindings short-circuits on a null key (no event query)
        expect(q.called).to.be.false;
    });

    it('surfaces an active bind with the shared binding shape', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([event({ action_class: 'trade', contract_index: 88, cooldown_blocks: 10, block_index: 120 })]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(200);
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.deep.equal([{
            action_class: 'trade', contract_index: 88, cooldown_blocks: 10, is_unbind: 0, bind_block: 120, bound_by: null
        }]);
    });

    it('latest event per action_class wins (a later bind supersedes an earlier one)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'transfer', action_index: 1, contract_index: 50 }),
            event({ action_class: 'transfer', action_index: 5, contract_index: 99 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(500);
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.have.lengthOf(1);
        expect(out[0].contract_index).to.equal(99);
    });

    it('an unbind still in cooldown gates (tip < cooldown_end_block)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'burn', action_index: 1, contract_index: 50 }),
            event({ action_class: 'burn', action_index: 2, is_unbind: 1, cooldown_blocks: 100, cooldown_end_block: 300, block_index: 200 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(250); // 250 < 300 → still gating
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.have.lengthOf(1);
        expect(out[0].is_unbind).to.equal(1);
    });
});

describe('Database#getTokenControllerBindings', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('an unbind past its cooldown no longer gates (tip >= cooldown_end_block)', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'burn', action_index: 1, contract_index: 50 }),
            event({ action_class: 'burn', action_index: 2, is_unbind: 1, cooldown_blocks: 100, cooldown_end_block: 300, block_index: 200 })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(300); // 300 >= 300 → expired
        const out = await db.getTokenControllerBindings(cfg(), 'XCHAIN');
        expect(out).to.deep.equal([]);
    });

    it('an unbind with a NULL cooldown_end_block never gates', async () => {
        sinon.stub(db, 'getTickId').resolves(7);
        sinon.stub(db, 'doQuery').resolves([
            event({ action_class: 'mint', action_index: 9, is_unbind: 1, cooldown_end_block: null })
        ]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(0);
        expect(await db.getTokenControllerBindings(cfg(), 'XCHAIN')).to.deep.equal([]);
    });
});

describe('Database#getAddressControllerBindings', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('resolves the address id and returns the gating bindings', async () => {
        sinon.stub(db, 'getAddressId').resolves(42);
        sinon.stub(db, 'doQuery').resolves([{
            action_class: 'stake', action_index: 3, contract_index: 77,
            is_unbind: 0, cooldown_blocks: 5, cooldown_end_block: null, block_index: 130
        }]);
        sinon.stub(db, 'getMaxBlockIndex').resolves(400);
        const out = await db.getAddressControllerBindings(cfg(), 'addr1');
        expect(out).to.deep.equal([{
            action_class: 'stake', contract_index: 77, cooldown_blocks: 5, is_unbind: 0, bind_block: 130, bound_by: null
        }]);
    });

    it('returns [] for an unknown address without querying events', async () => {
        sinon.stub(db, 'getAddressId').resolves(null);
        const q = sinon.stub(db, 'doQuery');
        expect(await db.getAddressControllerBindings(cfg(), 'ghost')).to.deep.equal([]);
        expect(q.called).to.be.false;
    });
});

// F3 (id-determinism): the explorer must only surface an index id for SDK ^<id>
// compaction when it is in the DETERMINISTIC set (block_index IS NOT NULL). An
// out-of-band id (recovery pre-seed, pre-F1a) is not reproducible across nodes; the SDK
// must never compact to it (the indexer would reject the ^id). This gates the two
// SDK-facing fields only (getAddress info.address_id, getToken info.tick_id), never the
// internal getAddressId/getTickId resolvers used for display/lookup.
describe('Database F3 id-determinism: only deterministic ids are compaction-exposed', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('getCompactableAddressId queries the deterministic set and returns the id', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([{ id: 42 }]);
        const id = await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        expect(id).to.equal(42);
        const [, queryStr, args] = dq.firstCall.args;
        expect(queryStr).to.include('block_index IS NOT NULL');
        expect(args).to.deep.equal(['bc1qSrc']);
    });

    it('getCompactableAddressId returns null for a non-deterministic / unindexed address', async () => {
        sinon.stub(db, 'doQuery').resolves([]);   // no row with block_index IS NOT NULL
        expect(await db.getCompactableAddressId(cfg(), 'bc1qOutOfBand')).to.equal(null);
    });

    it('getCompactableAddressId is NOT cached (a NULL-block id must never stick as compactable)', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);
        await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        await db.getCompactableAddressId(cfg(), 'bc1qSrc');
        expect(dq.callCount).to.equal(2);   // re-queried, not served from a cache
    });

    it('getToken gates the SDK-facing tick_id on block_index in the SELECT', async () => {
        const dq = sinon.stub(db, 'doQuery').resolves(mockResults.tokenRow());
        await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        const [, queryStr] = dq.firstCall.args;
        expect(queryStr).to.match(/CASE WHEN t2\.block_index IS NOT NULL THEN t1\.tick_id ELSE NULL END\) AS tick_id/);
    });

    it('getToken surfaces info.tick_id when the DB returns it (deterministic id)', async () => {
        const row = Object.assign({}, mockResults.tokenRow()[0], { tick_id: 5 });
        sinon.stub(db, 'doQuery').resolves([row]);
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.tick_id).to.equal(5);
    });

    it('getToken surfaces info.tick_id === null when the DB gated it out (non-deterministic id)', async () => {
        // The SELECT CASE returns NULL for a block_index-NULL ticker; model that gated output.
        const row = Object.assign({}, mockResults.tokenRow()[0], { tick_id: null });
        sinon.stub(db, 'doQuery').resolves([row]);
        const [data] = await db.getToken(cfg({ data: { search: 'XCHAIN' } }));
        expect(data.info.tick_id).to.equal(null);
    });
});

let db;

// doQuery stub serving the aggregate pre-check first, then the row fetch.
function stubState(aggregates, rows){
    return sinon.stub(db, 'doQuery').callsFake(async (c, q) =>
        q.includes('COUNT(*)') ? [aggregates] : rows);
}

describe('Database#getContractFullState', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('loads latest state rows into a null-prototype map with JSON fallback', async () => {
        stubState({ total_rows: 2, total_bytes: 20 }, [
            { state_key: 'a',         state_value: '{"x":1}' },
            { state_key: '__proto__', state_value: 'raw-string' }
        ]);
        const state = await db.getContractFullState(cfg(), 900);
        expect(Object.getPrototypeOf(state)).to.equal(null);
        expect(state.a).to.deep.equal({ x: 1 });
        expect(state['__proto__']).to.equal('raw-string');
    });

    it('refuses state over the default row cap BEFORE fetching rows (STATE_TOO_LARGE)', async () => {
        const dq = stubState({ total_rows: 10001, total_bytes: 10 }, []);
        try {
            await db.getContractFullState(cfg(), 900);
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
        expect(dq.callCount).to.equal(1);   // only the aggregate gate ran
    });

    it('refuses state over the byte cap (STATE_TOO_LARGE)', async () => {
        stubState({ total_rows: 1, total_bytes: 4 * 1024 * 1024 + 1 }, []);
        try {
            await db.getContractFullState(cfg(), 900, { maxRows: 10000, maxBytes: 4 * 1024 * 1024 });
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
    });

    it('caps the row fetch with LIMIT as belt-and-braces', async () => {
        const dq = stubState({ total_rows: 1, total_bytes: 5 }, [{ state_key: 'k', state_value: '1' }]);
        await db.getContractFullState(cfg(), 900, { maxRows: 500, maxBytes: 1000 });
        expect(dq.secondCall.args[1]).to.include('LIMIT 500');
    });
});

describe('Database#getContractFullState', () => {
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('re-verifies the byte cap against the FETCHED rows (gate/fetch TOCTOU)', async () => {
        // The aggregate gate approved a small payload, but rows written between
        // the two queries push the actually-fetched set past maxBytes: the
        // loader must throw STATE_TOO_LARGE rather than hand the VM an
        // oversized state object.
        stubState({ total_rows: 2, total_bytes: 10 }, [
            { state_key: 'a', state_value: 'x'.repeat(600) },
            { state_key: 'b', state_value: 'y'.repeat(600) }
        ]);
        try {
            await db.getContractFullState(cfg(), 900, { maxRows: 500, maxBytes: 1000 });
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
        }
    });
});
