// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru();

const MODULE_PATH = '../../../../src/hub/hub_db_sync/hub_selector.js';

function loadSelector(env) {
    return proxyquire(MODULE_PATH, {
        './env.js': {
            readEnvNow: (key) => env[key]
        }
    });
}

function seededRandomInt(seed) {
    let state = seed >>> 0;
    return function randomInt(upper) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % upper;
    };
}

function assertSingleConfiguredHubStaysSelected() {
    const selectorModule = loadSelector({ HUB_API_URL: 'http://only.example:10000' });
    const selector = selectorModule.createHubSelector('testnet');

    assert.strictEqual(selector.current(), 'http://only.example:10000');
    assert.strictEqual(selector.advance('connect_failure'), 'http://only.example:10000');
    assert.strictEqual(selector.current(), 'http://only.example:10000');
    assert.strictEqual(selector.status().pinned, true);
}

function assertSeededSelectionIsDeterministic() {
    const env = {
        HUB_SEED_URLS: [
            'http://a.example:10000',
            'http://b.example:10000',
            'http://c.example:10000',
            'http://d.example:10000'
        ].join(',')
    };
    const createHubSelector = loadSelector(env);
    const first = createHubSelector('testnet', { randomInt: seededRandomInt(7) });
    const second = createHubSelector('testnet', { randomInt: seededRandomInt(7) });
    const expected = [
        'http://b.example:10000',
        'http://d.example:10000',
        'http://a.example:10000',
        'http://c.example:10000'
    ];

    assert.deepStrictEqual(first.status().candidates, expected);
    assert.deepStrictEqual(second.status().candidates, expected);
    assert.strictEqual(first.current(), expected[0]);
}

function assertFailedHubWaitsForCycleWrap() {
    const { HubSelector } = loadSelector({});
    const selector = new HubSelector('testnet', {
        hubSeedUrls: 'http://a.example:10000,http://b.example:10000,http://c.example:10000',
        randomInt: (upper) => upper - 1
    });

    assert.strictEqual(selector.current(), 'http://a.example:10000');
    assert.strictEqual(selector.advance('connect_failure'), 'http://b.example:10000');
    assert.strictEqual(selector.current(), 'http://b.example:10000');
    assert.strictEqual(selector.advance('connect_failure'), 'http://c.example:10000');
    assert.strictEqual(selector.advance('connect_failure'), 'http://a.example:10000');
}

function assertEmptyHubListHasNoSelection() {
    const { HubSelector } = loadSelector({ HUB_SEED_URLS: '', HUB_API_URL: '' });
    const selector = new HubSelector('testnet');

    assert.strictEqual(selector.current(), null);
    assert.strictEqual(selector.advance('connect_failure'), null);
    assert.deepStrictEqual(selector.status(), {
        current: null,
        candidates: [],
        pinned: false
    });
}

describe('hub selector', function () {
    it('always chooses a single configured hub', assertSingleConfiguredHubStaysSelected);
    it('chooses several hubs deterministically for one seed', assertSeededSelectionIsDeterministic);
    it('skips a failed hub until the candidate cycle re-admits it', assertFailedHubWaitsForCycleWrap);
    it('represents an empty hub list with no current selection', assertEmptyHubListHasNoSelection);
});
