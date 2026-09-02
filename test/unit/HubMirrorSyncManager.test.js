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

// Embedded hub-DB mirror lifecycle: opt-in gating via checkpoint.self_sync,
// schema-then-tables-then-client ordering, one client per unique physical
// target, and the status surface the staleness gating reads.

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function load({ env = {} } = {}) {
    const order = [];

    const ensureDatabase = sinon.stub().callsFake(async () => { order.push('ensureDatabase'); });
    const poolEnd        = sinon.stub().resolves();
    class FakePool {
        constructor(target){ this.target = target; this.ensureDatabase = ensureDatabase; this.end = poolEnd; }
        async doQuery(){ return []; }
    }

    const syncStart = sinon.stub().callsFake(async () => { order.push('syncStart'); });
    const syncStop  = sinon.stub();
    class FakeSync {
        constructor(pool, opts){
            this.pool = pool; this.opts = opts;
            this.start = syncStart; this.stop = syncStop;
            this.streamWatermark = 0; this._bootstrapDrained = false;
        }
    }
    FakeSync.ensureTables = sinon.stub().callsFake(async () => { order.push('ensureTables'); });

    // Drift reconciler: must run after ensureTables (tables exist) and
    // before syncStart (the client's column cache must see the migrated shape).
    const ensureMirrorColumns = sinon.stub().callsFake(async () => { order.push('ensureMirrorColumns'); return []; });

    const saved = process.env.HUB_API_URL;
    if (env.HUB_API_URL !== undefined) process.env.HUB_API_URL = env.HUB_API_URL;
    else delete process.env.HUB_API_URL;

    const HubMirrorSyncManager = proxyquire('../../src/HubMirrorSyncManager.js', {
        './hub_db_sync.js':    FakeSync,
        './hub-mirror-pool.js': FakePool,
        './hub-mirror-migrate.js': { ensureMirrorColumns }
    });

    const restoreEnv = () => {
        if (saved === undefined) delete process.env.HUB_API_URL;
        else process.env.HUB_API_URL = saved;
    };

    return { HubMirrorSyncManager, FakeSync, ensureDatabase, poolEnd, syncStart, syncStop, order, restoreEnv };
}

function makeExplorer(checkpointDb) {
    return { util, db: { checkpointDb } };
}

const TARGET = (over = {}) => ({
    name: 'XChain_Hub_Mirror', chain: 'BTC', network: 'regtest',
    selfSync: true, host: '127.0.0.1', port: 3306, user: 'u', pass: 'p', ...over
});

