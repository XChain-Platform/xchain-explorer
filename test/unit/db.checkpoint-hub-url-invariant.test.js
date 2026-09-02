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

// Startup invariant for the self-synced hub mirror: database.checkpoint.self_sync
// and the hub endpoint that mirror is written from must arrive TOGETHER. They are
// emitted by different conditions on different delivery paths (the hub's config
// push versus a container env written at install time), so without this invariant
// an explorer can be told to self-sync with no hub to sync from, which costs one
// warning line at boot and then serves the frozen mirror for the life of the process.

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { resolveHubUrl }        = require('../../src/hub-mirror-url.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function makeDb(checkpointDb, pools) {
    const db = new Database({ configInfo, util });
    db.pools        = pools || { RBTC: {} };
    db.checkpointDb = checkpointDb;
    return db;
}

const SELF_SYNC = (over = {}) => ({
    name: 'XChain_Hub_Mirror', chain: 'BTC', network: 'regtest',
    selfSync: true, hubUrl: '', host: '127.0.0.1', port: 3306, user: 'u', pass: 'p', ...over
});

describe('checkpoint self_sync / hub-endpoint pairing', function () {

    let savedEnv;

    beforeEach(function () {
        savedEnv = { url: process.env.HUB_API_URL, allow: process.env.ALLOW_NO_COLOCATED_HUB_DB };
        delete process.env.HUB_API_URL;
        delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
    });

    afterEach(function () {
        if (savedEnv.url === undefined) delete process.env.HUB_API_URL;
        else process.env.HUB_API_URL = savedEnv.url;
        if (savedEnv.allow === undefined) delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
        else process.env.ALLOW_NO_COLOCATED_HUB_DB = savedEnv.allow;
    });

    describe('resolveHubUrl()', function () {
        it('prefers the config-borne hub_url over the env', function () {
            process.env.HUB_API_URL = 'http://env-hub:10000';
            expect(resolveHubUrl({ hubUrl: 'http://config-hub:10000' })).to.equal('http://config-hub:10000');
        });

        it('falls back to HUB_API_URL for hand-written config.json deployments', function () {
            process.env.HUB_API_URL = 'http://env-hub:10000';
            expect(resolveHubUrl({ hubUrl: '' })).to.equal('http://env-hub:10000');
        });

        it('is empty (never a partial URL) when neither source names one', function () {
            expect(resolveHubUrl({})).to.equal('');
            expect(resolveHubUrl(null)).to.equal('');
        });

        it('treats a whitespace-only value as absent', function () {
            expect(resolveHubUrl({ hubUrl: '   ' })).to.equal('');
        });
    });

    describe('_assertCheckpointDbForServingCoins()', function () {
        it('refuses to start when a serving coin self-syncs with no hub endpoint', function () {
            const db = makeDb({ RBTC: SELF_SYNC() });
            expect(() => db._assertCheckpointDbForServingCoins()).to.throw(/no hub endpoint/i);
            expect(() => db._assertCheckpointDbForServingCoins()).to.throw(/RBTC/);
        });

        it('starts when the hub URL rides in the checkpoint block', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ hubUrl: 'http://hub:10000' }) });
            expect(() => db._assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('starts when only the HUB_API_URL env names the hub', function () {
            process.env.HUB_API_URL = 'http://env-hub:10000';
            const db = makeDb({ RBTC: SELF_SYNC() });
            expect(() => db._assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('leaves externally-maintained (non-self_sync) schemas alone', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ selfSync: false }) });
            expect(() => db._assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('downgrades to a warning under ALLOW_NO_COLOCATED_HUB_DB=1', function () {
            process.env.ALLOW_NO_COLOCATED_HUB_DB = '1';
            const warned = [];
            const saved  = console.warn;
            console.warn = (m) => warned.push(String(m));
            try {
                const db = makeDb({ RBTC: SELF_SYNC() });
                expect(() => db._assertCheckpointDbForServingCoins()).to.not.throw();
            } finally { console.warn = saved; }
            expect(warned.join(' ')).to.match(/no hub endpoint/i);
        });

        it('still refuses a MISSING checkpoint schema, unchanged', function () {
            const db = makeDb({}, { RBTC: {} });
            expect(() => db._assertCheckpointDbForServingCoins()).to.throw(/Checkpoint schema missing/);
        });

        it('names every affected coin, not just the first', function () {
            const db = makeDb(
                { RBTC: SELF_SYNC(), RLTC: SELF_SYNC({ chain: 'LTC' }) },
                { RBTC: {}, RLTC: {} }
            );
            expect(() => db._assertCheckpointDbForServingCoins()).to.throw(/RBTC, RLTC/);
        });
    });
});
