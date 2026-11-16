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
 * POST /{COIN}/api/history against the indexer's real DDL. The route must
 * answer any number of addresses (up to 20) in the same fixed statement count,
 * page the merged feed without losing or repeating an action, include the
 * transaction-less ledger actions (DISPENSE, ORDER_MATCH, DIVIDEND, SWEEP), and
 * state every effect in base units that sum back to the seeded ledger.
 *
 *********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { ADDRESSES, OUTSIDER, openWalletTables, clearTables, buildExplorer, routeHandler, drive, insert } = require('./support/wallet_fixture.js');
const { base58check } = require('../request/address_shape.test/support/address_encode.js');

const util = new Utility(createConfigInfoStub());
const BLOCK_TIME_0 = 1700000000;

// tick -> { id, decimals }. XCHAIN at 0 decimals carries a half-unit fee debit,
// the one case where a ledger row is finer than its token.
const TOKENS = { XCHAIN: 0, FOO: 8, BAR: 2 };
const ACTION_KINDS = ['SEND', 'DISPENSE', 'ORDER_MATCH', 'DIVIDEND', 'SWEEP'];

let sqlite, seededLedger;

function seedNames(){
    const ids = { actions: {}, ticks: {}, addresses: {} };
    for(const name of ACTION_KINDS) ids.actions[name] = insert(sqlite, 'index_actions', { action: name });
    for(const [tick, decimals] of Object.entries(TOKENS)){
        ids.ticks[tick] = insert(sqlite, 'index_tickers', { tick });
        insert(sqlite, 'tokens', { tick_id: ids.ticks[tick], decimals });
    }
    for(const address of [...ADDRESSES, OUTSIDER]) ids.addresses[address] = insert(sqlite, 'index_addresses', { address });
    return ids;
}

function ledgerRow(ids, table, actionIndex, address, tick, amount){
    insert(sqlite, table, { action_index: actionIndex, address_id: ids.addresses[address], tick_id: ids.ticks[tick], amount });
    const key = address + '|' + tick;
    const prior = seededLedger.get(key) || util.bcnum(0);
    seededLedger.set(key, (table === 'credits') ? prior.plus(amount) : prior.minus(amount));
}

// Address k gets 1 + k actions, so twenty addresses hold far more history than one.
// Every fifth action is a SEND with its own transaction; the rest are tx-less.
function seed(){
    clearTables(sqlite);
    seededLedger = new Map();
    const ids = seedNames();
    for(let b = 100; b < 140; b++) insert(sqlite, 'blocks', { block_index: b, block_time: BLOCK_TIME_0 + (b - 100) * 600 });
    let actionIndex = 0;
    const addAction = (kind, touched, effects) => {
        actionIndex++;
        const block = 100 + Math.floor(actionIndex / 6);
        let tx = null;
        if(kind === 'SEND'){
            const hash = insert(sqlite, 'index_transactions', { hash: 'h' + actionIndex });
            insert(sqlite, 'transactions', { tx_index: actionIndex, block_index: block, tx_hash_id: hash });
            tx = actionIndex;
        }
        insert(sqlite, 'actions', { action_index: actionIndex, block_index: block, tx_index: tx, tx_vout: tx === null ? null : 0, action_id: ids.actions[kind] });
        for(const address of touched) insert(sqlite, 'mappings_actions', { action_index: actionIndex, type_id: 2, id: ids.addresses[address] });
        for(const [table, address, tick, amount] of effects) ledgerRow(ids, table, actionIndex, address, tick, amount);
    };
    ADDRESSES.forEach((address, k) => {
        for(let j = 0; j <= k; j++){
            const kind = ACTION_KINDS[(k + j) % ACTION_KINDS.length];
            addAction(kind, [address, OUTSIDER], [
                ['credits', address, 'FOO', '1.25000000'],
                ['debits', OUTSIDER, 'FOO', '1.25000000'],
                ['debits', address, 'XCHAIN', '0.5'],
                ['credits', address, 'BAR', '3.07']
            ]);
        }
    });
    // A transfer between two requested addresses: one action, both mapped.
    addAction('SEND', [ADDRESSES[0], ADDRESSES[1]], [
        ['debits', ADDRESSES[0], 'BAR', '1.50'],
        ['credits', ADDRESSES[1], 'BAR', '1.50']
    ]);
    // Mapped to the same id under the TICKER type: never part of an address feed.
    insert(sqlite, 'mappings_actions', { action_index: 1, type_id: 1, id: ids.addresses[ADDRESSES[5]] });
    return actionIndex;
}

