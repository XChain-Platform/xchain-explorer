'use strict';

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
 * Smoke tests: Configuration loading (SM-01 through SM-04)
 *
 * These tests verify that the explorer can load configuration without
 * external dependencies. They use proxyquire to stub fs (SSL reads)
 * and config.json, producing a fresh config module per test.
 *
 * Run: npm run test:smoke:unit
 */

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const path       = require('path');

// Polyfill CustomEvent for Node 18
if (typeof CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(type, options) {
            super(type, options);
            this.detail = options && options.detail !== undefined ? options.detail : null;
        }
    };
}

const fsStub = {
    readFileSync: sinon.stub().returns('mock-cert'),
    existsSync:   sinon.stub().returns(true)
};

class MockUtility {
    isNull(v)       { return v === null || v === undefined || v === ''; }
    throwError(msg) { throw new Error(msg); }
}

class MockHubConnector {
    constructor() {}
    async getAllConfig() { return null; }
}

const validFileConfig = {
    configs: [
        {
            coin:    'BTC',
            network: 'regtest',
            indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Indexer' },
            decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'XChain_BTC_Regtest_Decoder' }
        }
    ]
};

function loadConfig(overrides) {
    return proxyquire('../../../src/config.js', Object.assign({
        'fs':                   fsStub,
        'path':                 path,
        './utility.js':         MockUtility,
        './XChainHubConnector': MockHubConnector,
        './config.json':        validFileConfig
    }, overrides || {}));
}

describe('SM-01: Config loads successfully', function () {

    it('returns a config object with all required top-level keys', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        expect(result).to.be.an('object');
        expect(result).to.have.property('COIN_NETWORKS').that.is.an('object');
        expect(result).to.have.property('COIN_PREFIXES').that.is.an('object');
        expect(result).to.have.property('COIN_SUPPORTED').that.is.an('object');
        expect(result).to.have.property('COIN_AVAILABLE').that.is.an('object');
        expect(result).to.have.property('API').that.is.an('object');
    });

    it('COIN_NETWORKS contains BTC, LTC, DOGE', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        expect(result.COIN_NETWORKS).to.include.keys('BTC', 'LTC', 'DOGE');
    });

    it('COIN_SUPPORTED contains all 9 coin/network combinations', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        expect(Object.keys(result.COIN_SUPPORTED)).to.have.lengthOf(9);
        expect(result.COIN_SUPPORTED).to.include.keys('BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC', 'DOGE', 'TDOGE', 'RDOGE');
    });

    it('COIN_AVAILABLE includes the configured coin/network', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        // validFileConfig has BTC/regtest → prefix 'R' → code 'RBTC'
        expect(result.COIN_AVAILABLE).to.have.property('RBTC');
    });

    it('API object contains host, port, and ssl keys', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        expect(result.API).to.have.property('host');
        expect(result.API).to.have.property('port').that.is.an('object');
        expect(result.API.port).to.have.property('http');
        expect(result.API.port).to.have.property('https');
        expect(result.API).to.have.property('ssl').that.is.an('object');
    });

    it('coin-specific config contains chain and network database info', async function () {
        const config = loadConfig();
        const result = await config.getConfig(null, null, false);

        expect(result).to.have.property('BTC').that.is.an('object');
        expect(result.BTC).to.have.property('chain').that.is.an('object');
        expect(result.BTC).to.have.property('regtest').that.is.an('object');
        expect(result.BTC.regtest).to.have.property('database').that.is.an('object');
        expect(result.BTC.regtest.database).to.have.property('indexer');
        expect(result.BTC.regtest.database).to.have.property('decoder');
    });

});

describe('SM-02: Config rejects no valid configuration', function () {

    it('throws "No valid configuration" when config.json is missing and NODE_CONFIG is unset', async function () {
        const config = proxyquire('../../../src/config.js', {
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

describe('SM-03: Config skips a coin with a missing config file', function () {

    it('skips a non-existent coin instead of throwing, so startup survives', async function () {
        const invalidConfig = {
            configs: [
                {
                    coin:    'INVALID',
                    network: 'mainnet',
                    indexer: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'test' },
                    decoder: { db_host: '127.0.0.1', db_port: 3306, user: 'root', pass: 'pass', name: 'test' }
                }
            ]
        };

        // existsSync must return false for the invalid coin file
        const invalidFsStub = {
            readFileSync: sinon.stub().returns('mock-cert'),
            existsSync:   sinon.stub().returns(false)
        };

        const config = proxyquire('../../../src/config.js', {
            'fs':                   invalidFsStub,
            'path':                 path,
            './utility.js':         MockUtility,
            './XChainHubConnector': MockHubConnector,
            './config.json':        invalidConfig
        });

        // The coin's config file is missing (existsSync -> false). Rather than
        // throwing and taking the whole explorer down at startup, the loader skips
        // that entry and still returns a usable config object.
        const result = await config.getConfig(null, null, false);
        expect(result).to.be.an('object');
        expect(result).to.not.have.property('INVALID');
    });

});

describe('SM-04: SSL certificates are accessible', function () {

    it('config.js loads when SSL files are present (stubbed)', function () {
        // If config.js loads without error, SSL readFileSync calls succeeded
        const config = loadConfig();
        expect(config).to.have.property('getConfig').that.is.a('function');
    });

    it('config.js throws when SSL cert files are missing', function () {
        const missingFsStub = {
            readFileSync: sinon.stub().throws(new Error('ENOENT: no such file')),
            existsSync:   sinon.stub().returns(true)
        };

        try {
            proxyquire('../../../src/config.js', {
                'fs':                   missingFsStub,
                'path':                 path,
                './utility.js':         MockUtility,
                './XChainHubConnector': MockHubConnector,
                './config.json':        validFileConfig
            });
            expect.fail('Expected an error to be thrown');
        } catch (err) {
            expect(err.message).to.include('ENOENT');
        }
    });

});
