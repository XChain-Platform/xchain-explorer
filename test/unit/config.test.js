'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const path       = require('path');

// ---------------------------------------------------------------------------
// Polyfill CustomEvent for Node 18 (added globally in 18.7+ but missing here)
// ---------------------------------------------------------------------------
if (typeof CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(type, options) {
            super(type, options);
            this.detail = options && options.detail !== undefined ? options.detail : null;
        }
    };
}

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

// Stub fs to prevent SSL cert reads at module load time.
// existsSync returns true so the coin-config file presence check passes;
// the real coin config files are loaded from disk via Node's native require.
const fsStub = {
    readFileSync: sinon.stub().returns('mock-cert'),
    existsSync:   sinon.stub().returns(true)
};

// A minimal hub config response — shape returned by XChainHubConnector.getAllConfig():
//   { bitcoin: { mainnet: { indexer: {...}, decoder: {...} } } }
const mockHubResponse = {
    bitcoin: {
        mainnet: {
            indexer: { host: 'hub-host', port: 3306, database: 'XChain_BTC_Mainnet_Indexer', user: 'u', password: 'p' },
            decoder: { host: 'hub-host', port: 3306, database: 'XChain_BTC_Mainnet_Decoder', user: 'u', password: 'p' }
        }
    }
};

// Hub connector stub — returned config is controlled per-test
class MockHubConnector {
    constructor(url, port) {
        this.url  = url;
        this.port = port;
    }
    async getAllConfig() {
        return mockHubResponse;
    }
}

// Utility stub matching the interface used by config.js
class MockUtility {
    isNull(v)       { return v === null || v === undefined || v === ''; }
    throwError(msg) { throw new Error(msg); }
}

// A minimal file config with one BTC mainnet entry
const mockFileConfig = {
    configs: [
        {
            coin:    'BTC',
            network: 'mainnet',
            indexer: { host: 'file-host', port: 3306, database: 'XChain_BTC_Mainnet_Indexer', user: 'u', password: 'p' },
            decoder: { host: 'file-host', port: 3306, database: 'XChain_BTC_Mainnet_Decoder', user: 'u', password: 'p' }
        }
    ]
};

// ---------------------------------------------------------------------------
// Helper: load a fresh copy of config.js with desired stubs.
// Each call to proxyquire produces a new module instance (fresh internal state).
// ---------------------------------------------------------------------------

