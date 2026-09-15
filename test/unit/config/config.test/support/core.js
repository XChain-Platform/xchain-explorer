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
    describe('getConfig() with file config (no hub url/port)', function () {

        it('returns a config object when called without hub url/port', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            expect(result).to.be.an('object');
        });

        it('includes COIN_NETWORKS with BTC, LTC, DOGE', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            expect(result.COIN_NETWORKS).to.include.keys('BTC', 'LTC', 'DOGE');
        });

        it('includes COIN_PREFIXES with mainnet, testnet, regtest', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            expect(result.COIN_PREFIXES).to.include.keys('mainnet', 'testnet', 'regtest');
        });

        it('populates COIN_AVAILABLE only with coins from the file config', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            // Only BTC/mainnet is in mockFileConfig; mainnet prefix is '' -> key 'BTC'
            expect(result.COIN_AVAILABLE).to.include.key('BTC');
            expect(result.COIN_AVAILABLE).to.not.include.key('LTC');
            expect(result.COIN_AVAILABLE).to.not.include.key('DOGE');
        });

        it('includes an API object with correct host and ports', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            expect(result.API).to.be.an('object');
            expect(result.API.host).to.equal('127.0.0.1');
            expect(result.API.port.http).to.equal(8080);
            expect(result.API.port.https).to.equal(8081);
        });

        it('includes ssl certs from API_SSL (stubbed via fsStub)', async function () {
            const config = loadConfig();
            const result = await config.getConfig(null, false);
            expect(result.API.ssl.key).to.equal('mock-cert');
            expect(result.API.ssl.cert).to.equal('mock-cert');
            expect(result.API.ssl.ca).to.equal('mock-cert');
        });

    });
});

describe("config", function () {
    describe('COIN_SUPPORTED', function () {

        it('contains all 9 coin/network combinations', async function () {
            const config    = loadConfig();
            const result    = await config.getConfig(null, false);
            const supported = result.COIN_SUPPORTED;
            // 3 coins x 3 networks = 9 entries
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
            const result = await config.getConfig(null, false);
            expect(Object.keys(result.COIN_SUPPORTED)).to.have.lengthOf(9);
        });

    });

    describe('getConfig() caching', function () {

        it('returns the cached value on a second call when cache=true', async function () {
            const config = loadConfig();
            const first  = await config.getConfig(null, false); // populate cache (signature: endpoints, cache)
            const second = await config.getConfig(null, true);  // should hit cache
            expect(second).to.equal(first); // same object reference
        });

        it('re-runs config construction and returns an equivalent result when cache=false', async function () {
            const config = loadConfig();
            const first  = await config.getConfig(null, false);
            const second = await config.getConfig(null, false);
            expect(second).to.deep.equal(first);
        });

    });
});

describe("config", function () {
    describe('getConfig() with no valid config', function () {

        it('throws an error when config.json is missing and NODE_CONFIG is unset', async function () {
            // Passing false as the ./config.json stub makes fileConfig = false;
            // combined with no NODE_CONFIG env var, jsonConfig ends up null/false
            // and MockUtility.throwError fires.
            const config = proxyquire('../../../../src/config.js', {
                'fs':                   fsStub,
                'path':                 path,
                './lib/utility.js':         MockUtility,
                './connectors/hub': MockHubConnector,
                './config.json':        false
            });

            const saved = process.env.NODE_CONFIG;
            delete process.env.NODE_CONFIG;
            try {
                await config.getConfig(null, false);
                expect.fail('Expected an error to be thrown');
            } catch (err) {
                expect(err).to.be.instanceOf(Error);
                expect(err.message).to.include('No valid configuration');
            } finally {
                if (saved !== undefined) process.env.NODE_CONFIG = saved;
            }
        });

    });
});