describe('HubMirrorSyncManager', function () {

    afterEach(function () { sinon.restore(); });

    it('is a no-op when no checkpoint entry sets self_sync', async function () {
        const { HubMirrorSyncManager, syncStart, restoreEnv } = load({ env: { HUB_API_URL: 'http://hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ BTC: TARGET({ selfSync: false }) }));
            await mgr.start();
            expect(mgr.instances.size).to.equal(0);
            expect(syncStart.called).to.equal(false);
        } finally { restoreEnv(); }
    });

    it('registers an UNCONFIGURED instance (not a skip) when self_sync has no hub URL', async function () {
        // The defect: skipping left managesCoin() false, so the staleness gate
        // treated the coin as externally maintained and served the frozen mirror.
        const { HubMirrorSyncManager, syncStart, restoreEnv } = load({});
        const errLog = sinon.stub(console, 'error');
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ BTC: TARGET() }));
            await mgr.start();
            expect(syncStart.called).to.equal(false, 'no writer can be started');
            expect(mgr.instances.size).to.equal(1);
            expect(mgr.managesCoin('BTC')).to.equal(true, 'the gate must see this coin');
            const status = mgr.statusForCoin('BTC');
            expect(status.configured).to.equal(false);
            expect(status.reason).to.equal('HUB_URL_MISSING');
            expect(status.bootstrapDrained).to.equal(false);
            expect(errLog.calledWithMatch(sinon.match(/HUB_API_URL/))).to.equal(true);
        } finally { restoreEnv(); }
    });

    it('re-reports an unconfigured target on an interval instead of once at boot', async function () {
        const clock = sinon.useFakeTimers(1000);
        const { HubMirrorSyncManager, restoreEnv } = load({});
        const errLog = sinon.stub(console, 'error');
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ BTC: TARGET() }));
            await mgr.start();
            expect(errLog.callCount).to.equal(1, 'one line at start');
            mgr.statusForCoin('BTC');
            mgr.statusForCoin('BTC');
            expect(errLog.callCount).to.equal(1, 'throttled inside the interval');
            clock.tick(5 * 60 * 1000 + 1);
            mgr.statusForCoin('BTC');
            expect(errLog.callCount).to.equal(2, 'reported again after the interval');
        } finally { clock.restore(); restoreEnv(); }
    });

    it('takes the hub URL from the checkpoint config block, over the env', async function () {
        const { HubMirrorSyncManager, FakeSync, restoreEnv } = load({ env: { HUB_API_URL: 'http://env-hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({
                RBTC: TARGET({ hubUrl: 'http://config-hub:10000' })
            }));
            await mgr.start();
            expect(mgr.instanceForCoin('RBTC').sync.opts.hubUrl).to.equal('http://config-hub:10000');
            expect(FakeSync.ensureTables.called).to.equal(true);
        } finally { restoreEnv(); }
    });

    it('syncs on the config-borne hub URL alone, with no HUB_API_URL in the env', async function () {
        // The venue case: self_sync arrived over the hub config push while the
        // container env carried no HUB_API_URL at all.
        const { HubMirrorSyncManager, syncStart, restoreEnv } = load({});
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({
                RBTC: TARGET({ hubUrl: 'http://config-hub:10000' })
            }));
            await mgr.start();
            expect(syncStart.calledOnce).to.equal(true);
            const inst = mgr.instanceForCoin('RBTC');
            expect(inst.unconfigured).to.equal(false);
            expect(inst.sync.opts.hubUrl).to.equal('http://config-hub:10000');
            expect(mgr.statusForCoin('RBTC').configured).to.equal(true);
        } finally { restoreEnv(); }
    });

    it('passes the resolved env hub URL to the client explicitly', async function () {
        const { HubMirrorSyncManager, restoreEnv } = load({ env: { HUB_API_URL: 'http://env-hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ RBTC: TARGET() }));
            await mgr.start();
            expect(mgr.instanceForCoin('RBTC').sync.opts.hubUrl).to.equal('http://env-hub:10000');
        } finally { restoreEnv(); }
    });

    it('creates schema, then tables, then starts the client (in that order)', async function () {
        const { HubMirrorSyncManager, FakeSync, order, restoreEnv } = load({ env: { HUB_API_URL: 'http://hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ RBTC: TARGET() }));
            await mgr.start();
            expect(order).to.deep.equal(['ensureDatabase', 'ensureTables', 'ensureMirrorColumns', 'syncStart']);
            expect(FakeSync.ensureTables.firstCall.args[1]).to.match(/sql[\\/]hub-mirror$/);
            expect(mgr.instances.size).to.equal(1);
        } finally { restoreEnv(); }
    });

    it('dedupes by unique (host, port, schema) target, not by coin', async function () {
        const { HubMirrorSyncManager, syncStart, restoreEnv } = load({ env: { HUB_API_URL: 'http://hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({
                RBTC:  TARGET(),
                RLTC:  TARGET({ chain: 'LTC' }),
                RDOGE: TARGET({ chain: 'DOGE', host: '10.0.0.2' })
            }));
            await mgr.start();
            expect(mgr.instances.size).to.equal(2, 'two physical targets');
            expect(syncStart.callCount).to.equal(2);
            expect(mgr.managesCoin('RBTC')).to.equal(true);
            expect(mgr.managesCoin('RLTC')).to.equal(true);
            expect(mgr.managesCoin('RDOGE')).to.equal(true);
            expect(mgr.managesCoin('BTC')).to.equal(false);
        } finally { restoreEnv(); }
    });

    it('stop() stops every client and closes every pool', async function () {
        const { HubMirrorSyncManager, syncStop, poolEnd, restoreEnv } = load({ env: { HUB_API_URL: 'http://hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ RBTC: TARGET() }));
            await mgr.start();
            await mgr.stop();
            expect(syncStop.calledOnce).to.equal(true);
            expect(poolEnd.calledOnce).to.equal(true);
            expect(mgr.instances.size).to.equal(0);
        } finally { restoreEnv(); }
    });

    it('statusForCoin reports watermark lag and bootstrap state; null when unmanaged', async function () {
        const clock = sinon.useFakeTimers(1000000 * 1000);
        const { HubMirrorSyncManager, restoreEnv } = load({ env: { HUB_API_URL: 'http://hub:10000' } });
        try {
            const mgr = new HubMirrorSyncManager(makeExplorer({ RBTC: TARGET() }));
            await mgr.start();
            const inst = mgr.instanceForCoin('RBTC');
            inst.sync.streamWatermark   = 1000000 - 42;
            inst.sync._bootstrapDrained = true;
            const status = mgr.statusForCoin('RBTC');
            expect(status.bootstrapDrained).to.equal(true);
            expect(status.mirrorLagSeconds).to.equal(42);
            expect(status.target.name).to.equal('XChain_Hub_Mirror');
            expect(mgr.statusForCoin('RLTC')).to.equal(null);

            inst.sync.streamWatermark = 0;
            expect(mgr.statusForCoin('RBTC').mirrorLagSeconds).to.equal(null,
                'no heartbeat yet means lag is unknown, not zero');
        } finally { clock.restore(); restoreEnv(); }
    });
});
