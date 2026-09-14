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
            // mockHubResponse has bitcoin/mainnet -> maps to BTC/mainnet -> code 'BTC'
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
        });

        it('triggers a config changed event when hub returns a new value', async function () {
            const config  = loadConfig();
            let fired     = false;
            config.onConfigChanged(function () { fired = true; });
            await config.getConfig('hub-host', 3000, false);
            expect(fired).to.be.true;
        });

        it('skips an unrecognized coin key (e.g. chain_tips pushed under the abbreviation) without crashing', async function () {
            // The hub config tree carries a phantom 'BTC' top-level key (chain_tips
            // written by an indexer under the coin abbreviation rather than the full
            // name 'bitcoin'). That key maps to no coin label; the explorer must skip
            // it instead of building configs/undefined.js and throwing at startup.
            class PollutedHubConnector {
                async getAllConfig() {
                    return {
                        bitcoin: mockHubResponse.bitcoin,
                        BTC: { mainnet: { chain_tips: { block_height: '821000', block_time: '1718000000' } } }
                    };
                }
            }
            const config = proxyquire('../../../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': PollutedHubConnector,
                './config.json':        mockFileConfig
            });
            const result = await config.getConfig('hub-host', 3000, false);
            expect(result).to.be.an('object');
            // The real coin still loads; the junk key is absent.
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
            expect(result).to.not.have.key('undefined');
        });
    });
});

describe("config", function () {
    describe('getConfig() with hub url/port', function () {
        it('degrades gracefully when hub getAllConfig returns null (no cached value yet)', async function () {
            class NullHubConnector {
                async getAllConfig() { return null; }
            }
            // On a fresh module with no in-memory cache and a disk-cache read that fails
            // (fsStub.readFileSync returns a non-JSON string), the source degrades to an
            // empty {configs:[]} payload and returns a valid config object with no
            // COIN_AVAILABLE entries instead of returning null.
            const config = proxyquire('../../../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': NullHubConnector,
                './config.json':        mockFileConfig
            });
            const result = await config.getConfig('hub-host', false);
            expect(result).to.be.an('object');
            expect(result.COIN_AVAILABLE).to.deep.equal({});
        });

        it('names an empty hub tree as reachable, not as unreachable', async function () {
            // A hub that answers with {} is up and simply has no coin config yet, which
            // is the normal state mid-install. Calling that "unreachable" sends operators
            // after a network fault that does not exist.
            class EmptyHubConnector {
                async getAllConfig() { return {}; }
            }
            const config = proxyquire('../../../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': EmptyHubConnector,
                './config.json':        mockFileConfig
            });
            const warn = sinon.stub(console, 'warn');
            let result;
            try {
                result = await config.getConfig('hub-host', false);
            } finally {
                warn.restore();
            }
            expect(result.COIN_AVAILABLE).to.deep.equal({});
            const said = warn.args.map(a => String(a[0])).join(' | ');
            expect(said).to.match(/reachable but serving no coin config/);
            expect(said).to.not.match(/Hub unreachable/);
        });

    });
});

describe("config", function () {
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

        it('announces a config change only after the cache holds the NEW config', async function () {
            // Subscribers re-read config through the cache (db/index.js setupConnectionPools
            // calls getConfig() with cache defaulting to true). Announcing before
            // configCache is replaced hands them the PREVIOUS config, so an explorer
            // that cold-started with no coins rebuilt zero DB pools and served 503
            // forever while every poll reported the coins arriving.
            const hub = { calls: 0 };
            class StagedHubConnector {
                async getAllConfig() {
                    hub.calls++;
                    return hub.calls === 1 ? {} : { bitcoin: mockHubResponse.bitcoin };
                }
            }
            const config = proxyquire('../../../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': StagedHubConnector,
                './config.json':        mockFileConfig
            });
            let seenBySubscriber = null;
            config.onConfigChanged(async function () {
                const seen = await config.getConfig();
                seenBySubscriber = Object.keys(seen.COIN_AVAILABLE || {});
            });
            const warn = sinon.stub(console, 'warn');
            try {
                await config.getConfig('hub-host', false);          // cold start: no coins
                await config.getConfig('hub-host', false);          // the poll that delivers them
            } finally {
                warn.restore();
            }
            await new Promise(r => setImmediate(r));
            expect(seenBySubscriber, 'subscriber read a stale config').to.not.deep.equal([]);
            expect(seenBySubscriber).to.include('BTC');
        });

    });
});