let explorer, seen, historyRoute;

function useSeededExplorer(){
    before(function () { sqlite = openWalletTables(this); });
    beforeEach(() => {
        seed();
        ({ explorer, seen } = buildExplorer(sqlite));
        historyRoute = routeHandler('post', '/:coin/api/history');
    });
    afterEach(() => sinon.restore());
}

async function post(body){
    seen.length = 0;
    return drive(historyRoute, { path: '/BTC/api/history', body });
}

// Every page of the feed for `addresses`, followed by next_cursor.
async function allPages(addresses, limit, extra = {}){
    const actions = [];
    let before = null;
    for(let guard = 0; guard < 100; guard++){
        const { code, body } = await post(Object.assign({ addresses, limit, before }, extra));
        expect(code).to.equal(200);
        actions.push(...body.actions);
        if(body.next_cursor === null) return actions;
        before = body.next_cursor;
    }
    throw new Error('paging never ended');
}

describe('POST /{COIN}/api/history: statement count', function () {
    useSeededExplorer();

    it('runs the same three statements for 1 address and for 20, though 20 return far more rows', async () => {
        const one = await post({ addresses: [ADDRESSES[0]], limit: 100 });
        const oneCount = seen.length;
        const twenty = await post({ addresses: ADDRESSES, limit: 100 });
        expect(one.body.actions.length).to.be.lessThan(twenty.body.actions.length);
        expect(twenty.body.actions.length).to.equal(100);
        expect(oneCount).to.equal(3);
        expect(seen.length).to.equal(oneCount);
    });

    it('adds one statement for a since/until window, the same for 1 address and for 20', async () => {
        const window = { since: BLOCK_TIME_0 + 3000, until: BLOCK_TIME_0 + 12000 };
        const one = await post(Object.assign({ addresses: [ADDRESSES[10]], limit: 5, before: 150 }, window));
        const oneCount = seen.length;
        expect(one.body.actions.length).to.be.greaterThan(0);
        expect(oneCount).to.equal(4);
        const twenty = await post(Object.assign({ addresses: ADDRESSES, limit: 5, before: 150 }, window));
        expect(twenty.body.actions.length).to.equal(5);
        expect(seen.length).to.equal(oneCount);
    });
});

describe('POST /{COIN}/api/history: merged feed', function () {
    useSeededExplorer();

    it('pages newest first with no action lost or repeated, and the 2-address transfer appears once', async () => {
        const actions = await allPages(ADDRESSES, 7);
        const indexes = actions.map((a) => Number(a.action_index));
        expect(actions.every((a) => /^[0-9]+$/.test(a.action_index))).to.equal(true);
        expect(indexes).to.deep.equal([...indexes].sort((x, y) => y - x));
        expect(new Set(indexes).size).to.equal(indexes.length);
        expect(indexes.length).to.equal(211);
        const transfer = actions[0];
        expect(transfer.addresses).to.have.members([ADDRESSES[0], ADDRESSES[1]]);
        expect(transfer.effects.map((e) => [e.address, e.net_base])).to.deep.equal([[ADDRESSES[0], '-150'], [ADDRESSES[1], '150']]);
    });

    it('carries the history feed columns and includes the tx-less ledger actions', async () => {
        const actions = await allPages([ADDRESSES[4]], 100);
        expect(actions.map((a) => a.action).sort()).to.deep.equal(['DISPENSE', 'DIVIDEND', 'ORDER_MATCH', 'SEND', 'SWEEP']);
        const send = actions.find((a) => a.action === 'SEND');
        expect(send.tx_hash).to.equal('h' + send.action_index);
        const dispense = actions.find((a) => a.action === 'DISPENSE');
        expect(dispense).to.include({ tx_hash: null, tx_index: null });
        expect(dispense.block_index).to.equal(String(100 + Math.floor(dispense.action_index / 6)));
        expect(dispense.timestamp).to.equal(String(BLOCK_TIME_0 + (dispense.block_index - 100) * 600));
    });

    it('answers an empty page for an address with no history, not an error', async () => {
        const { code, body } = await post({ addresses: [base58check(0, Buffer.alloc(20, 77))] });
        expect(code).to.equal(200);
        expect(body.actions).to.deep.equal([]);
        expect(body.next_cursor).to.equal(null);
    });
});

