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
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub, getFullConfig } = require('../../../fixtures/mock-config.js');
const { resolveHubUrl }        = require('../../../../src/mirror/url.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function makeDb(checkpointDb, pools) {
    const db = new Database({ configInfo, util });
    db.pools        = pools || { RBTC: {} };
    db.checkpointDb = checkpointDb;
    return db;
}

function loadSyncManager() {
    class FakePool {
        async ensureDatabase() {}
        async end() {}
    }
    class FakeSync {
        constructor(pool, options) {
            this.pool = pool;
            this.options = options;
        }
        async start() {}
        stop() {}
    }
    FakeSync.ensureTables = async () => {};

    const HubMirrorSyncManager = proxyquire('../../../../src/mirror/sync_manager.js', {
        '../hub/hub_db_sync.js': FakeSync,
        './pool.js': FakePool,
        './migrate.js': { ensureMirrorColumns: async () => {} }
    });
    return { HubMirrorSyncManager, FakeSync };
}

function makeExplorer(checkpointDb) {
    return { util, db: { checkpointDb } };
}

function isolateHubEnvironment(includeAllowOverride) {
    let savedEnv;
    beforeEach(function () {
        savedEnv = {
            url: process.env.HUB_API_URL,
            seeds: process.env.HUB_SEED_URLS,
            allow: process.env.ALLOW_NO_COLOCATED_HUB_DB
        };
        delete process.env.HUB_API_URL;
        delete process.env.HUB_SEED_URLS;
        if(includeAllowOverride) delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
    });
    afterEach(function () {
        if(savedEnv.url === undefined) delete process.env.HUB_API_URL;
        else process.env.HUB_API_URL = savedEnv.url;
        if(savedEnv.seeds === undefined) delete process.env.HUB_SEED_URLS;
        else process.env.HUB_SEED_URLS = savedEnv.seeds;
        if(includeAllowOverride){
            if(savedEnv.allow === undefined) delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
            else process.env.ALLOW_NO_COLOCATED_HUB_DB = savedEnv.allow;
        }
    });
}

const SELF_SYNC = (over = {}) => ({
    name: 'XChain_Hub_Mirror', chain: 'BTC', network: 'regtest',
    selfSync: true, hubUrl: '', host: '127.0.0.1', port: 3306, user: 'u', pass: 'p', ...over
});

describe('checkpoint self_sync / hub-endpoint pairing', function () {

    isolateHubEnvironment(true);

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

        it('does not resolve a seed list as a current hub URL', function () {
            expect(resolveHubUrl({ hubSeedUrls: 'default' })).to.equal('');
        });
    });

});

describe('checkpoint self_sync / hub-endpoint pairing', function () {

    isolateHubEnvironment(true);

    describe('_assertCheckpointDbForServingCoins()', function () {
        it('refuses to start when a serving coin has neither seeds nor a hub endpoint', function () {
            const db = makeDb({ RBTC: SELF_SYNC() });
            expect(() => db.assertCheckpointDbForServingCoins()).to.throw(/no hub endpoint/i);
            expect(() => db.assertCheckpointDbForServingCoins()).to.throw(/RBTC/);
        });

        it('starts when only hub seeds ride in the checkpoint block', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ hubSeedUrls: 'default' }) });
            expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('refuses a whitespace-only hub seed list with no hub endpoint', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ hubSeedUrls: '   ' }) });
            expect(() => db.assertCheckpointDbForServingCoins()).to.throw(/no hub endpoint/i);
        });

        it('starts when the hub URL rides in the checkpoint block', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ hubUrl: 'http://hub:10000' }) });
            expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('starts when only the HUB_API_URL env names the hub', function () {
            process.env.HUB_API_URL = 'http://env-hub:10000';
            const db = makeDb({ RBTC: SELF_SYNC() });
            expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('starts when only the HUB_SEED_URLS env names hubs', function () {
            process.env.HUB_SEED_URLS = 'http://seed-a:10000,http://seed-b:10000';
            const db = makeDb({ RBTC: SELF_SYNC() });
            expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
        });

        it('leaves externally-maintained (non-self_sync) schemas alone', function () {
            const db = makeDb({ RBTC: SELF_SYNC({ selfSync: false }) });
            expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
        });

    });

});

