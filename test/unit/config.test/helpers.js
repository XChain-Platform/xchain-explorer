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

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const path       = require('path');

// Polyfill CustomEvent for Node 18 (added globally in 18.7+ but missing here).
if (typeof CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(type, options) {
            super(type, options);
            this.detail = options && options.detail !== undefined ? options.detail : null;
        }
    };
}

// Stub fs to prevent SSL cert reads at module load time.
// existsSync returns true so the coin-config file presence check passes;
// the real coin config files are loaded from disk via Node's native require.
const fsStub = {
    readFileSync: sinon.stub().returns('mock-cert'),
    existsSync:   sinon.stub().returns(true)
};

// A minimal hub config response: shape returned by XChainHubConnector.getAllConfig():
//   { bitcoin: { mainnet: { indexer: {...}, decoder: {...} } } }
const mockHubResponse = {
    bitcoin: {
        mainnet: {
            indexer: { host: 'hub-host', port: 3306, database: 'XChain_BTC_Mainnet_Indexer', user: 'u', password: 'p' },
            decoder: { host: 'hub-host', port: 3306, database: 'XChain_BTC_Mainnet_Decoder', user: 'u', password: 'p' }
        }
    }
};

// Hub connector stub: returned config is controlled per-test
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

// Load a fresh copy of config.js with the given stubs; each call to proxyquire
// produces a new module instance (fresh internal state).
function loadConfig(overrides) {
    return proxyquire('../../../src/config.js', Object.assign({
        'fs':                   fsStub,
        'path':                 path,
        './lib/utility.js':         MockUtility,
        './connectors/hub': MockHubConnector,
        './config.json':        mockFileConfig
    }, overrides || {}));
}

module.exports = {
    expect, sinon, proxyquire, path, fsStub, mockHubResponse, MockHubConnector,
    MockUtility, mockFileConfig, loadConfig
};
