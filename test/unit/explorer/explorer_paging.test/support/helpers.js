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
 * Unit tests for XChainExplorer.getPagingDataResults(config, data, total)
 */

const { expect }             = require('chai');
const proxyquire             = require('proxyquire');
const Utility                = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig, makeApiConfig, makeExplorerConfig } = require('../../../../fixtures/mock-query-args.js');

// Minimal Express mock: just enough for the XChainExplorer constructor.
const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

// Mock DB: getMaxMethodResults returns realistic values.
class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults(method) {
        const map = { getBalances: 500, getHolders: 500 };
        return map[method] !== undefined ? map[method] : 100;
    }
}

// Load XChainExplorer with express and the database swapped for the mocks above.
const XChainExplorer = proxyquire('../../../../../src/XChainExplorer.js', {
    'express': express,
    './db/index.js': MockDB
});

// Builds a minimal explorer instance without hitting network/fs.
function makeExplorer() {
    const configInfo = createConfigInfoStub();
    const explorer   = new XChainExplorer(mockApp, configInfo);
    return explorer;
}

function makeSend(overrides = {}) {
    return Object.assign({
        action_index: 1,
        block_index:  500,
        timestamp:    1700000000,
        source:       'addr1',
        tick:         'XCHAIN',
        amount:       '100',
        destination:  'addr2',
        status:       'valid'
    }, overrides);
}

function makeBalance(overrides = {}) {
    return Object.assign({
        tick:       'XCHAIN',
        amount:     '1000.00000000',
        supply:     '21000000.00000000',
        decimals:   8,
        coin_price: '0.00010000'
    }, overrides);
}

function makeHolder(overrides = {}) {
    return Object.assign({
        address:    'addr1',
        amount:     '5000.00000000',
        supply:     '21000000.00000000',
        decimals:   8,
        coin_price: '0.00010000'
    }, overrides);
}

function makeAddress(overrides = {}) {
    return Object.assign({
        action_index:   10,
        block_index:    500,
        timestamp:      1700000000,
        source:         'addr1',
        fee_preference: 'standard',
        require_memo:   0,
        dispenser_preference: 2,
        status:         'valid'
    }, overrides);
}

function makeIssue(overrides = {}) {
    return Object.assign({
        action_index:     50,
        block_index:      400,
        timestamp:        1699000000,
        source:           'addr1',
        tick:             'NEWTOKEN',
        max_supply:       '1000000',
        max_mint:         '100',
        status:           'valid',
        lock_max_supply:  '0',
        lock_mint:        '0',
        lock_mint_supply: '0',
        lock_max_mint:    '0',
        lock_description: '0',
        lock_sleep:       '0',
        lock_callback:    '0'
    }, overrides);
}

// Generic block row: actions sub-object matches the 26-field array
function makeBlock(overrides = {}) {
    return Object.assign({
        block_index: 500,
        timestamp:   1700000000,
        actions: {
            addresses:     1, airdrops:     0, batches:       0, broadcasts:    2,
            callbacks:     0, destroys:     0, dispensers:    1, dispenses:     0,
            dividends:     0, files:        0, issues:        3, links:         0,
            lists:         0, messages:     0, mints:         5, orders:        2,
            order_cancels: 0, order_edits:  0, order_matches: 1, sends:        10,
            sleeps:        0, swaps:        0, swap_cancels:  0, swap_edits:    0,
            swap_matches:  0, sweep:        0
        }
    }, overrides);
}

// Converts mathjs BigNumber results to plain JS numbers/strings.
function toNum(v) { return Number(v); }

const state = { explorer: null };

module.exports = {
    expect, makeConfig, makeApiConfig, makeExplorerConfig, makeExplorer, makeSend,
    makeBalance, makeHolder, makeAddress, makeIssue, makeBlock, toNum, state
};