describe('checkpoint hub selector wiring', function () {

    isolateHubEnvironment(false);

    it('builds a distinct unpinned selector for each seed-configured mirror target', async function () {
        const { HubMirrorSyncManager } = loadSyncManager();
        const manager = new HubMirrorSyncManager(makeExplorer({
            TBTC: SELF_SYNC({
                network: 'testnet', hubSeedUrls: 'http://seed-a:10000,http://seed-b:10000'
            }),
            TLTC: SELF_SYNC({
                name: 'XChain_Hub_Mirror_LTC', chain: 'LTC', network: 'testnet', port: 3307,
                hubSeedUrls: 'http://seed-a:10000,http://seed-b:10000'
            })
        }));

        await manager.start();
        const btc = manager.instanceForCoin('TBTC');
        const ltc = manager.instanceForCoin('TLTC');
        expect(btc.selector).to.not.equal(ltc.selector);
        expect(btc.sync.options.selector).to.equal(btc.selector);
        expect(ltc.sync.options.selector).to.equal(ltc.selector);
        expect(btc.selector.status().pinned).to.equal(false);
        expect(btc.selector.status().candidates)
            .to.have.members(['http://seed-a:10000', 'http://seed-b:10000']);
        expect(btc.sync.options.hubUrl).to.equal(btc.selector.current());
    });

    it('uses environment seeds when the checkpoint target has none', async function () {
        process.env.HUB_SEED_URLS = 'http://env-a:10000,http://env-b:10000';
        const { HubMirrorSyncManager } = loadSyncManager();
        const manager = new HubMirrorSyncManager(makeExplorer({ TBTC: SELF_SYNC({ network: 'testnet' }) }));

        await manager.start();
        const selector = manager.instanceForCoin('TBTC').sync.options.selector;
        expect(selector.status().pinned).to.equal(false);
        expect(selector.status().candidates)
            .to.have.members(['http://env-a:10000', 'http://env-b:10000']);
    });

    it('keeps a configured hub URL pinned when no seeds are configured', async function () {
        process.env.HUB_API_URL = 'http://pinned-hub:10000';
        const { HubMirrorSyncManager } = loadSyncManager();
        const manager = new HubMirrorSyncManager(makeExplorer({ TBTC: SELF_SYNC({ network: 'testnet' }) }));

        await manager.start();
        const selector = manager.instanceForCoin('TBTC').sync.options.selector;
        expect(selector.status()).to.deep.equal({
            current: 'http://pinned-hub:10000',
            candidates: ['http://pinned-hub:10000'],
            pinned: true
        });
        expect(selector.advance('test')).to.equal('http://pinned-hub:10000');
    });
});

describe('checkpoint hub seed propagation', function () {

    it('carries hub_seed_urls into the checkpoint target', async function () {
        const config = getFullConfig();
        config.BTC.mainnet.database.checkpoint.self_sync = true;
        config.BTC.mainnet.database.checkpoint.hub_seed_urls = 'default';
        const db = new Database({ configInfo: createConfigInfoStub(config), util });
        await db.setupConnectionPools();
        expect(db.checkpointDb.BTC.hubSeedUrls).to.equal('default');
    });

});

describe('checkpoint self_sync / hub-endpoint pairing', function () {

    isolateHubEnvironment(true);

    describe('_assertCheckpointDbForServingCoins()', function () {

        it('downgrades to a warning under ALLOW_NO_COLOCATED_HUB_DB=1', function () {
            process.env.ALLOW_NO_COLOCATED_HUB_DB = '1';
            const warned = [];
            const saved  = console.warn;
            console.warn = (m) => warned.push(String(m));
            try {
                const db = makeDb({ RBTC: SELF_SYNC() });
                expect(() => db.assertCheckpointDbForServingCoins()).to.not.throw();
            } finally { console.warn = saved; }
            expect(warned.join(' ')).to.match(/no hub endpoint/i);
        });

        it('still refuses a MISSING checkpoint schema, unchanged', function () {
            const db = makeDb({}, { RBTC: {} });
            expect(() => db.assertCheckpointDbForServingCoins()).to.throw(/Checkpoint schema missing/);
        });

        it('names every affected coin, not just the first', function () {
            const db = makeDb(
                { RBTC: SELF_SYNC(), RLTC: SELF_SYNC({ chain: 'LTC' }) },
                { RBTC: {}, RLTC: {} }
            );
            expect(() => db.assertCheckpointDbForServingCoins()).to.throw(/RBTC, RLTC/);
        });
    });
});
