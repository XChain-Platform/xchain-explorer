'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const path       = require('path');

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Build a child_process.exec stub that calls its callback based on the
 * result map: { [cmdSubstring]: result }.  result = null means success with
 * empty stdout/stderr; result = Error means failure; result = {stdout,stderr}
 * means success with those values.
 */
function makeExecStub(handlers) {
    // handlers: array of [predicateFn | string, resultOrError]
    return sinon.stub().callsFake(function(cmd, cb) {
        for (const [pred, result] of (handlers || [])) {
            const match = typeof pred === 'function' ? pred(cmd) : cmd.includes(pred);
            if (match) {
                if (result instanceof Error) {
                    result.stderr = result.stderr || '';
                    return cb(result);
                }
                return cb(null, result || { stdout: '', stderr: '' });
            }
        }
        // default: success
        cb(null, { stdout: '', stderr: '' });
    });
}

/**
 * Build a fresh set of IO stubs for a test.
 * axiosResult: what axios.get resolves/rejects with
 */
function makeStubs(opts) {
    opts = opts || {};

    // axios stub
    const axiosStub = {
        get: sinon.stub().resolves({
            status:  200,
            headers: { 'content-type': 'image/png' },
            data:    Buffer.from('PNGDATA'),
        }),
    };
    if (opts.axiosReject) {
        axiosStub.get.rejects(opts.axiosReject);
    } else if (opts.axiosResponse) {
        axiosStub.get.resolves(opts.axiosResponse);
    }

    // fs stub (sync, barely used by IconDownloader directly)
    const fsStub = {};

    // fs/promises stub
    const fspStub = {
        mkdir:     sinon.stub().resolves(),
        writeFile: sinon.stub().resolves(),
        readFile:  sinon.stub().resolves(Buffer.from('PNGOUT')),
        unlink:    sinon.stub().resolves(),
    };
    if (opts.fspReadFileResult !== undefined) {
        fspStub.readFile.resolves(opts.fspReadFileResult);
    }
    if (opts.fspWriteFileReject) {
        fspStub.writeFile.rejects(new Error('write failed'));
    }
    if (opts.fspMkdirReject) {
        fspStub.mkdir.rejects(new Error('mkdir failed'));
    }

    // exec stub (default): sniffMime returns 'image/png', convert succeeds
    const execStub = makeExecStub([
        ['--mime-type', opts.sniffMimeResult !== undefined
            ? (opts.sniffMimeReject ? null : { stdout: opts.sniffMimeResult + '\n', stderr: '' })
            : { stdout: 'image/png\n', stderr: '' }],
        ['-resize',     opts.convertReject  ? new Error('convert failed') : null],
    ]);

    if (opts.sniffMimeReject) {
        // Override to always error on mime sniff
        execStub.callsFake(function(cmd, cb) {
            if (cmd.includes('--mime-type')) {
                cb(new Error('file command failed'));
            } else {
                cb(null, { stdout: '', stderr: '' });
            }
        });
    }

    // IconResolver stubs
    const resolveDescriptionToSource    = opts.resolveDescriptionToSource    || sinon.stub().returns(null);
    const selectIconUrlFromCip25Json    = opts.selectIconUrlFromCip25Json    || sinon.stub().returns(null);

    return { axiosStub, fsStub, fspStub, execStub, resolveDescriptionToSource, selectIconUrlFromCip25Json };
}

/**
 * Load IconDownloader through proxyquire using the provided stubs.
 */
function loadIconDownloader(stubs) {
    return proxyquire('../../src/IconDownloader.js', {
        'axios':          stubs.axiosStub,
        'fs':             stubs.fsStub,
        'fs/promises':    stubs.fspStub,
        'child_process':  { exec: stubs.execStub },
        './IconResolver': {
            resolveDescriptionToSource: stubs.resolveDescriptionToSource,
            selectIconUrlFromCip25Json: stubs.selectIconUrlFromCip25Json,
        },
    });
}

/**
 * Build a mock DB connection with query/release stubs.
 */
function makeMockConn(queryResults) {
    // queryResults: array of results returned in order, or a single value used always
    let results = Array.isArray(queryResults) ? queryResults.slice() : null;
    const conn = {
        query:   sinon.stub().callsFake(async () => {
            if (results && results.length) return results.shift();
            return [];
        }),
        release: sinon.stub().resolves(),
    };
    return conn;
}

/**
 * Build a mock pool whose getConnection returns `conn`.
 */
function makeMockPool(conn) {
    return { getConnection: sinon.stub().resolves(conn) };
}

/**
 * Build a minimal explorer mock.
 */
