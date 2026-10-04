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
const { buildHubSelector } = require('../../../src/mirror/hub_selection.js');

function isolateHubEnvironment(){
    let savedEnv;
    beforeEach(function () {
        savedEnv = {
            seeds: process.env.HUB_SEED_URLS,
            url: process.env.HUB_API_URL
        };
        delete process.env.HUB_SEED_URLS;
        delete process.env.HUB_API_URL;
    });

    afterEach(function () {
        if(savedEnv.seeds === undefined) delete process.env.HUB_SEED_URLS;
        else process.env.HUB_SEED_URLS = savedEnv.seeds;
        if(savedEnv.url === undefined) delete process.env.HUB_API_URL;
        else process.env.HUB_API_URL = savedEnv.url;
    });
}

describe('hub mirror selector network defaults', function () {

    isolateHubEnvironment();

    it('expands the default testnet seeds', function () {
        let selector = buildHubSelector({ network: 'testnet', hubSeedUrls: 'default' });
        expect(selector.status()).to.deep.include({ pinned: false });
        expect(selector.status().candidates).to.have.members([
            'http://validator01.xchain.io:10002',
            'http://validator02.xchain.io:10002',
            'http://validator03.xchain.io:10002',
            'http://validator04.xchain.io:10002',
            'http://validator05.xchain.io:10002'
        ]);
    });

    it('expands the default mainnet seeds', function () {
        let selector = buildHubSelector({ network: 'mainnet', hubSeedUrls: 'default' });
        expect(selector.status().candidates).to.have.members([
            'http://validator01.xchain.io:10001',
            'http://validator02.xchain.io:10001',
            'http://validator03.xchain.io:10001',
            'http://validator04.xchain.io:10001',
            'http://validator05.xchain.io:10001'
        ]);
    });

    it('refuses default seeds for regtest', function () {
        expect(() => buildHubSelector({ network: 'regtest', hubSeedUrls: 'default' }))
            .to.throw('HUB_SEED_URLS default is unavailable for network "regtest"');
    });
});

describe('hub mirror selector modes', function () {

    isolateHubEnvironment();

    it('prefers config seeds over environment seeds and a hub URL', function () {
        process.env.HUB_SEED_URLS = 'http://env-hub:10000';
        process.env.HUB_API_URL = 'http://env-pinned:10000';
        let selector = buildHubSelector({
            network: 'testnet',
            hubSeedUrls: 'http://config-a:10000,http://config-b:10000',
            hubUrl: 'http://config-pinned:10000'
        });
        expect(selector.status().pinned).to.equal(false);
        expect(selector.status().candidates)
            .to.have.members(['http://config-a:10000', 'http://config-b:10000']);
    });

    it('uses environment seeds when the target carries none', function () {
        process.env.HUB_SEED_URLS = 'http://env-a:10000,http://env-b:10000';
        let selector = buildHubSelector({ network: 'testnet' }, { randomInt: (upper) => upper - 1 });
        expect(selector.status()).to.deep.equal({
            current: 'http://env-a:10000',
            candidates: ['http://env-a:10000', 'http://env-b:10000'],
            pinned: false
        });
    });

    it('builds a pinned selector when only a hub URL is available', function () {
        let selector = buildHubSelector({ network: 'testnet', hubUrl: 'http://pinned-hub:10000' });
        expect(selector.status()).to.deep.equal({
            current: 'http://pinned-hub:10000',
            candidates: ['http://pinned-hub:10000'],
            pinned: true
        });
        expect(selector.advance('test')).to.equal('http://pinned-hub:10000');
    });

    it('returns null when neither seeds nor a hub URL are available', function () {
        expect(buildHubSelector({ network: 'testnet' })).to.equal(null);
    });
});

describe('hub mirror selector randomness', function () {

    isolateHubEnvironment();

    it('passes the injected randomInt to the selector shuffle', function () {
        let calls = [];
        let selector = buildHubSelector({
            network: 'testnet',
            hubSeedUrls: 'http://seed-a:10000,http://seed-b:10000'
        }, {
            randomInt(upper){
                calls.push(upper);
                return upper - 1;
            }
        });
        expect(calls).to.deep.equal([2]);
        expect(selector.status().candidates)
            .to.deep.equal(['http://seed-a:10000', 'http://seed-b:10000']);
    });
});