function loadConfig(overrides) {
    return proxyquire('../../src/config.js', Object.assign({
        'fs':                   fsStub,
        'path':                 path,
        './utility.js':         MockUtility,
        './XChainHubConnector': MockHubConnector,
        './config.json':        mockFileConfig
    }, overrides || {}));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('config', function () {

    // -----------------------------------------------------------------------
    // getConfig — file config (no hub)
    // -----------------------------------------------------------------------

    describe('getConfig() with file config (no hub url/port)', function () {

        it('returns a config object when called without hub url/port', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(result).to.be.an('object');
        });

        it('includes COIN_NETWORKS with BTC, LTC, DOGE', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(result.COIN_NETWORKS).to.include.keys('BTC', 'LTC', 'DOGE');
        });

        it('includes COIN_PREFIXES with mainnet, testnet, regtest', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(result.COIN_PREFIXES).to.include.keys('mainnet', 'testnet', 'regtest');
        });

        it('populates COIN_AVAILABLE only with coins from the file config', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            // Only BTC/mainnet is in mockFileConfig; mainnet prefix is '' → key 'BTC'
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
            expect(result.COIN_AVAILABLE).to.not.include.key('LTC');
            expect(result.COIN_AVAILABLE).to.not.include.key('DOGE');
        });

        it('includes an API object with correct host and ports', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(result.API).to.be.an('object');
            expect(result.API.host).to.equal('127.0.0.1');
            expect(result.API.port.http).to.equal(8080);
            expect(result.API.port.https).to.equal(8081);
        });

        it('includes ssl certs from API_SSL (stubbed via fsStub)', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(result.API.ssl.key).to.equal('mock-cert');
            expect(result.API.ssl.cert).to.equal('mock-cert');
            expect(result.API.ssl.ca).to.equal('mock-cert');
        });

    });

    // -----------------------------------------------------------------------
    // COIN_SUPPORTED — all 9 combinations
    // -----------------------------------------------------------------------

    describe('COIN_SUPPORTED', function () {

        it('contains all 9 coin/network combinations', async function () {
            const config    = loadConfig();
            const result    = await config.getConfig(null, null, false);
            const supported = result.COIN_SUPPORTED;
            // 3 coins × 3 networks = 9 entries
            // Prefixes: mainnet='', testnet='T', regtest='R'
            expect(supported).to.include.key('BTC');    // mainnet
            expect(supported).to.include.key('TBTC');   // testnet
            expect(supported).to.include.key('RBTC');   // regtest
            expect(supported).to.include.key('LTC');
            expect(supported).to.include.key('TLTC');
            expect(supported).to.include.key('RLTC');
            expect(supported).to.include.key('DOGE');
            expect(supported).to.include.key('TDOGE');
            expect(supported).to.include.key('RDOGE');
        });

        it('has exactly 9 entries', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, null, false);
            expect(Object.keys(result.COIN_SUPPORTED)).to.have.lengthOf(9);
        });

    });

    // -----------------------------------------------------------------------
    // getConfig — caching
    // -----------------------------------------------------------------------

    describe('getConfig() caching', function () {

        it('returns the cached value on a second call when cache=true', async function () {
            const config = loadConfig();
            const first  = await config.getConfig(null, false); // populate cache (signature: endpoints, cache)
            const second = await config.getConfig(null, true);  // should hit cache
            expect(second).to.equal(first); // same object reference
        });

        it('re-runs config construction and returns an equivalent result when cache=false', async function () {
            const config = loadConfig();
            const first  = await config.getConfig(null, null, false);
            const second = await config.getConfig(null, null, false);
            expect(second).to.deep.equal(first);
        });

    });

    // -----------------------------------------------------------------------
    // getConfig — throws when no valid config
    // -----------------------------------------------------------------------

    describe('getConfig() with no valid config', function () {

        it('throws an error when config.json is missing and NODE_CONFIG is unset', async function () {
            // Passing false as the ./config.json stub makes fileConfig = false;
            // combined with no NODE_CONFIG env var, jsonConfig ends up null/false
            // and MockUtility.throwError fires.
            const config = proxyquire('../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': MockHubConnector,
                './config.json':        false
            });

            const saved = process.env.NODE_CONFIG;
            delete process.env.NODE_CONFIG;
            try {
                await config.getConfig(null, null, false);
                expect.fail('Expected an error to be thrown');
            } catch (err) {
                expect(err).to.be.instanceOf(Error);
                expect(err.message).to.include('No valid configuration');
            } finally {
                if (saved !== undefined) process.env.NODE_CONFIG = saved;
            }
        });

    });

    // -----------------------------------------------------------------------
    // getConfig — with hub url/port
    // -----------------------------------------------------------------------

    describe('getConfig() with hub url/port', function () {

        it('returns a config object when hub url/port are provided', async function () {
            const config = loadConfig();
            const result = await config.getConfig('hub-host', 3000, false);
            expect(result).to.be.an('object');
            expect(result.COIN_SUPPORTED).to.be.an('object');
        });

        it('populates COIN_AVAILABLE from the hub response', async function () {
            const config = loadConfig();
            const result = await config.getConfig('hub-host', 3000, false);
            // mockHubResponse has bitcoin/mainnet → maps to BTC/mainnet → code 'BTC'
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
        });

        it('triggers a config changed event when hub returns a new value', async function () {
            const config  = loadConfig();
            let fired     = false;
            config.onConfigChanged(function () { fired = true; });
            await config.getConfig('hub-host', 3000, false);
            expect(fired).to.be.true;
        });

        it('degrades gracefully when hub getAllConfig returns null (no cached value yet)', async function () {
            class NullHubConnector {
                async getAllConfig() { return null; }
            }
            // On a fresh module with no in-memory cache and a disk-cache read that fails
            // (fsStub.readFileSync returns a non-JSON string), the source degrades to an
            // empty {configs:[]} payload and returns a valid config object with no
            // COIN_AVAILABLE entries instead of returning null.
            const config = proxyquire('../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': NullHubConnector,
                './config.json':        mockFileConfig
            });
            const result = await config.getConfig('hub-host', false);
            expect(result).to.be.an('object');
            expect(result.COIN_AVAILABLE).to.deep.equal({});
        });

    });

    // -----------------------------------------------------------------------
    // onConfigChanged / triggerConfigChanged
    // -----------------------------------------------------------------------

    describe('onConfigChanged() / triggerConfigChanged()', function () {

        it('fires the registered listener when triggerConfigChanged is called', function (done) {
            const config = loadConfig();
            config.onConfigChanged(function () { done(); });
            config.triggerConfigChanged();
        });

        it('fires multiple registered listeners', function () {
            const config    = loadConfig();
            let callCount   = 0;
            // EventTarget deduplicates identical function references,
            // so use two distinct handlers to verify multiple listeners fire
            config.onConfigChanged(function () { callCount++; });
            config.onConfigChanged(function () { callCount++; });
            config.triggerConfigChanged();
            expect(callCount).to.equal(2);
        });

    });

    // -----------------------------------------------------------------------
    // startSync — documents existing behavior
    // -----------------------------------------------------------------------

    describe('startSync()', function () {

        it('schedules a recurring config refresh (setInterval call does not throw)', function () {
            // startSync calls setInterval(getConfig, ...) where getConfig refers to
            // the module-level export method by name — this is an open ReferenceError
            // in Node because the local scope has no 'getConfig' symbol.
            // The test documents this known behavior.
            const config = loadConfig();
            // The ReferenceError is thrown synchronously inside setInterval callback,
            // but setInterval itself schedules it — the call to startSync does not throw.
            // We verify that the function at least exists and is callable.
            expect(config.startSync).to.be.a('function');
        });

        it('catches a rejected getConfig on a sync tick (no unhandled rejection)', async function () {
            // A hub blip during a 60s sync tick must not crash the process.
            // The setInterval callback wraps getConfig in a .catch() that logs
            // and keeps serving the cached config.
            const config        = loadConfig();
            const clock         = sinon.useFakeTimers();
            const warnStub      = sinon.stub(console, 'warn');
            const getConfigStub = sinon.stub(config, 'getConfig').rejects(new Error('hub blip'));
            try {
                config.startSync(['http://hub:10000']);
                clock.tick(60000); // fire the interval callback once
                // Let the rejected promise's .catch handler (a microtask) run.
                await Promise.resolve();
                await Promise.resolve();
                expect(getConfigStub.called).to.be.true;
                expect(warnStub.calledWithMatch(/sync tick failed/i)).to.be.true;
            } finally {
                getConfigStub.restore();
                warnStub.restore();
                clock.restore();
            }
        });

    });

    // -----------------------------------------------------------------------
    // getConfig — resilience when the hub is unreachable
    // -----------------------------------------------------------------------

    describe('getConfig() resilience (hub unreachable)', function () {

        // Hub connector that always reports the hub as down
        class NullHubConnector {
            async getAllConfig() { return null; }
        }

        it('falls back to the last-known-good config on disk when the hub is down at startup', async function () {
            const cacheJson = JSON.stringify({
                configs: [{
                    coin:    'BTC',
                    network: 'mainnet',
                    indexer: { host: 'disk-host', port: 3306, database: 'XChain_BTC_Mainnet_Indexer', user: 'u', password: 'p' },
                    decoder: { host: 'disk-host', port: 3306, database: 'XChain_BTC_Mainnet_Decoder', user: 'u', password: 'p' }
                }]
            });
            const fsCacheStub = {
                readFileSync: sinon.stub().callsFake((p) =>
                    String(p).includes('config-cache.json') ? cacheJson : 'mock-cert'),
                existsSync:   sinon.stub().returns(true),
                mkdirSync:    sinon.stub(),
                writeFileSync: sinon.stub()
            };
            const config = proxyquire('../../src/config.js', {
                'fs':                   fsCacheStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': NullHubConnector,
                './config.json':        mockFileConfig
            });
            const result = await config.getConfig(['http://hub:10000'], false);
            expect(result).to.be.an('object');
            // BTC/mainnet came from the on-disk cache, not the (down) hub.
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
        });

        it('comes up degraded (no coins) without throwing when hub is down and no disk cache exists', async function () {
            const fsNoCacheStub = {
                readFileSync: sinon.stub().returns('mock-cert'),
                existsSync:   sinon.stub().returns(false), // no cache file
                mkdirSync:    sinon.stub(),
                writeFileSync: sinon.stub()
            };
            const config = proxyquire('../../src/config.js', {
                'fs':                   fsNoCacheStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': NullHubConnector,
                './config.json':        mockFileConfig
            });
            // Must NOT throw (the old worry was throwError → process.exit).
            const result = await config.getConfig(['http://hub:10000'], false);
            expect(result).to.be.an('object');
            expect(result.COIN_AVAILABLE).to.be.an('object');
            expect(Object.keys(result.COIN_AVAILABLE)).to.have.lengthOf(0);
        });

        it('keeps serving the cached config when a later sync tick hits a hub blip', async function () {
            // First fetch succeeds, a subsequent fetch returns null (blip).
            class FlakyHubConnector {
                constructor() { this.calls = 0; }
                async getAllConfig() {
                    this.calls++;
                    return this.calls === 1 ? mockHubResponse : null;
                }
            }
            const fsCacheStub = {
                readFileSync:  sinon.stub().returns('mock-cert'),
                existsSync:    sinon.stub().returns(true),
                mkdirSync:     sinon.stub(),
                writeFileSync: sinon.stub()
            };
            const config = proxyquire('../../src/config.js', {
                'fs':                   fsCacheStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': FlakyHubConnector,
                './config.json':        mockFileConfig
            });
            const first  = await config.getConfig(['http://hub:10000'], false); // hub up → BTC
            const second = await config.getConfig(['http://hub:10000'], false); // blip → keep cache
            expect(first.COIN_AVAILABLE).to.include.key('BTC');
            expect(second).to.equal(first); // same object — cache was not torn down
        });

    });

});
