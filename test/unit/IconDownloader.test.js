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

/**
 * Flatten one child_process.execFile call back into the single command string
 * the handlers and assertions in this file match on. IconDownloader spawns via
 * execFile(bin, argv, opts, cb) so there is no shell to escape and Node's
 * timeout signals the binary itself; the argv shape is an implementation
 * detail these tests should not have to spell out element by element.
 */
function execCmdText(call) {
    const argv = Array.isArray(call.args[1]) ? call.args[1] : [];
    return [call.args[0]].concat(argv).join(' ');
}

/**
 * Build a child_process.execFile stub that calls its callback based on the
 * result map: { [cmdSubstring]: result }.  result = null means success with
 * empty stdout/stderr; result = Error means failure; result = {stdout,stderr}
 * means success with those values. The substring is matched against the
 * flattened `bin arg arg ...` text, so the handlers read the same as they did
 * when this spawned through a shell.
 */
function makeExecStub(handlers) {
    // handlers: array of [predicateFn | string, resultOrError]
    return sinon.stub().callsFake(function(file, args, opts, cb) {
        // execFile's callback is the last argument whatever the arity; promisify
        // always passes (file, args, opts, cb), but keep the shorter forms working
        // so a test can call the stub directly.
        if (typeof args === 'function')      { cb = args; args = []; opts = {}; }
        else if (typeof opts === 'function') { cb = opts; opts = {}; }
        const cmd = [file].concat(Array.isArray(args) ? args : []).join(' ');
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
        execStub.callsFake(function(file, args, opts, cb) {
            if (typeof args === 'function')      { cb = args; args = []; }
            else if (typeof opts === 'function') { cb = opts; }
            const cmd = [file].concat(Array.isArray(args) ? args : []).join(' ');
            if (cmd.includes('--mime-type')) {
                cb(new Error('file command failed'));
            } else {
                cb(null, { stdout: '', stderr: '' });
            }
        });
    }

    const resolveDescriptionToSource    = opts.resolveDescriptionToSource    || sinon.stub().returns(null);
    const selectIconUrlFromCip25Json    = opts.selectIconUrlFromCip25Json    || sinon.stub().returns(null);

    return { axiosStub, fsStub, fspStub, execStub, resolveDescriptionToSource, selectIconUrlFromCip25Json };
}

// The `action:` grammar is NOT stubbed: it is shared source text that the module
// embeds in the re-stale SQL, and a stubbed copy here would let the SQL and the
// real resolver drift apart without a test noticing - which is the whole failure
// the shared constant exists to prevent.
const { ACTION_REF_PATTERN } = require('../../src/IconResolver.js');

/**
 * Load IconDownloader through proxyquire using the provided stubs.
 */
function loadIconDownloader(stubs) {
    return proxyquire('../../src/IconDownloader.js', {
        'axios':          stubs.axiosStub,
        'fs':             stubs.fsStub,
        'fs/promises':    stubs.fspStub,
        'child_process':  { execFile: stubs.execStub },
        './IconResolver': {
            resolveDescriptionToSource: stubs.resolveDescriptionToSource,
            selectIconUrlFromCip25Json: stubs.selectIconUrlFromCip25Json,
            ACTION_REF_PATTERN,
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

describe('IconDownloader', function () {

    let clock;
    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
    });

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

    describe('_discover()', function () {
        it('runs INSERT IGNORE and UPDATE queries with correct SQL fragments', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[], [], []]);
            await d._discover(conn);

            expect(conn.query.callCount).to.equal(3);
            const firstSql  = conn.query.firstCall.args[0];
            const secondSql = conn.query.secondCall.args[0];
            const thirdSql  = conn.query.thirdCall.args[0];

            expect(firstSql).to.include('INSERT IGNORE INTO icons');
            expect(firstSql).to.include('pending');

            expect(secondSql).to.include('UPDATE icons');
            expect(secondSql).to.include('stale');
            expect(secondSql).to.include('<=>');

            // The one-shot re-stale for tokens marked icon-less before the resolver
            // learned the on-chain `action:` scheme. Description-hash drift (the second
            // statement) never reaches them: an on-chain TIS description is usually
            // description-locked, so without this the fix is invisible on every existing
            // row. Its predicate is the resolver's own grammar rather than an
            // `action:` prefix test, which is what keeps it one-shot (#5290, below).
            expect(thirdSql).to.include('UPDATE icons');
            expect(thirdSql).to.include('stale');
            expect(thirdSql).to.include('icon_hash IS NULL');
            expect(thirdSql).to.include("REGEXP '" + ACTION_REF_PATTERN + "'");
            expect(thirdSql).to.not.include("LIKE 'action:%'");

            // The binary conversion is load-bearing, not cosmetic: under the
            // column's own utf8mb4_general_ci collation, LOWER() folds U+0130 into
            // plain 'i' and widens the predicate past anything the resolver can
            // resolve (#5290). Proven against a real engine in
            // test/conformance/icon-restale-predicate.test.js.
            expect(thirdSql).to.include('CONVERT(TRIM(t.description) USING binary)');
            expect(thirdSql, 'no case folding may sit between the column and the grammar')
                .to.not.match(/LOWER\s*\(/i);
        });
    });

    // #5290: the one-shot re-stale has to be ONE-shot. It selects rows in the
    // terminal ok-with-no-icon state, which is exactly the state _processToken
    // writes for a description that resolves to no source at all - so a predicate
    // any wider than the resolver's own grammar re-stales those same rows on every
    // cycle for as long as the token exists: a permanent write loop on the
    // indexer-owned icons table, plus permanent occupancy of the batch queue,
    // mintable by anyone who can issue a token described `action:` plus anything.
    describe('_discover(): the action: re-stale is one-shot', function () {

        // Probed against the live resolver: each is PREFIXED with `action:` and
        // resolves to null, so none of them may ever be selected for a re-stale.
        // The U+0130 spellings are the attacker-mintable ones this suite once
        // waved through; see the model's own caveat below.
        const UNRESOLVABLE = [
            'action:foo', 'action:BTC:', 'action:', 'action:12a',
            'action:XYZ:5', 'action:0x10', 'action: 12', 'Action:hello',
            'ACTİON:12', 'ACTİON:BTC:5', 'actİon:12', 'actıon:12',
        ];
        const RESOLVABLE = ['action:12', 'action:BTC:5', 'ACTION:DOGE:9', '  action:7  '];

        const realResolve = require('../../src/IconResolver.js').resolveDescriptionToSource;

        /**
         * Read the re-stale predicate out of the SQL the module actually emits and
         * evaluate it the way the server would, so these assertions bind to the
         * shipped statement rather than to a copy of it.
         *
         * THIS IS A MODEL OF MariaDB, NOT MariaDB, and the distinction is not
         * academic: the previous model evaluated the predicate as
         * `re.test(desc.trim().toLowerCase())` to stand in for LOWER(TRIM(...)),
         * and JavaScript's toLowerCase() is not MariaDB's LOWER(). MariaDB folds
         * U+0130 to plain 'i'; toLowerCase() expands it to 'i' plus a COMBINING DOT
         * ABOVE, which does not match the grammar. So the model reported "not
         * selected" for `ACTİON:12` while the database selected it, and #5290 passed
         * this suite twice while still looping in production.
         *
         * What makes the model sound now is that the shipped predicate no longer
         * asks either engine to fold case: ACTION_REF_PATTERN spells both cases out
         * and the SQL matches under CONVERT(... USING binary), so the only remaining
         * gaps between this function and the server are the two below, both of which
         * make the model select AT LEAST what the database does - the safe direction
         * for a "must never select" assertion:
         *
         *   - SQL TRIM() strips only spaces where String#trim() strips all
         *     whitespace, so the model trims to ASCII spaces to match.
         *   - MariaDB's PCRE `$` also matches before one trailing newline, which JS
         *     `$` does not, so the model tries that spelling too.
         *
         * The engine itself answers this question in
         * test/conformance/icon-restale-predicate.test.js, which runs the shipped
         * statement against a real MariaDB over every Unicode scalar value. When the
         * two tiers ever disagree, the conformance tier is right.
         */
        async function restalePredicate() {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            const conn = makeMockConn([[], [], []]);
            await d._discover(conn);
            const sql = conn.query.thirdCall.args[0];
            const m = /CONVERT\(TRIM\(t\.description\) USING binary\)\s+REGEXP\s+'([^']+)'/.exec(sql);
            expect(m, 'the re-stale must test the WHOLE description against a regexp, ' +
                'under a binary collation so no case folding can widen it:\n' + sql)
                .to.not.equal(null);
            expect(sql, 'LOWER() is not /i; emulating one with the other is what #5290 was')
                .to.not.match(/LOWER\s*\(/i);
            const re = new RegExp(m[1]);
            const sqlTrim = s => String(s).replace(/^ +/, '').replace(/ +$/, '');
            return desc => {
                const t = sqlTrim(desc);
                return re.test(t) || re.test(t.replace(/\n$/, ''));
            };
        }

        it('never selects a description the resolver cannot resolve', async function () {
            const selects = await restalePredicate();
            for (const desc of UNRESOLVABLE) {
                expect(realResolve(desc), `${desc} must resolve to no source`).to.equal(null);
                expect(selects(desc), `${desc} resolves to nothing, so re-staling it loops forever`)
                    .to.equal(false);
            }
        });

        it('still selects every description the resolver does resolve', async function () {
            const selects = await restalePredicate();
            for (const desc of RESOLVABLE) {
                expect(realResolve(desc).scheme, `${desc} must resolve`).to.equal('action');
                expect(selects(desc), `${desc} resolves, so the fix must reach its row`)
                    .to.equal(true);
            }
        });

        it('leaves an unresolvable action:-prefixed row un-staled on every cycle', async function () {
            const selects = await restalePredicate();

            // One icons row per probe, in the terminal state the pipeline leaves them
            // in before this round's fix: status ok, icon_hash NULL.
            const table = UNRESOLVABLE.map((description, i) => ({
                icon_id: i + 1, description, status: 'ok', icon_hash: null,
            }));
            const runRestale = () => {
                for (const row of table) {
                    if (row.status === 'ok' && row.icon_hash === null && selects(row.description)) {
                        row.status = 'stale';
                    }
                }
                return table.filter(r => r.status === 'stale').map(r => r.description);
            };

            // Cycle 1.
            expect(runRestale()).to.deep.equal([]);

            // And these rows really do sit in the state the statement selects on:
            // drive each one through _processToken and watch it take the terminal
            // ok-with-null-icon_hash path. That is the loop's other half.
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().callsFake(realResolve) });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            for (const row of table) {
                const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
                await d._processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' },
                    { icon_id: row.icon_id, attempts: 0, description: row.description, tick: 'TOK' + row.icon_id });
                expect(conn.query.callCount).to.equal(1);
                const [sql, params] = conn.query.firstCall.args;
                expect(sql).to.include("status='ok'");
                expect(params[2], 'icon_hash stays NULL: the state the re-stale selects').to.equal(null);
            }

            // Cycle 2: the rows are back in that state, and are still not selected.
            expect(runRestale()).to.deep.equal([]);
        });
    });

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

    describe('_fetchSourceBytes()', function () {

        function makeDownloader(stubs) {
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            return new IconDownloader(explorer);
        }

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
            // AA== decodes to a single byte and must succeed; an empty string
            // decodes to zero bytes and must throw.
            const src = { scheme: 'stamp', data: '' };
            try {
                await d._fetchSourceBytes({ scheme: 'stamp', data: 'AA==' }, 2);
            } catch (e) {
                throw new Error('unexpected throw for valid stamp');
            }
            try {
                await d._fetchSourceBytes({ scheme: 'stamp', data: '' }, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('empty after base64 decode');
            }
        });

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
            // A base64 data URL that decodes to an empty buffer.
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
                resolveDescriptionToSource: sinon.stub().callsFake((desc) => {
                    callCount++;
                    if (callCount === 1) return null;
                    return null;
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

    // The on-chain TIS scheme the token page resolves (actionRefToRawPath in
    // content/js/xchain.js). Its bytes are the FILE action's stored bytes in the
    // colocated decoder DB, read the way the /{COIN}/api/file/{index}/raw route reads
    // them, so nothing here opens a socket.
    //
    // The load-bearing property is the FAILURE shape, not the happy path: answering
    // "no source" for an unreadable FILE would put the row on _processToken's terminal
    // _markOk path, where only a description change can ever revive it, and getFileRaw
    // returns null for a decoder DB that is merely unreachable exactly as it does for a
    // FILE that does not exist. So every failure throws into the retry backoff instead.
    describe('_fetchSourceBytes(): action scheme', function () {

        // An explorer whose DB layer answers like the real one, with per-test overrides.
        function makeActionDownloader(dbOverrides, pools) {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer(undefined, pools !== undefined ? pools : {
                BTC:   { pool: makeMockPool(makeMockConn([])) },
                RDOGE: { pool: makeMockPool(makeMockConn([])) },
            });
            explorer.db.getGatedFileRaw = sinon.stub().resolves([]);
            explorer.db.getFileRaw      = sinon.stub().resolves(null);
            Object.assign(explorer.db, dbOverrides || {});
            return { d: new IconDownloader(explorer), explorer };
        }

        const FLAVOR = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

        it('returns the FILE bytes when they are not a JSON document', async function () {
            const { d, explorer } = makeActionDownloader({
                getFileRaw: sinon.stub().resolves({ raw_data: Buffer.from('PNGBYTES'), data: 'FILE|0|x', type: 'image/png' }),
            });
            const out = await d._fetchSourceBytes({ scheme: 'action', coin: null, index: '42' }, 2, FLAVOR);
            expect(out.toString()).to.equal('PNGBYTES');
            expect(explorer.db.getFileRaw.firstCall.args[0]).to.deep.equal({ coin: 'BTC', data: {} });
            expect(explorer.db.getFileRaw.firstCall.args[1]).to.equal('42');
        });

        it('decodes the inline base64 image out of an on-chain TIS document', async function () {
            const tis = JSON.stringify({ images: [{ type: 'icon', size: '64x64', data: 'data:image/png;base64,aGVsbG8=' }] });
            const stubs = makeStubs();
            // The picker is stubbed in this file, so mirror what the real one returns.
            stubs.selectIconUrlFromCip25Json = sinon.stub().returns('data:image/png;base64,aGVsbG8=');
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.db.getGatedFileRaw = sinon.stub().resolves([]);
            explorer.db.getFileRaw = sinon.stub().resolves({ raw_data: Buffer.from(tis), data: 'FILE|0|x', type: 'application/json' });
            const d = new IconDownloader(explorer);

            const out = await d._fetchSourceBytes({ scheme: 'action', coin: null, index: '7' }, 2, FLAVOR);
            expect(out.toString()).to.equal('hello');
            expect(stubs.axiosStub.get.called).to.equal(false, 'an on-chain icon must cost no egress');
        });

        it('throws rather than answering no-source when the FILE is unreadable here', async function () {
            const { d } = makeActionDownloader({ getFileRaw: sinon.stub().resolves(null) });
            let threw = null;
            try { await d._fetchSourceBytes({ scheme: 'action', coin: null, index: '9' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('no readable bytes');
        });

        it('throws on a token-gated FILE, whose stored bytes are ciphertext', async function () {
            const { d } = makeActionDownloader({
                getGatedFileRaw: sinon.stub().resolves([{ raw_data: Buffer.from('CIPHER') }]),
            });
            let threw = null;
            try { await d._fetchSourceBytes({ scheme: 'action', coin: null, index: '9' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('token-gated');
        });

        it('resolves a sibling-chain ref against this flavor network tier', async function () {
            const { d, explorer } = makeActionDownloader({
                getFileRaw: sinon.stub().resolves({ raw_data: Buffer.from('PNGBYTES'), data: 'FILE|0|x', type: 'image/png' }),
            });
            // A regtest BTC flavor naming DOGE means RDOGE, the same rule the page's
            // actionRefToRawPath applies to the current chain's tier.
            await d._fetchSourceBytes({ scheme: 'action', coin: 'DOGE', index: '3' }, 2,
                { coin: 'BTC', network: 'regtest', poolKey: 'RBTC' });
            expect(explorer.db.getFileRaw.firstCall.args[0].coin).to.equal('RDOGE');
        });

        it('throws when the sibling chain has no pool on this instance', async function () {
            const { d } = makeActionDownloader({}, { BTC: { pool: makeMockPool(makeMockConn([])) } });
            let threw = null;
            try { await d._fetchSourceBytes({ scheme: 'action', coin: 'LTC', index: '3' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('no pool configured for LTC');
        });
    });

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

            const sniffCall = execStub.getCalls().find(c => execCmdText(c).includes('--mime-type'));
            expect(sniffCall).to.not.equal(undefined);

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall).to.not.equal(undefined);
            expect(execCmdText(convertCall)).to.include('64x64!');
            expect(execCmdText(convertCall)).to.include('-format png');

            expect(fspStub.readFile.callCount).to.equal(1);
            expect(fspStub.readFile.firstCall.args[0]).to.equal(iconPath);

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
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.include('[0]');
        });

        // SVG never reaches convert: ImageMagick's SVG renderer dereferences
        // external references, and those fetches leave `convert` without passing
        // this pipeline's SSRF guard. Refuse the format at the sniff instead.
        it('refuses SVG before ImageMagick is ever invoked', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/svg+xml\n', stderr: '' }],
                ['-resize',     null],
            ]);
            try {
                await d._writeIcon(Buffer.from('<svg><image xlink:href="http://169.254.169.254/"/></svg>'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("unsupported mime 'image/svg+xml'");
            }
            expect(execStub.getCalls().find(c => execCmdText(c).includes('-resize'))).to.equal(undefined);
        });

        it('uses [0] frame selector for WebP mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/webp\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('WEBPDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.include('[0]');
        });

        it('does NOT use [0] frame selector for JPEG', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/jpeg\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d._writeIcon(Buffer.from('JPEGDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.not.match(/\[0\]/);
        });

        // These bytes come from on-chain token descriptions, so both subprocesses
        // are attacker-fed. maxBytes caps the download and never the decode, and
        // runOnce holds the _running guard for the whole pass, so an unbounded
        // convert turns one hostile issuance into a host OOM or a pipeline that is
        // stalled for every coin until restart.
        it('bounds convert with a wall-clock timeout and a SIGKILL', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            d.cfg.convertTimeoutMs = 12345;
            await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall.args[2]).to.include({ timeout: 12345, killSignal: 'SIGKILL' });
        });

        it('bounds the mime sniff the same way, so a hung `file` cannot wedge the pass', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            d.cfg.convertTimeoutMs = 12345;
            await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const sniffCall = execStub.getCalls().find(c => execCmdText(c).includes('--mime-type'));
            expect(sniffCall.args[2]).to.include({ timeout: 12345, killSignal: 'SIGKILL' });
        });

        it('caps ImageMagick pixel-cache allocation with -limit before the input file', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            const argv  = convertCall.args[1];
            const pairs = [];
            argv.forEach((a, i) => { if (a === '-limit') pairs.push(argv[i + 1] + ' ' + argv[i + 2]); });
            expect(pairs).to.have.members(['memory 256MiB', 'map 256MiB', 'disk 0']);

            // Order is load-bearing: ImageMagick applies settings left to right, so a
            // -limit after the filename does not bound the read that allocates.
            const lastLimit = argv.lastIndexOf('-limit');
            const srcIdx    = argv.findIndex(a => String(a).startsWith('/') && !String(a).endsWith('out.png'));
            expect(srcIdx).to.be.greaterThan(-1);
            expect(lastLimit).to.be.lessThan(srcIdx);
        });

        it('reports a timeout kill as a timeout, so the row records why it failed', async function () {
            const killed  = new Error('Command failed');
            killed.killed = true;
            killed.signal = 'SIGKILL';
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     killed],
            ]);
            d.cfg.convertTimeoutMs = 777;
            try {
                await d._writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed: timed out after 777ms');
            }
        });

        it('spawns convert without a shell, so no argv element needs escaping', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            await d._writeIcon(Buffer.from('PNGBYTES'), "/tmp/it's odd.png");

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall.args[0]).to.equal('/usr/bin/convert');
            expect(convertCall.args[1]).to.be.an('array');
            // The path travels as one argv element, unquoted: there is no shell to
            // re-split it, which is what makes the removed shellEscape unnecessary.
            expect(convertCall.args[1]).to.include("/tmp/it's odd.png");
        });
    });

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
            // First three calls: _discover (insert, description-drift re-stale, action:
            // one-shot re-stale); fourth call: SELECT
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves([]);
            conn.query.onCall(3).resolves(rows);

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
            // First three calls: _discover (insert, description-drift re-stale, action:
            // one-shot re-stale); fourth call: SELECT
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves([]);
            conn.query.onCall(3).resolves(rows);

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
            expect(sql).to.include('INTERVAL');
            expect(args[2]).to.equal(30 * 86400);
        });
    });

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

    // Covers the e.code || e.message || 'fetch failed' fallback chain.
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

            expect(d._markOk.callCount).to.equal(1);
            const [, , url] = d._markOk.firstCall.args;
            expect(url).to.equal(null);
        });
    });

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

    // Literal-IP URLs bypass the dns.lookup shim (Node skips a custom `lookup`
    // for IP-literal hosts), so _httpFetch must reject a private literal before
    // connecting. Icon URLs come from on-chain token descriptions and are fully
    // attacker-controlled.
    describe('_httpFetch SSRF literal-IP guard', function () {
        function downloader(stubs) {
            return new (loadIconDownloader(stubs))(makeExplorer());
        }

        const privateLiterals = [
            'http://169.254.169.254/latest/meta-data/iam/security-credentials/x.json',
            'http://127.0.0.1:6379/x.png',
            'http://10.0.0.5/x.png',
            'http://[fd00:ec2::254]/x.json',
            'http://100.64.0.1/x.png',
        ];
        for (const url of privateLiterals) {
            it(`refuses a private literal-IP URL without calling axios (${url})`, async function () {
                const stubs = makeStubs();
                const d = downloader(stubs);
                let threw = null;
                try { await d._httpFetch(url); } catch (e) { threw = e; }
                expect(threw, 'expected _httpFetch to reject').to.be.an('error');
                expect(threw.code).to.equal('RELAY_DENIED');
                expect(stubs.axiosStub.get.called, 'axios must not be called for a private literal').to.be.false;
            });
        }

        it('allows a public DNS-name URL through with the lookup shim + beforeRedirect wired', async function () {
            const stubs = makeStubs();
            const d = downloader(stubs);
            await d._httpFetch('https://example.com/icon.png');
            expect(stubs.axiosStub.get.calledOnce).to.be.true;
            const opts = stubs.axiosStub.get.firstCall.args[1];
            expect(opts.lookup).to.be.a('function');       // guards DNS-name hosts + redirects
            expect(opts.beforeRedirect).to.be.a('function'); // guards literal-IP redirect hops
        });

        it('allows a PUBLIC IP literal through (only private literals are blocked)', async function () {
            const stubs = makeStubs();
            const d = downloader(stubs);
            await d._httpFetch('http://93.184.216.34/icon.png');
            expect(stubs.axiosStub.get.calledOnce).to.be.true;
        });
    });
});
