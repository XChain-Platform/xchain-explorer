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
 * Additional unit tests for uncovered methods in src/db/index.js
 *
 * Covers (SQL-builder methods, return [query, args, count]):
 *   - getCoinpays, getCoinpayExpires, getCoinpayObligations
 *   - getMarkets, getMarket, getMarketOrders, getMarketHistory, getOrderbook
 *   - getActions, getAction, getBlocks
 *   - getSearch
 *   - getPublicKey, getTransactionData
 *   - getContracts, getContract, getContractState, getContractBalance
 *   - getExecutions, getExecution, getDeposits, getWithdrawals
 *   - getStakes, getValidators, getPrices, getPriceSnapshots, getDelegations
 *   - getValidatorRewards, getContractStakes, getContractUnstakes, getSlashEvents
 *   - getHistory
 *
 * Covers (helper/detail methods, stub doQuery):
 *   - getMaxBlockIndex, getMaxBlockTime, getMaxActionIndex
 *   - getGatedFileRaw, getBlocksSince, getActionsSince
 *   - getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo
 *   - getCoinpayObligation, getOrderMatchSettlement
 *   - getPublicKey, getTransactionData
 *   - getActionFeeData
 *   - getHistoryData (basic)
 *   - getActionSummaryData (basic pass-through)
 *
 * Covers (LRU cache helpers):
 *   - cacheGet, cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

const {
    Database,
    configInfo,
    sinon,
    expect,
    makeConfig,
    mockResults,
    makeDb,
    cfg,
    makeActionConfig,
    baseRow,
    stubForType
} = require('./helpers.js');

describe('Database#getActionSummaryData', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        // These cases stub getActionData to pin the projection loop, so the page-level
        // shared-leg prefetch has no reader; null is the "no preload" state getActionData
        // already handles. Its parity is covered against a real MariaDB in
        // test/integration/action-preload-parity.test.js.
        sinon.stub(db, 'buildActionPreload').resolves(null);
    });
    afterEach(() => { sinon.restore(); });

    it('returns the same array it was passed (pass-through)', async () => {
        sinon.stub(db, 'getActionData').resolves({ action: 'SEND', status: 'valid' });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result).to.equal(actions);
    });

    it('adds status to each action item', async () => {
        sinon.stub(db, 'getActionData').resolves({ action: 'SEND', status: 'valid' });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].status).to.equal('valid');
    });

    it('returns empty array when called with empty array', async () => {
        const result = await db.getActionSummaryData(cfg(), []);
        expect(result).to.deep.equal([]);
    });

    it('populates details.source for SEND actions', async () => {
        sinon.stub(db, 'getActionData').resolves({
            action: 'SEND',
            status: 'valid',
            sends: [{ source: 'addr1', destination: 'addr2', tick: 'XCHAIN', amount: '100', status: 'valid' }]
        });
        const actions = [{ action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc', tx_index: 1 }];
        const result = await db.getActionSummaryData(cfg(), actions);
        expect(result[0].details).to.have.property('source', 'addr1');
    });
});

describe('Database#getMaxBlockIndex', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the max block_index number when row found', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: 850000 }]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(850000);
    });

    it('returns 0 when no blocks found (max_index is null)', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(0);
    });

    it('returns 0 when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxBlockIndex(cfg())).to.equal(0);
    });
});

describe('Database#getMaxBlockTime', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns the block_time number when row found', async () => {
        sinon.stub(db, 'doQuery').resolves([{ block_time: 1700000000 }]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(1700000000);
    });

    it('returns 0 when block_time is null', async () => {
        sinon.stub(db, 'doQuery').resolves([{ block_time: null }]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(0);
    });

    it('returns 0 when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxBlockTime(cfg())).to.equal(0);
    });
});

describe('Database#getMaxActionIndex', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    // This value is the WebSocket live/catch-up cursor, so it answers in BigInt.
    // Number() collapsed two consecutive indices above 2^53 onto one value and
    // the poll loop then stalled or skipped a NEW_ACTION frame.
    it('returns the max action_index as an exact BigInt', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: 99999 }]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(99999n);
    });

    it('keeps an above-2^53 max_index exact instead of rounding it', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: '9007199254740995' }]);
        const max = await db.getMaxActionIndex(cfg());
        expect(max).to.equal(9007199254740995n);
        expect(String(max)).to.equal('9007199254740995');
    });

    it('returns 0n when max_index is null', async () => {
        sinon.stub(db, 'doQuery').resolves([{ max_index: null }]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(0n);
    });

    it('returns 0n when doQuery returns empty', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getMaxActionIndex(cfg())).to.equal(0n);
    });
});