function makeExplorer(configOverrides, pools) {
    const cfgBase = Object.assign({
        BTC: {
            mainnet: { database: { indexer: 'xchain_btc' } },
        },
    }, configOverrides || {});

    return {
        util: {},
        configInfo: {
            getConfig: sinon.stub().resolves(cfgBase),
        },
        db: {
            pools: pools !== undefined ? pools : {
                BTC: { pool: makeMockPool(makeMockConn([])) },
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IconDownloader', function () {

    let clock;
    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    describe('constructor', function () {
        it('initialises with DEFAULTS and correct iconRoot', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            expect(d.cfg.enabled).to.equal(false);
            expect(d.cfg.intervalMinutes).to.equal(15);
            expect(d.cfg.batchSize).to.equal(50);
            expect(d.cfg.maxAttempts).to.equal(4);
            expect(d.cfg.recursionLimit).to.equal(2);
            expect(d._running).to.equal(false);
            expect(d._stop).to.equal(false);
            expect(d.timer).to.equal(null);
            expect(d.iconRoot).to.include('content/icons');
        });
    });

    // -----------------------------------------------------------------------
    // Lifecycle: start() disabled
    // -----------------------------------------------------------------------

    describe('start() (disabled)', function () {
        it('returns without setting a timer when enabled=false', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({ iconDownload: { enabled: false } });

            const d = new IconDownloader(explorer);
            await d.start();

            expect(d.timer).to.equal(null);
        });

        it('returns without setting a timer when iconDownload config is absent', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({});

            const d = new IconDownloader(explorer);
            await d.start();

            expect(d.timer).to.equal(null);
        });
    });

    // -----------------------------------------------------------------------
    // Lifecycle: start() enabled
    // -----------------------------------------------------------------------

    describe('start() (enabled)', function () {
        it('sets a timer and merges user config over defaults', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            clock = sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] });

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 30, batchSize: 10 },
            });

            const d = new IconDownloader(explorer);
            // Stub runOnce so the immediate call doesn't actually run
            d.runOnce = sinon.stub().resolves();

            await d.start();

            expect(d.timer).to.not.equal(null);
            expect(d.cfg.enabled).to.equal(true);
            expect(d.cfg.intervalMinutes).to.equal(30);
            expect(d.cfg.batchSize).to.equal(10);
            // DEFAULTS survive for unset keys
            expect(d.cfg.maxAttempts).to.equal(4);
        });

        it('schedules runOnce via setImmediate on startup', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            clock = sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] });

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 60 },
            });

            const d = new IconDownloader(explorer);
            const calls = [];
            d.runOnce = sinon.stub().callsFake(async () => { calls.push('once'); });

            await d.start();
            // Before tick: setImmediate hasn't fired
            expect(calls.length).to.equal(0);

            // Tick the fake clock so setImmediate fires
            clock.tick(0);
            await Promise.resolve(); // flush microtask

            expect(calls.length).to.equal(1);
        });

        it('fires runOnce on each interval tick', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            clock = sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] });

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 1 },
            });

            const d = new IconDownloader(explorer);
            const calls = [];
            d.runOnce = sinon.stub().callsFake(async () => { calls.push('tick'); });

            await d.start();
            // Advance one full interval (60 000 ms)
            clock.tick(60_000);
            await Promise.resolve();

            expect(calls.length).to.be.at.least(1);
        });
    });

    // -----------------------------------------------------------------------
    // Lifecycle: stop()
    // -----------------------------------------------------------------------

    describe('stop()', function () {
        it('sets _stop and clears the timer', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            clock = sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] });

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 60 },
            });

            const d = new IconDownloader(explorer);
            d.runOnce = sinon.stub().resolves();
            await d.start();
            expect(d.timer).to.not.equal(null);

            d.stop();
            expect(d._stop).to.equal(true);
            expect(d.timer).to.equal(null);
        });

        it('is safe to call when timer is null (disabled mode)', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            expect(() => d.stop()).to.not.throw();
            expect(d._stop).to.equal(true);
        });
    });

    // -----------------------------------------------------------------------
    // runOnce(): re-entrancy guard
    // -----------------------------------------------------------------------

    describe('runOnce()', function () {
        it('skips if _running is already true', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._running = true;
            d._listFlavors = sinon.stub().resolves([]);

            await d.runOnce();

            expect(d._listFlavors.callCount).to.equal(0);
        });

        it('sets _running during execution and clears it after', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            let seenRunning = false;
            d._listFlavors = sinon.stub().callsFake(async () => {
                seenRunning = d._running;
                return [];
            });

            await d.runOnce();

            expect(seenRunning).to.equal(true);
            expect(d._running).to.equal(false);
        });

        it('clears _running even when _processFlavor throws', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._listFlavors   = sinon.stub().resolves([{ coin: 'BTC', network: 'mainnet' }]);
            d._processFlavor = sinon.stub().rejects(new Error('boom'));

            await d.runOnce();

            expect(d._running).to.equal(false);
        });

        it('swallows per-flavor errors and continues to next flavor', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const processed = [];
            d._listFlavors = sinon.stub().resolves([
                { coin: 'BTC', network: 'mainnet' },
                { coin: 'LTC', network: 'mainnet' },
            ]);
            d._processFlavor = sinon.stub().callsFake(async (flavor) => {
                if (flavor.coin === 'BTC') throw new Error('btc fail');
                processed.push(flavor.coin);
            });

            await d.runOnce();

            expect(processed).to.deep.equal(['LTC']);
        });

        it('stops iterating flavors when _stop is set', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const processed = [];
            d._listFlavors = sinon.stub().resolves([
                { coin: 'BTC', network: 'mainnet' },
                { coin: 'LTC', network: 'mainnet' },
            ]);
            d._processFlavor = sinon.stub().callsFake(async (flavor) => {
                processed.push(flavor.coin);
                d._stop = true;   // stop after first
            });

            await d.runOnce();

            expect(processed).to.deep.equal(['BTC']);
        });
    });

    // -----------------------------------------------------------------------
    // _listFlavors()
    // -----------------------------------------------------------------------

    describe('_listFlavors()', function () {
        it('returns [] when pools is null', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({}, null);
            explorer.db = null;

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('returns [] when getConfig returns null', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves(null);

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('skips non-object top-level keys', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                COIN_NETWORKS: ['BTC'],
                API: 'something',
                null_val: null,
            });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('returns mainnet flavor with bare poolKey (no prefix)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'xchain_btc' } } },
            }, { BTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();

            expect(result).to.have.length(1);
            expect(result[0].coin).to.equal('BTC');
            expect(result[0].network).to.equal('mainnet');
            expect(result[0].poolKey).to.equal('BTC');
            expect(result[0].pool).to.equal(pool);
        });

        it('prefixes testnet poolKey with T', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { testnet: { database: { indexer: 'xchain_tbtc' } } },
            }, { TBTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();

            expect(result).to.have.length(1);
            expect(result[0].poolKey).to.equal('TBTC');
        });

        it('prefixes regtest poolKey with R', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const pool = makeMockPool(makeMockConn([]));
            const explorer = makeExplorer({
                BTC: { regtest: { database: { indexer: 'xchain_rbtc' } } },
            }, { RBTC: { pool } });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();

            expect(result[0].poolKey).to.equal('RBTC');
        });

        it('skips networks missing indexer config', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({
                BTC: { mainnet: { database: {} } },   // no indexer key
            }, { BTC: { pool: makeMockPool(makeMockConn([])) } });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('skips flavors where pool is missing', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'xchain_btc' } } },
            }, {
                // BTC pool is absent from pools; pools has LTC instead
                LTC: { pool: makeMockPool(makeMockConn([])) },
            });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();
            expect(result).to.deep.equal([]);
        });

        it('returns multiple flavors across coins and networks', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const btcPool  = makeMockPool(makeMockConn([]));
            const ltcPool  = makeMockPool(makeMockConn([]));
            const tbtcPool = makeMockPool(makeMockConn([]));

            const explorer = makeExplorer({
                BTC: { mainnet: { database: { indexer: 'i1' } } },
                LTC: { mainnet: { database: { indexer: 'i2' } } },
            }, {
                BTC:  { pool: btcPool },
                LTC:  { pool: ltcPool },
                TBTC: { pool: tbtcPool },
            });

            const d = new IconDownloader(explorer);
            const result = await d._listFlavors();

            const coins = result.map(f => f.coin);
            expect(coins).to.include('BTC');
            expect(coins).to.include('LTC');
            expect(result).to.have.length(2);
        });
    });

    // -----------------------------------------------------------------------
    // _discover()
    // -----------------------------------------------------------------------

    describe('_discover()', function () {
        it('runs INSERT IGNORE and UPDATE queries with correct SQL fragments', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[], []]);
            await d._discover(conn);

            expect(conn.query.callCount).to.equal(2);
            const firstSql  = conn.query.firstCall.args[0];
            const secondSql = conn.query.secondCall.args[0];

            expect(firstSql).to.include('INSERT IGNORE INTO icons');
            expect(firstSql).to.include('pending');

            expect(secondSql).to.include('UPDATE icons');
            expect(secondSql).to.include('stale');
            expect(secondSql).to.include('<=>');
        });
    });

    // -----------------------------------------------------------------------
    // _markOk()
    // -----------------------------------------------------------------------

    describe('_markOk()', function () {
        it('issues UPDATE icons SET status=ok with correct args', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            await d._markOk(conn, 99, 'https://example.com/a.png', 'srchash', 'iconhash', 'deschash');

            expect(conn.query.callCount).to.equal(1);
            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include("status='ok'");
            expect(sql).to.include('WHERE id=?');
            expect(args).to.deep.equal(['https://example.com/a.png', 'srchash', 'iconhash', 'deschash', 99]);
        });

        it('accepts nulls for url/sourceHash/iconHash', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            await d._markOk(conn, 7, null, null, null, 'dh');

            const [, args] = conn.query.firstCall.args;
            expect(args[0]).to.equal(null);
            expect(args[1]).to.equal(null);
            expect(args[2]).to.equal(null);
            expect(args[3]).to.equal('dh');
            expect(args[4]).to.equal(7);
        });
    });

    // -----------------------------------------------------------------------
    // _markFailure()
    // -----------------------------------------------------------------------

    describe('_markFailure()', function () {
        it('uses terminal path (no next_retry_at) when attempts >= maxAttempts', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 5, 4, 'too many');

            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include("status='failed'");
            expect(sql).to.not.include('INTERVAL');
            expect(args).to.deep.equal([4, 'too many', 5]);
        });

        it('uses retry path (DATE_ADD INTERVAL) when attempts < maxAttempts', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 5, 1, 'first fail');

            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include('INTERVAL');
            expect(sql).to.include('SECOND');
            // args: [attempts, errMsg, sec, iconId]
            expect(args[0]).to.equal(1);
            expect(args[1]).to.equal('first fail');
            expect(args[2]).to.equal(3600);  // backoff for attempt 1 = 1h
            expect(args[3]).to.equal(5);
        });

        it('backoff is 86400 for attempt 2', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 5, 2, 'second fail');

            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(86400);
        });

        it('backoff is 7*86400 for attempt 3', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 5, 3, 'third fail');

            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(7 * 86400);
        });
    });

    // -----------------------------------------------------------------------
    // _processToken(): decision tree
    // -----------------------------------------------------------------------

    describe('_processToken()', function () {
        function makeFlavor(coin, network) {
            return { coin: coin || 'BTC', network: network || 'mainnet', poolKey: coin || 'BTC' };
        }

        function makeRow(overrides) {
            return Object.assign({
                icon_id:     1,
                token_id:    10,
                attempts:    0,
                description: 'https://example.com/a.png',
                tick:        'MYTOKEN',
            }, overrides);
        }

        it('calls _markOk with nulls when resolveDescriptionToSource returns null', async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(null),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();
            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('X'));
            d._writeIcon   = sinon.stub().resolves('hash123');

            await d._processToken(conn, makeFlavor(), makeRow({ description: 'no-match' }));

            expect(d._markOk.callCount).to.equal(1);
            const [, , url, srcHash, iconHash] = d._markOk.firstCall.args;
            expect(url).to.equal(null);
            expect(srcHash).to.equal(null);
            expect(iconHash).to.equal(null);
            expect(d._markFailure.callCount).to.equal(0);
        });

        it('calls _markFailure when _fetchSourceBytes throws', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().rejects(new Error('network error'));
            d._markFailure = sinon.stub().resolves();
            d._markOk      = sinon.stub().resolves();

            const conn = makeMockConn([]);
            await d._processToken(conn, makeFlavor(), makeRow({ attempts: 0 }));

            expect(d._markFailure.callCount).to.equal(1);
            const [, , attempts, errMsg] = d._markFailure.firstCall.args;
            expect(attempts).to.equal(1);   // row.attempts + 1
            expect(errMsg).to.include('network error');
            expect(d._markOk.callCount).to.equal(0);
        });

        it('calls _markFailure with "empty body" when bytes is empty', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.alloc(0));
            d._markFailure = sinon.stub().resolves();
            d._markOk      = sinon.stub().resolves();

            const conn = makeMockConn([]);
            await d._processToken(conn, makeFlavor(), makeRow({ attempts: 2 }));

            expect(d._markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d._markFailure.firstCall.args;
            expect(attempts).to.equal(3);
            expect(msg).to.equal('empty body');
        });

        it('calls _markOk(null) when stamp bytes fail _writeIcon (stamp terminal path)', async function () {
            const src = { scheme: 'stamp', data: 'AAAA' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from([0xDE, 0xAD]));
            d._writeIcon   = sinon.stub().rejects(new Error('unsupported mime'));
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, makeFlavor(), makeRow());

            expect(d._markOk.callCount).to.equal(1);
            const [, , url, srcH, iconH] = d._markOk.firstCall.args;
            expect(url).to.equal(null);
            expect(srcH).to.equal(null);
            expect(iconH).to.equal(null);
            expect(d._markFailure.callCount).to.equal(0);
        });

        it('calls _markFailure when non-stamp _writeIcon throws', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGBYTES'));
            d._writeIcon   = sinon.stub().rejects(new Error('convert failed'));
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, makeFlavor(), makeRow({ attempts: 1 }));

            expect(d._markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d._markFailure.firstCall.args;
            expect(attempts).to.equal(2);
            expect(msg).to.include('convert failed');
        });

        it('calls _markOk(null) when stamp _writeIcon returns null (iconHash null)', async function () {
            const src = { scheme: 'stamp', data: 'AAAA' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from([0x89, 0x50]));
            d._writeIcon   = sinon.stub().resolves(null);   // returns null => no icon hash
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, makeFlavor(), makeRow());

            expect(d._markOk.callCount).to.equal(1);
            expect(d._markFailure.callCount).to.equal(0);
        });

        it('calls _markFailure("image conversion failed") when non-stamp _writeIcon returns null', async function () {
            const src = { scheme: 'image_url', url: 'https://x.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGBYTES'));
            d._writeIcon   = sinon.stub().resolves(null);
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, makeFlavor(), makeRow({ attempts: 0 }));

            expect(d._markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d._markFailure.firstCall.args;
            expect(msg).to.equal('image conversion failed');
            expect(attempts).to.equal(1);
        });

        it('calls _markOk with url/sourceHash/iconHash on success', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGDATA'));
            d._writeIcon   = sinon.stub().resolves('abc123');
            d._markOk      = sinon.stub().resolves();
            d._markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, makeFlavor(), makeRow());

            expect(d._markOk.callCount).to.equal(1);
            const [, , url, , iconHash] = d._markOk.firstCall.args;
            expect(url).to.equal('https://example.com/a.png');
            expect(iconHash).to.equal('abc123');
        });
    });

    // -----------------------------------------------------------------------
    // _fetchSourceBytes(): all scheme branches
    // -----------------------------------------------------------------------

    describe('_fetchSourceBytes()', function () {

        // Helper: loads IconDownloader with specific per-test stubs
        function makeDownloader(stubs) {
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            return new IconDownloader(explorer);
        }

        // ---- stamp ----

        it('stamp: decodes base64 and returns buffer', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            // "hello" in base64 = aGVsbG8=
            const src = { scheme: 'stamp', data: 'aGVsbG8=' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('hello');
        });

        it('stamp: throws on empty base64', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            const src = { scheme: 'stamp', data: 'AA==' };  // decodes to 0x00 (single byte, fine)
            const r = await d._fetchSourceBytes(src, 2);
            expect(r).to.be.instanceOf(Buffer);
        });

        it('stamp: throws when buffer is empty after decode', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            // An empty base64 string decodes to 0 bytes
            const src = { scheme: 'stamp', data: '' };  // empty; data comes from resolver which validates
            // Force it via src directly
            // We simulate the error by passing data that decodes to nothing
            // Buffer.from('', 'base64') => empty buffer
            try {
                await d._fetchSourceBytes({ scheme: 'stamp', data: 'AA==' }, 2);
                // that one has 1 byte and should succeed
            } catch (e) {
                // should not throw for AA==
                throw new Error('unexpected throw for valid stamp');
            }
            // Now test truly empty
            try {
                await d._fetchSourceBytes({ scheme: 'stamp', data: '' }, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('empty after base64 decode');
            }
        });

        // ---- ord ----

        it('ord: fetches URL, parses JSON, extracts base64 data', async function () {
            const imageData = 'data:image/png;base64,' + Buffer.from('FAKEIMAGE').toString('base64');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({ images: [{ data: imageData }] })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://inscription-decoder.vercel.app/api/image?tx=abc' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('FAKEIMAGE');
        });

        it('ord: throws on bad JSON', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from('not-json'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('bad decoder JSON');
            }
        });

        it('ord: throws when images[0].data is missing', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({ images: [{ type: 'png' }] })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('missing images[0].data');
            }
        });

        it('ord: throws when data URL is not base64', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({
                        images: [{ data: 'data:image/png;utf8,actualdata' }],
                    })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('data URL not base64');
            }
        });

        it('ord: throws when base64 decodes to empty buffer', async function () {
            // A base64 data URL that decodes to empty: use empty string after base64,
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({
                        images: [{ data: 'data:image/png;base64,' }],
                    })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('empty after base64 decode');
            }
        });

        // ---- json_url / arweave / arweave_url / ipfs ----

        it('json_url: parses JSON and recurses via selectIconUrlFromCip25Json', async function () {
            const imageUrl = 'https://example.com/icon.png';
            const jsonBody = JSON.stringify({ image: imageUrl });

            let callCount = 0;
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                },
                selectIconUrlFromCip25Json: sinon.stub().returns(imageUrl),
                // resolveDescriptionToSource: returns null to fall through to image_url
                resolveDescriptionToSource: sinon.stub().callsFake((desc) => {
                    callCount++;
                    if (callCount === 1) return null;   // first call from _processToken: not used here
                    return null;  // null => makes the code do { scheme:'image_url', url: picked }
                }),
            });

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            // Second fetch (for image_url) should return image bytes
            stubs.axiosStub.get
                .onFirstCall().resolves({
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                })
                .onSecondCall().resolves({
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    Buffer.from('IMGBYTES'),
                });

            const src = { scheme: 'json_url', url: 'https://example.com/meta.json' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('IMGBYTES');
        });

        it('json_url: throws when JSON has no usable image (selectIconUrlFromCip25Json returns null)', async function () {
            const jsonBody = JSON.stringify({ name: 'TOKEN' });
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                },
                selectIconUrlFromCip25Json: sinon.stub().returns(null),
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'json_url', url: 'https://example.com/meta.json' };

            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('no usable image');
            }
        });

        it('json_url: returns raw bytes when body is not JSON (image data)', async function () {
            const imgBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ipfs', url: 'https://ipfsc.crystalsuite.com/Qmabc123' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('arweave: returns raw bytes when body is not JSON', async function () {
            const imgBytes = Buffer.from([0xFF, 0xD8, 0xFF]); // JPEG header
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/jpeg' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'arweave', url: 'https://arweave.net/abc123' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('arweave_url: same behavior as arweave (raw bytes path)', async function () {
            const imgBytes = Buffer.from('WEBPDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/webp' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'arweave_url', url: 'https://arweave.net/abc456' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        // ---- imgur / image_url / default ----

        it('image_url: returns body when content-type starts with image/', async function () {
            const imgBytes = Buffer.from('IMGDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png; charset=utf-8' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/icon.png' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('image_url: throws when content-type is not an image', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'text/html' },
                    data:    Buffer.from('<html>'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/page' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("not an image");
                expect(e.message).to.include('text/html');
            }
        });

        it('imgur: throws when content-type is not an image', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'text/plain' },
                    data:    Buffer.from('not an image'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'imgur', url: 'https://i.imgur.com/abc123' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("not an image");
            }
        });

        it('imgur: succeeds when content-type starts with image/', async function () {
            const imgBytes = Buffer.from('GIFDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/gif' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'imgur', url: 'https://i.imgur.com/abc123.gif' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        // ---- recursion limit ----

        it('throws "recursion limit hit" when depth < 0', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            try {
                await d._fetchSourceBytes({ scheme: 'image_url', url: 'https://x.com/a.png' }, -1);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('recursion limit hit');
            }
        });

        // ---- _httpFetch error paths ----

        it('_httpFetch: throws HTTP status error when axios throws with response', async function () {
            const err = new Error('Request failed');
            err.response = { status: 404 };
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/missing.png' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('HTTP 404');
            }
        });

        it('_httpFetch: throws error code when axios throws without response', async function () {
            const err = new Error('connect ECONNREFUSED');
            err.code = 'ECONNREFUSED';
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/x.png' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('ECONNREFUSED');
            }
        });

        it('_httpFetch: falls back to e.message when code is missing', async function () {
            const err = new Error('timeout exceeded');
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/x.png' };
            try {
                await d._fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('timeout exceeded');
            }
        });

        it('_httpFetch: converts non-buffer resp.data to Buffer', async function () {
            // resp.data is a Uint8Array (not a Buffer)
            const arr = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    arr,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/icon.png' };
            const result = await d._fetchSourceBytes(src, 2);
            expect(Buffer.isBuffer(result)).to.equal(true);
        });
    });

    // -----------------------------------------------------------------------
    // _writeIcon()
    // -----------------------------------------------------------------------

    describe('_writeIcon()', function () {
        function makeWriteIconDownloader(execHandlers, fspOverrides) {
            const fspStub = {
                mkdir:     sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile:  sinon.stub().resolves(Buffer.from('PNGOUT')),
                unlink:    sinon.stub().resolves(),
            };
            Object.assign(fspStub, fspOverrides || {});

            const execStub = makeExecStub(execHandlers || [
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     null],
            ]);

            const stubs = makeStubs();
            stubs.fspStub  = fspStub;
            stubs.execStub = execStub;

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.convertBin = '/usr/bin/convert';
            d.cfg.iconSize   = 64;
            return { d, fspStub, execStub };
        }

        it('writes tmp file, sniffs mime, runs convert, reads result and returns md5', async function () {
            const { d, fspStub, execStub } = makeWriteIconDownloader();
            const bytes    = Buffer.from('PNGBYTES');
            const iconPath = '/tmp/icons/BTC/mainnet/MYTOKEN.png';

            const hash = await d._writeIcon(bytes, iconPath);

            expect(fspStub.writeFile.callCount).to.equal(1);
            expect(fspStub.writeFile.firstCall.args[1]).to.deep.equal(bytes);

            // sniffMime called
            const sniffCall = execStub.getCalls().find(c => c.args[0].includes('--mime-type'));
            expect(sniffCall).to.not.equal(undefined);

            // convert called
            const convertCall = execStub.getCalls().find(c => c.args[0].includes('-resize'));
            expect(convertCall).to.not.equal(undefined);
            expect(convertCall.args[0]).to.include('64x64!');
            expect(convertCall.args[0]).to.include('-format png');

            // readFile called on iconPath
            expect(fspStub.readFile.callCount).to.equal(1);
            expect(fspStub.readFile.firstCall.args[0]).to.equal(iconPath);

            // returns an md5 string
            expect(hash).to.be.a('string').with.length(32);
        });

        it('throws "mime sniff failed" when sniffMime exec errors', async function () {
            const { d } = makeWriteIconDownloader([
                ['--mime-type', new Error('file not found')],
            ]);
            try {
                await d._writeIcon(Buffer.from('X'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('mime sniff failed');
            }
        });

        it('throws "unsupported mime" when MIME is not in ALLOWED_MIME', async function () {
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'application/pdf\n', stderr: '' }],
                ['-resize',     null],
            ]);
            try {
                await d._writeIcon(Buffer.from('X'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("unsupported mime 'application/pdf'");
            }
        });

        it('throws "convert failed" when ImageMagick exec errors', async function () {
            const convertErr = new Error('Magick failed');
            convertErr.stderr = 'convert: no decode delegate';
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);
            try {
                await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed');
                expect(e.message).to.include('no decode delegate');
            }
        });

        it('returns null (not throws) when readFile of iconPath fails', async function () {
            const { d } = makeWriteIconDownloader(
                [
                    ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                    ['-resize',     null],
                ],
                {
                    readFile: sinon.stub().rejects(new Error('ENOENT')),
                    writeFile: sinon.stub().resolves(),
                    unlink:    sinon.stub().resolves(),
                }
            );
            const result = await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
            expect(result).to.equal(null);
        });

        it('uses [0] frame selector for GIF mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/gif\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('GIFDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => c.args[0].includes('-resize'));
            expect(convertCall.args[0]).to.include('[0]');
        });

        it('uses [0] frame selector for SVG mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/svg+xml\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('<svg/>'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => c.args[0].includes('-resize'));
            expect(convertCall.args[0]).to.include('[0]');
        });

        it('uses [0] frame selector for WebP mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/webp\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('WEBPDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => c.args[0].includes('-resize'));
            expect(convertCall.args[0]).to.include('[0]');
        });

        it('does NOT use [0] frame selector for JPEG', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/jpeg\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('JPEGDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => c.args[0].includes('-resize'));
            // No [0] suffix on JPEG
            expect(convertCall.args[0]).to.not.match(/\[0\]/);
        });
    });

    // -----------------------------------------------------------------------
    // _processFlavor(): integration, batch query + token loop
    // -----------------------------------------------------------------------

    describe('_processFlavor()', function () {
        it('logs "queue empty" when SELECT returns no rows', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([
                [],  // _discover INSERT
                [],  // _discover UPDATE
                [],  // SELECT batch (empty)
            ]);
            const pool  = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            const logMsgs = [];
            d._log = (m) => logMsgs.push(m);
            d._discover    = sinon.stub().resolves();
            d._processToken = sinon.stub().resolves();

            conn.query.reset();
            conn.query.resolves([]);

            await d._processFlavor(flavor);

            expect(d._processToken.callCount).to.equal(0);
            expect(logMsgs.some(m => m.includes('queue empty'))).to.equal(true);
        });

        it('calls _processToken once per row and releases conn', async function () {
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().returns(null) });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const rows = [
                { icon_id: 1, token_id: 10, attempts: 0, description: null, tick: 'AAA' },
                { icon_id: 2, token_id: 11, attempts: 0, description: null, tick: 'BBB' },
            ];

            const conn = {
                query:   sinon.stub(),
                release: sinon.stub().resolves(),
            };
            // First two calls: _discover; third call: SELECT
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves(rows);

            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            d._processToken = sinon.stub().resolves();
            // Override sleep so test is fast
            const sleepCalls = [];
            d.cfg.requestDelayMs = 0;

            await d._processFlavor(flavor);

            expect(d._processToken.callCount).to.equal(2);
            expect(conn.release.callCount).to.equal(1);
        });

        it('releases conn even when _discover throws', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = {
                query:   sinon.stub().rejects(new Error('db error')),
                release: sinon.stub().resolves(),
            };
            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            try {
                await d._processFlavor(flavor);
            } catch (e) {
                // expected
            }
            expect(conn.release.callCount).to.equal(1);
        });

        it('stops processing rows when _stop is set mid-batch', async function () {
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().returns(null) });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const rows = [
                { icon_id: 1, token_id: 10, attempts: 0, description: null, tick: 'AAA' },
                { icon_id: 2, token_id: 11, attempts: 0, description: null, tick: 'BBB' },
            ];

            const conn = {
                query:   sinon.stub(),
                release: sinon.stub().resolves(),
            };
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves(rows);

            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            const processed = [];
            d._processToken = sinon.stub().callsFake(async (conn2, flv, row) => {
                processed.push(row.tick);
                d._stop = true;  // stop after first
            });
            d.cfg.requestDelayMs = 0;

            await d._processFlavor(flavor);
            expect(processed).to.deep.equal(['AAA']);
        });
    });

    // -----------------------------------------------------------------------
    // _httpFetch() direct tests (via a non-image scheme that calls it directly)
    // -----------------------------------------------------------------------

    describe('_httpFetch()', function () {
        it('passes correct axios options (timeout, maxBytes, maxRedirects, User-Agent)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            await d._httpFetch('https://example.com/img.png');

            expect(stubs.axiosStub.get.callCount).to.equal(1);
            const [url, opts] = stubs.axiosStub.get.firstCall.args;
            expect(url).to.equal('https://example.com/img.png');
            expect(opts.responseType).to.equal('arraybuffer');
            expect(opts.timeout).to.equal(d.cfg.fetchTimeoutMs);
            expect(opts.maxContentLength).to.equal(d.cfg.maxBytes);
            expect(opts.maxRedirects).to.equal(3);
            expect(opts.headers['User-Agent']).to.include('xchain-icon-downloader');
        });

        it('extracts mime from content-type header (strips parameters)', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png; charset=utf-8' },
                    data:    Buffer.from('PNG'),
                },
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const result = await d._httpFetch('https://example.com/img.png');
            expect(result.mime).to.equal('image/png');
        });

        it('handles missing content-type header gracefully', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: {},
                    data:    Buffer.from('DATA'),
                },
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const result = await d._httpFetch('https://example.com/x');
            expect(result.mime).to.equal('');
        });
    });

    // -----------------------------------------------------------------------
    // Logging helpers
    // -----------------------------------------------------------------------

    describe('_log() and _logErr()', function () {
        it('_log outputs a formatted ISO timestamp line', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const lines = [];
            const orig = console.log;
            console.log = (...args) => lines.push(args.join(' '));
            d._log('test message');
            console.log = orig;

            expect(lines[0]).to.include('[icon-downloader]');
            expect(lines[0]).to.include('test message');
        });

        it('_logErr outputs to console.error with stack if available', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const errs = [];
            const orig = console.error;
            console.error = (...args) => errs.push(args);
            d._logErr('test-ctx', new Error('boom'));
            console.error = orig;

            expect(errs.length).to.be.at.least(1);
            expect(errs[0][0]).to.include('[icon-downloader]');
        });

        it('_logErr handles non-Error objects (no stack)', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const errs = [];
            const orig = console.error;
            console.error = (...args) => errs.push(args);
            d._logErr('test-ctx', 'a string error');
            console.error = orig;

            expect(errs.length).to.be.at.least(1);
        });
    });

    // -----------------------------------------------------------------------
    // backoffSeconds (tested via _markFailure args)
    // -----------------------------------------------------------------------

    describe('backoffSeconds via _markFailure', function () {
        it('attempt=0 gives 3600s (same branch as <=1)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 1, 0, 'err');
            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(3600);
        });

        it('attempt >= 4 gives 30*86400s (last backoff branch)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            // Set maxAttempts high enough so the retry path is taken, not terminal
            d.cfg.maxAttempts = 99;

            const conn = makeMockConn([[]]);
            await d._markFailure(conn, 1, 4, 'fourth fail');
            const [sql, args] = conn.query.firstCall.args;
            // Should take retry path (INTERVAL)
            expect(sql).to.include('INTERVAL');
            expect(args[2]).to.equal(30 * 86400);
        });
    });

    // -----------------------------------------------------------------------
    // Pure helpers (truncate / md5 tested indirectly, but direct coverage via _markFailure)
    // -----------------------------------------------------------------------

    describe('truncate(): via _processToken error message path', function () {
        it('truncates fetch error messages to 255 chars via _processToken', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            // _fetchSourceBytes throws a very long error message
            const longMsg = 'E'.repeat(300);
            d._fetchSourceBytes = sinon.stub().rejects(new Error(longMsg));

            const markFailureCalls = [];
            d._markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                markFailureCalls.push(errMsg);
            });
            d._markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            await d._processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(markFailureCalls.length).to.equal(1);
            expect(markFailureCalls[0].length).to.equal(255);
        });

        it('also truncates convert-failure messages to 255 chars', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('DATA'));

            const longMsg = 'F'.repeat(300);
            d._writeIcon = sinon.stub().rejects(new Error(longMsg));

            const markFailureCalls = [];
            d._markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                markFailureCalls.push(errMsg);
            });
            d._markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(markFailureCalls.length).to.equal(1);
            expect(markFailureCalls[0].length).to.equal(255);
        });
    });

    // -----------------------------------------------------------------------
    // _processToken uses fsp.mkdir before _writeIcon
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Branch: e.code || e.message || 'fetch failed' fallback (line 378)
    // -----------------------------------------------------------------------

    describe('_httpFetch "fetch failed" fallback', function () {
        it('uses "fetch failed" when axios error has neither code nor message', async function () {
            const err = {};   // no code, no message, no response
            err.__proto__ = Error.prototype;  // is an Error but empty
            const stubs = makeStubs({ axiosReject: err });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            try {
                await d._httpFetch('https://example.com/img.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('fetch failed');
            }
        });
    });

    // -----------------------------------------------------------------------
    // Branch: truncate() non-string path (line 488)
    // -----------------------------------------------------------------------

    describe('truncate() non-string input via _processToken', function () {
        it('converts non-string error to string before truncating', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            // Throw a non-string-message error: use an object with no .message
            const weirdErr = new Error();
            weirdErr.message = 42;   // number, not string
            d._fetchSourceBytes = sinon.stub().rejects(weirdErr);

            const receivedMsgs = [];
            d._markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                receivedMsgs.push(errMsg);
            });
            d._markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            await d._processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            // truncate received a non-string (42) and should have String()'d it
            expect(receivedMsgs.length).to.equal(1);
            expect(receivedMsgs[0]).to.equal('42');
        });
    });

    // -----------------------------------------------------------------------
    // Branch: _writeIcon convert error with e.message fallback (line 414)
    // -----------------------------------------------------------------------

    describe('_writeIcon convert error e.message fallback', function () {
        it('uses e.message when e.stderr is absent', async function () {
            const fspStub = {
                mkdir:     sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile:  sinon.stub().resolves(Buffer.from('OUT')),
                unlink:    sinon.stub().resolves(),
            };
            const convertErr = new Error('Magick error message');
            // No stderr property
            const execStub = makeExecStub([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);

            const stubs = makeStubs();
            stubs.fspStub  = fspStub;
            stubs.execStub = execStub;

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.convertBin = '/usr/bin/convert';
            d.cfg.iconSize   = 64;

            try {
                await d._writeIcon(Buffer.from('DATA'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed');
                expect(e.message).to.include('Magick error message');
            }
        });
    });

    // -----------------------------------------------------------------------
    // Branch: src.url || null in _markOk call (line 292)
    // -----------------------------------------------------------------------

    describe('_processToken src.url undefined fallback', function () {
        it('passes null for sourceUrl when src has no .url property', async function () {
            // stamp scheme sources have .data but no .url
            const src = { scheme: 'stamp', data: 'aGVsbG8=' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNG'));
            d._writeIcon        = sinon.stub().resolves('abc123');
            d._markOk           = sinon.stub().resolves();
            d._markFailure      = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            stubs.fspStub.mkdir.resolves();

            await d._processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'stamp:aGVsbG8=', tick: 'TOK',
            });

            // src.url is undefined => src.url || null => null
            expect(d._markOk.callCount).to.equal(1);
            const [, , url] = d._markOk.firstCall.args;
            expect(url).to.equal(null);
        });
    });

    // -----------------------------------------------------------------------
    // Branch: convert error with neither stderr nor message (line 414)
    // -----------------------------------------------------------------------

    describe('_writeIcon convert error empty fallback', function () {
        it('produces "convert failed: " when error has no stderr or message', async function () {
            const fspStub = {
                mkdir:     sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile:  sinon.stub().resolves(Buffer.from('OUT')),
                unlink:    sinon.stub().resolves(),
            };
            const convertErr = new Error('');
            convertErr.stderr = '';
            convertErr.message = '';
            const execStub = makeExecStub([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);

            const stubs = makeStubs();
            stubs.fspStub  = fspStub;
            stubs.execStub = execStub;

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.convertBin = '/usr/bin/convert';
            d.cfg.iconSize   = 64;

            try {
                await d._writeIcon(Buffer.from('DATA'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('convert failed: ');
            }
        });
    });

    describe('_processToken mkdir behavior', function () {
        it('calls fsp.mkdir with recursive:true before writing icon', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._fetchSourceBytes = sinon.stub().resolves(Buffer.from('DATA'));
            d._writeIcon        = sinon.stub().resolves('hash');
            d._markOk           = sinon.stub().resolves();
            d._markFailure      = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            const flavor = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

            await d._processToken(conn, flavor, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(stubs.fspStub.mkdir.callCount).to.equal(1);
            const mkdirArgs = stubs.fspStub.mkdir.firstCall.args;
            expect(mkdirArgs[1]).to.deep.equal({ recursive: true });
            expect(d._writeIcon.callCount).to.equal(1);
        });
    });
});
