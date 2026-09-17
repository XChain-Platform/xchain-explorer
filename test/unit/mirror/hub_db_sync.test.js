// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/hub/hub_db_sync.js (the explorer's byte-identical vendored
// copy of the hub-mirror client). These exercise the price-sync barrier logic
// in isolation with a stubbed local-DB query: no network, WS, or MariaDB. The
// barrier gates block processing on the local price mirror catching up, so its
// enabled-state, height adoption, immediate-satisfy, and timeout paths are the
// consensus-relevant surface to pin.

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

// A HubDbSync backed by a stubbed doQuery that reports MAX(reference_block).
function makeSync(maxReferenceBlock, opts = {}) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock, ts: 0 }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', ...opts });
    return { sync, hubDb, doQuery };
}

describe('HubDbSync price-sync barrier (explorer vendored copy)', function () {
    it('exports the class plus the ensureTables helper', function () {
        assert.strictEqual(typeof HubDbSync, 'function');
        assert.strictEqual(typeof HubDbSync.ensureTables, 'function');
    });

    it('is enabled only with both a hub URL and a hub DB', function () {
        const { sync } = makeSync(0);
        assert.strictEqual(sync.enabled, true);
        assert.strictEqual(sync.priceSyncHeight, 0);

        const noUrl = new HubDbSync({ doQuery: sinon.stub() }, { hubUrl: '' });
        assert.strictEqual(noUrl.enabled, false, 'no hub URL disables the client');

        const noDb = new HubDbSync(null, { hubUrl: 'http://hub.test' });
        assert.strictEqual(noDb.enabled, false, 'no hub DB disables the client');
    });

    it('_refreshPriceSyncHeight adopts MAX(reference_block) from the local mirror', async function () {
        const { sync } = makeSync(123);
        await sync.refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 123);
    });

    it('_refreshPriceSyncHeight leaves the height untouched when the table is not ready', async function () {
        const { sync, doQuery } = makeSync(0);
        sync.priceSyncHeight = 50;
        doQuery.rejects(new Error("Table 'price_snapshots' doesn't exist"));
        await sync.refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 50, 'a failed query must not reset the barrier to 0');
    });

});

describe('HubDbSync price-sync barrier (explorer vendored copy)', function () {

    it('a reconnect while a table page is pending cannot certify the stale full drain', async function () {
        const { sync } = makeSync(0);
        sync.running = true;
        const pageStarted = {};
        pageStarted.promise = new Promise(resolve => { pageStarted.resolve = resolve; });
        const releasePage = {};
        releasePage.promise = new Promise(resolve => { releasePage.resolve = resolve; });
        const bootstrapTable = sinon.stub(sync, 'bootstrapTable');
        bootstrapTable.onFirstCall().callsFake(async () => {
            pageStarted.resolve();
            await releasePage.promise;
            return 55;
        });
        bootstrapTable.resolves(55);
        const certifyFullDrain = sinon.spy(sync, 'certifyFullDrain');
        const scheduleBootstrapRetry = sinon.stub(sync, 'scheduleBootstrapRetry');

        const draining = sync.bootstrapAll();
        await pageStarted.promise;
        sync.ws = { generation: 'closing' };
        sync.resetOnSocketClose();
        sync.ws = { generation: 'replacement' };
        sync.adoptReadyFrame(sync.ws, { type: 'ready', watermark: 56 });
        releasePage.resolve();
        await draining;

        assert.ok(certifyFullDrain.notCalled, 'the prior connection drain must not certify');
        assert.strictEqual(sync._bootstrapDrained, false, 'the replacement connection gate stays closed');
        assert.strictEqual(sync.streamWatermark, 0, 'the stale drain cannot advance the watermark');
        assert.ok(scheduleBootstrapRetry.calledOnce, 'the replacement connection gets a fresh drain');
    });

    it('waitForPriceSyncHeight resolves immediately when already caught up', async function () {
        const { sync } = makeSync(0);
        sync.priceSyncHeight = 200;
        const got = await sync.waitForPriceSyncHeight(150, 1000);
        assert.strictEqual(got, 200);
    });

    it('waitForPriceSyncHeight resolves once a later sync raises the height', async function () {
        const { sync, doQuery } = makeSync(80);
        const pending = sync.waitForPriceSyncHeight(100, 2000);
        assert.strictEqual(sync._priceWaiters.length, 1, 'a not-yet-reached target parks a waiter');
        doQuery.callsFake(async () => [{ h: 120, ts: 0 }]);
        await sync.refreshPriceSyncHeight();
        const got = await pending;
        assert.strictEqual(got, 120);
        assert.strictEqual(sync._priceWaiters.length, 0, 'waiter cleared on resolve');
    });

    it('waitForPriceSyncHeight rejects on timeout when the mirror stays behind', async function () {
        const { sync } = makeSync(10);
        sync.priceSyncHeight = 10;
        await assert.rejects(
            sync.waitForPriceSyncHeight(100, 50),
            /price sync barrier timed out/
        );
        assert.strictEqual(sync._priceWaiters.length, 0, 'timed-out waiter removed');
    });

    it('waitForPriceSyncHeight is a no-op resolve when the client is disabled', async function () {
        const disabled = new HubDbSync(null, { hubUrl: '' });
        const got = await disabled.waitForPriceSyncHeight(999, 10);
        assert.strictEqual(got, disabled.priceSyncHeight);
    });
});
