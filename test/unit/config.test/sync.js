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

const { expect, sinon, proxyquire, path, fsStub, mockHubResponse, MockHubConnector, MockUtility, mockFileConfig, loadConfig } = require('./helpers.js');

describe("config", function () {
    describe('startSync()', function () {

        it('schedules a recurring config refresh (setInterval call does not throw)', function () {
            // startSync's setInterval callback references the module-level getConfig
            // by name, which is an open ReferenceError in this scope; that error only
            // fires later, inside the timer, so calling startSync itself does not throw.
            const config = loadConfig();
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
                expect(warnStub.calledWithMatch(/CONFIG_SYNC_TICK_FAILED/)).to.be.true;
            } finally {
                getConfigStub.restore();
                warnStub.restore();
                clock.restore();
            }
        });

    });
});

describe("config", function () {
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
            const config = proxyquire('../../../src/config.js', {
                'fs':                   fsCacheStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': NullHubConnector,
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
            const config = proxyquire('../../../src/config.js', {
                'fs':                   fsNoCacheStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': NullHubConnector,
                './config.json':        mockFileConfig
            });
            // Must NOT throw (the old worry was throwError -> process.exit).
            const result = await config.getConfig(['http://hub:10000'], false);
            expect(result).to.be.an('object');
            expect(result.COIN_AVAILABLE).to.be.an('object');
            expect(Object.keys(result.COIN_AVAILABLE)).to.have.lengthOf(0);
        });
    });
});

describe("config", function () {
    describe('getConfig() resilience (hub unreachable)', function () {
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
            const config = proxyquire('../../../src/config.js', {
                'fs':                   fsCacheStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': FlakyHubConnector,
                './config.json':        mockFileConfig
            });
            const first  = await config.getConfig(['http://hub:10000'], false); // hub up -> BTC
            const second = await config.getConfig(['http://hub:10000'], false); // blip -> keep cache
            expect(first.COIN_AVAILABLE).to.include.key('BTC');
            expect(second).to.equal(first); // same object; cache was not torn down
        });

    });
});