describe('Database#getGatedFileRaw', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('returns result from doQuery', async () => {
        sinon.stub(db, 'doQuery').resolves([{ raw_data: Buffer.from('hello') }]);
        const result = await db.getGatedFileRaw(cfg(), 42);
        expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('returns [] (falsy from doQuery) when no row found', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getGatedFileRaw(cfg(), 999);
        expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('passes actionIndex as a Number arg', async () => {
        let capturedArgs = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { capturedArgs = a; return []; });
        await db.getGatedFileRaw(cfg(), '42');
        expect(capturedArgs).to.deep.equal([42]);
    });
});

// Non-gated FILE bytes read from the colocated decoder DB.
describe('Database#getFileRaw', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.decoderDb = { BTC: 'XChain_Decoder_BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('returns raw bytes + declared MIME type + the stored action string when the decoder row matches by hash', async () => {
        const bytes = Buffer.from('png-bytes');
        const action = 'FILE|0|logo.png|image/png|Logo|';
        const stub  = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ hash: 'abc123', type: 'image/png' }]);
        stub.onSecondCall().resolves([{ raw_data: bytes, data: action }]);
        const result = await db.getFileRaw(cfg(), 42);
        // `data` carries the FULL stored ACTION string so the serve path can
        // derive the trailing COMPRESSION field at serve time rather than
        // trusting a parsed-at-ingest column.
        expect(result).to.deep.equal({ raw_data: bytes, type: 'image/png', data: action });
        // The decoder read must be database-qualified and matched by tx HASH
        // (tx ids are numbered independently per DB and cannot be joined)
        const [, decoderQuery, decoderArgs] = stub.secondCall.args;
        expect(decoderQuery).to.include('`XChain_Decoder_BTC`.transactions');
        expect(decoderQuery).to.include('`XChain_Decoder_BTC`.index_transactions');
        expect(decoderQuery).to.include('t1.data');
        expect(decoderArgs).to.deep.equal(['abc123']);
    });

    it('returns null when the FILE action is unknown', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getFileRaw(cfg(), 999)).to.equal(null);
    });

    it('returns null when no decoder DB is configured for the coin', async () => {
        db.decoderDb = {};
        sinon.stub(db, 'doQuery').resolves([{ hash: 'abc123', type: 'image/png' }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });

    it('returns null when the decoder DB name fails the identifier guard', async () => {
        db.decoderDb = { BTC: 'bad`name; DROP' };
        sinon.stub(db, 'doQuery').resolves([{ hash: 'abc123', type: 'image/png' }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });

    it('returns null when the decoder row has no stored bytes', async () => {
        const stub = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ hash: 'abc123', type: 'image/png' }]);
        stub.onSecondCall().resolves([{ raw_data: null }]);
        expect(await db.getFileRaw(cfg(), 42)).to.equal(null);
    });
});

// Project registry queries (protocol/project-registry.md).
describe('Database#getProjectRosterInfo', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('resolves the latest owner-valid roster link + item count', async () => {
        const stub = sinon.stub(db, 'doQuery');
        stub.onFirstCall().resolves([{ link_action_index: 74, roster_action_index: 73 }]);
        stub.onSecondCall().resolves([{ total: 2 }]);
        // Edit resolution off: the pinned index IS the membership index (the armed
        // case is covered in db_list_edit_resolution.test.js).
        sinon.stub(db, 'isListEditResolutionActiveAtTip').resolves(false);
        const info = await db.getProjectRosterInfo(cfg(), 'PROJECTX');
        expect(info).to.deep.equal({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 2 });
        // The roster query must filter to the LOCAL chain on BOTH link sides and
        // to valid TICK-type lists, newest link first
        const [, query, args] = stub.firstCall.args;
        expect(query).to.include("ls.type='1'");
        expect(query).to.include('ORDER BY l.action_index DESC');
        expect(args).to.deep.equal(['BTC', 'BTC', 'PROJECTX']);
    });

    it('returns null when no roster link exists', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getProjectRosterInfo(cfg(), 'PROJECTX')).to.equal(null);
    });

    it('returns null when the base chain for the coin key is unknown', async () => {
        db.baseCoin = {};
        sinon.stub(db, 'doQuery').resolves([{ link_action_index: 1, roster_action_index: 1 }]);
        expect(await db.getProjectRosterInfo(cfg(), 'PROJECTX')).to.equal(null);
    });
});