describe('POST /{COIN}/api/history: base-unit effects', function () {
    useSeededExplorer();

    it('sums net_base over every page back to credits minus debits x 10^decimals, per address and token', async () => {
        const actions = await allPages(ADDRESSES, 13);
        const totals = new Map();
        for(const action of actions){
            for(const effect of action.effects){
                expect(ADDRESSES).to.include(effect.address);
                const key = effect.address + '|' + effect.tick;
                totals.set(key, (totals.get(key) || util.bcnum(0)).plus(effect.net_base));
            }
        }
        for(const [key, whole] of seededLedger){
            const [address, tick] = key.split('|');
            if(address === OUTSIDER) continue;
            const expected = whole.times(util.bcnum(10).pow(TOKENS[tick])).toFixed();
            expect(totals.get(key).toFixed(), key).to.equal(expected);
        }
    });

    it('names the unit and keeps a sub-unit fee exact instead of rounding it', async () => {
        const { body } = await post({ addresses: [ADDRESSES[0]], limit: 2 });
        expect(body.amount_unit).to.equal('base');
        const effects = body.actions[1].effects;
        expect(effects.find((e) => e.tick === 'FOO')).to.include({ decimals: 8, credit_base: '125000000', debit_base: '0', net_base: '125000000', net_whole: '1.25' });
        expect(effects.find((e) => e.tick === 'XCHAIN')).to.include({ decimals: 0, net_base: '-0.5', net_whole: '-0.5' });
        expect(effects.find((e) => e.tick === 'BAR')).to.include({ decimals: 2, net_base: '307' });
    });
});

describe('POST /{COIN}/api/history: window and refusals', function () {
    useSeededExplorer();

    it('serves only the blocks inside since/until', async () => {
        const since = BLOCK_TIME_0 + 10 * 600;
        const until = BLOCK_TIME_0 + 20 * 600;
        const actions = await allPages(ADDRESSES, 50, { since, until });
        expect(actions.length).to.be.greaterThan(0);
        for(const action of actions)
            expect(Number(action.timestamp)).to.be.within(since, until);
        const full = await allPages(ADDRESSES, 100);
        const inside = full.filter((a) => Number(a.timestamp) >= since && Number(a.timestamp) <= until);
        expect(actions.map((a) => a.action_index)).to.deep.equal(inside.map((a) => a.action_index));
    });

    for(const [label, body, code] of [
        ['no addresses', { addresses: [] }, 'INVALID_ADDRESSES'],
        ['21 addresses', { addresses: [...ADDRESSES, OUTSIDER] }, 'TOO_MANY_ADDRESSES'],
        ['a limit over 100', { addresses: [ADDRESSES[0]], limit: 101 }, 'INVALID_LIMIT'],
        ['a zero cursor', { addresses: [ADDRESSES[0]], before: 0 }, 'INVALID_CURSOR'],
        ['since after until', { addresses: [ADDRESSES[0]], since: 10, until: 5 }, 'INVALID_RANGE'],
        ['a malformed address', { addresses: ['1' + 'A'.repeat(33)] }, 'INVALID_ADDRESS']
    ]){
        it('refuses ' + label + ' with 400 ' + code + ' before any statement', async () => {
            const res = await post(body);
            expect(res.code).to.equal(400);
            expect(res.body.code).to.equal(code);
            expect(seen).to.have.length(0);
        });
    }

    it('answers 503 COIN_DATA_STALE for a stale tip under fail-closed, with the freshness headers', async () => {
        sinon.restore();
        ({ explorer, seen } = buildExplorer(sqlite, { stale: true, failClosed: true }));
        historyRoute = routeHandler('post', '/:coin/api/history');
        const res = await post({ addresses: [ADDRESSES[0]] });
        expect(res.code).to.equal(503);
        expect(res.body.code).to.equal('COIN_DATA_STALE');
        expect(res.headers['XChain-Freshness']).to.equal('stale');
        expect(seen).to.have.length(0);
    });

    it('answers 503 COIN_NOT_AVAILABLE for a coin this instance does not serve', async () => {
        const res = await drive(historyRoute, { params: { coin: 'TBTC' }, body: { addresses: [ADDRESSES[0]] } });
        expect(res.code).to.equal(503);
        expect(res.body.code).to.equal('COIN_NOT_AVAILABLE');
    });
});
