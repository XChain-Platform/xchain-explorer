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

const {
    ACTION_REF_PATTERN, expect, execCmdText, iconSuite, loadIconDownloader,
    makeExecStub, makeExplorer, makeMockConn, makeMockPool, makeStubs, path,
    setClock, sinon, tickClock,
} = require('./helpers.js');

{

    iconSuite('start() (disabled)', function () {
        it('returns without setting a timer when enabled=false', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({ iconDownload: { enabled: false } });

            const d = new IconDownloader(explorer);
            await d.start();

            expect(d.timer).to.equal(null);
        });

        it('returns without setting a timer when iconDownload config is absent', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({});

            const d = new IconDownloader(explorer);
            await d.start();

            expect(d.timer).to.equal(null);
        });
    });
}

{

    iconSuite('start() (enabled)', function () {
        it('sets a timer and merges user config over defaults', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            setClock(sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] }));

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 30, batchSize: 10 },
            });

            const d = new IconDownloader(explorer);
            // Stub runOnce so the immediate call doesn't actually run
            d.runOnce = sinon.stub().resolves();

            await d.start();

            expect(d.timer).to.not.equal(null);
            expect(d.cfg.enabled).to.equal(true);
            expect(d.cfg.intervalMinutes).to.equal(30);
            expect(d.cfg.batchSize).to.equal(10);
            // DEFAULTS survive for unset keys
            expect(d.cfg.maxAttempts).to.equal(4);
        });

        it('schedules runOnce via setImmediate on startup', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            setClock(sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] }));

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 60 },
            });

            const d = new IconDownloader(explorer);
            const calls = [];
            d.runOnce = sinon.stub().callsFake(async () => { calls.push('once'); });

            await d.start();
            // Before tick: setImmediate hasn't fired
            expect(calls.length).to.equal(0);

            // Tick the fake clock so setImmediate fires
            tickClock(0);
            await Promise.resolve(); // flush microtask

            expect(calls.length).to.equal(1);
        });

    });

    iconSuite('start() (enabled)', function () {
        it('fires runOnce on each interval tick', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            setClock(sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] }));

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 1 },
            });

            const d = new IconDownloader(explorer);
            const calls = [];
            d.runOnce = sinon.stub().callsFake(async () => { calls.push('tick'); });

            await d.start();
            // Advance one full interval (60 000 ms)
            tickClock(60_000);
            await Promise.resolve();

            expect(calls.length).to.be.at.least(1);
        });
    });
}

{

    iconSuite('stop()', function () {
        it('sets _stop and clears the timer', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            setClock(sinon.useFakeTimers({ toFake: ['setInterval', 'setImmediate', 'clearInterval'] }));

            const explorer = makeExplorer();
            explorer.configInfo.getConfig.resolves({
                iconDownload: { enabled: true, intervalMinutes: 60 },
            });

            const d = new IconDownloader(explorer);
            d.runOnce = sinon.stub().resolves();
            await d.start();
            expect(d.timer).to.not.equal(null);

            d.stop();
            expect(d._stop).to.equal(true);
            expect(d.timer).to.equal(null);
        });

        it('is safe to call when timer is null (disabled mode)', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            expect(() => d.stop()).to.not.throw();
            expect(d._stop).to.equal(true);
        });
    });
}

// runOnce is the re-entrancy guard around a sweep: a second call while one is still
// in flight must do nothing, and the in-flight flag has to clear afterwards even
// when a flavor throws, or the downloader wedges and never runs again.
{

    iconSuite('runOnce()', function () {
        it('skips if _running is already true', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d._running = true;
            d.listFlavors = sinon.stub().resolves([]);

            await d.runOnce();

            expect(d.listFlavors.callCount).to.equal(0);
        });

        it('sets _running during execution and clears it after', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            let seenRunning = false;
            d.listFlavors = sinon.stub().callsFake(async () => {
                seenRunning = d._running;
                return [];
            });

            await d.runOnce();

            expect(seenRunning).to.equal(true);
            expect(d._running).to.equal(false);
        });

        it('clears _running even when _processFlavor throws', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.listFlavors   = sinon.stub().resolves([{ coin: 'BTC', network: 'mainnet' }]);
            d.processFlavor = sinon.stub().rejects(new Error('boom'));

            await d.runOnce();

            expect(d._running).to.equal(false);
        });

    });

    iconSuite('runOnce()', function () {
        it('swallows per-flavor errors and continues to next flavor', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const processed = [];
            d.listFlavors = sinon.stub().resolves([
                { coin: 'BTC', network: 'mainnet' },
                { coin: 'LTC', network: 'mainnet' },
            ]);
            d.processFlavor = sinon.stub().callsFake(async (flavor) => {
                if (flavor.coin === 'BTC') throw new Error('btc fail');
                processed.push(flavor.coin);
            });

            await d.runOnce();

            expect(processed).to.deep.equal(['LTC']);
        });

        it('stops iterating flavors when _stop is set', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const processed = [];
            d.listFlavors = sinon.stub().resolves([
                { coin: 'BTC', network: 'mainnet' },
                { coin: 'LTC', network: 'mainnet' },
            ]);
            d.processFlavor = sinon.stub().callsFake(async (flavor) => {
                processed.push(flavor.coin);
                d._stop = true;   // stop after first
            });

            await d.runOnce();

            expect(processed).to.deep.equal(['BTC']);
        });
    });
}