describe('Database#getTokenProjects', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    // Edit resolution off: the single-query legacy form runs, and the pinned
    // index IS the membership index (the armed, two-phase path is covered in
    // db_list_edit_resolution.test.js).
    beforeEach(() => { sinon.stub(Database.prototype, 'isListEditResolutionActiveAtTip').resolves(false); });

    it('returns normalized membership rows', async () => {
        sinon.stub(db, 'doQuery').resolves([{ project: 'PROJECTX', link_action_index: 74n, roster_action_index: 73n }]);
        const rows = await db.getTokenProjects(cfg(), 'TOKENONE');
        expect(rows).to.deep.equal([{ project: 'PROJECTX', link_action_index: 74, roster_action_index: 73, membership_action_index: 73 }]);
    });

    it('returns [] for a token on no current roster', async () => {
        sinon.stub(db, 'doQuery').resolves([]);
        expect(await db.getTokenProjects(cfg(), 'LONER')).to.deep.equal([]);
    });

    it('matches the CURRENT roster only (latest link per project)', async () => {
        const stub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getTokenProjects(cfg(), 'TOKENONE');
        const [, query] = stub.firstCall.args;
        expect(query).to.include('MAX(l.action_index)');
        expect(query).to.include('GROUP BY i1.tick_id');
    });
});

describe('Database#getProject', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('returns [null] when the tick has no roster (→ 400 at the API layer)', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves(null);
        const [data] = await db.getProject(makeActionConfig('getProject', 'token'));
        expect(data).to.equal(null);
    });

    it('returns project + member rows when a roster exists', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 1 });
        sinon.stub(db, 'doQuery').resolves([{ tick: 'TOKENONE', supply: '1', max_supply: '1', decimals: 0, lock_max_supply: 1 }]);
        const config = makeActionConfig('getProject', 'token');
        config.data.search = 'PROJECTX';
        const [data] = await db.getProject(config);
        expect(data.tick).to.equal('PROJECTX');
        expect(data.roster_action_index).to.equal(73);
        expect(data.members).to.have.length(1);
        expect(data.members[0].tick).to.equal('TOKENONE');
    });

    it('echoes a mixed-case tick unchanged, so the value round-trips as a URL', async () => {
        // Uppercasing the echo while the lookup stays case-sensitive makes the tick
        // handed back 404 when fed into /api/project/{TICK} for any tick that is not
        // already all upper case.
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 0 });
        sinon.stub(db, 'doQuery').resolves([]);
        const config = makeActionConfig('getProject', 'token');
        config.data.search = 'XCPROJ819a01';
        const [data] = await db.getProject(config);
        expect(data.tick).to.equal('XCPROJ819a01');
    });
});

describe('Database#getProjectTokens', () => {
    let db;
    beforeEach(() => {
        db = makeDb();
        db.baseCoin = { BTC: 'BTC' };
    });
    afterEach(() => { sinon.restore(); });

    it('short-circuits to an empty datatable when no roster exists', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves(null);
        const [query, args, count] = await db.getProjectTokens(makeActionConfig('getProjectTokens', 'roster'));
        expect(query).to.deep.equal([]);
        expect(count).to.equal(0);
    });

    it('builds a token-shaped query scoped to the roster list_items', async () => {
        sinon.stub(db, 'getProjectRosterInfo').resolves({ roster_action_index: 73, membership_action_index: 73, link_action_index: 74, total: 2 });
        const [query, args, count] = await db.getProjectTokens(makeActionConfig('getProjectTokens', 'roster'));
        expect(query).to.include('list_items');
        expect(query).to.include('li.action_index=?');
        expect(args).to.deep.equal([73]);
        expect(count).to.include('count(*)');
    });
});
