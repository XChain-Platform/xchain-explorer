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

// A sustained hub outage must not log in proportion to request count. Drives the
// real path (hub connector -> HubOperationalCache -> loadData) with N requests at a
// failing hub stub and compares the warn/error lines written at two request counts.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { logWindowed } = require('../../../../src/lib/log_window.js');

process.env.HUB_RETRY_DELAY_MS = '0';

function makeLogger(lines) {
    const rec = (level) => (event, fields) => lines.push({ level, event, fields: fields || {} });
    return { warn: rec('warn'), error: rec('error'), info() {}, debug() {} };
}

function build(lines) {
    const logger = makeLogger(lines);
    const observability = { getLogger: () => logger };
    const axiosStub = { post: sinon.stub().rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) };
    const ConfigSync = proxyquire('../../../../src/connectors/hub/config_sync.js', { '../../observability': observability });
    const Connector = proxyquire('../../../../src/connectors/hub', {
        'axios': axiosStub, '../observability': observability, './hub/config_sync.js': ConfigSync,
        '../lib/log_window.js': require('../../../../src/lib/log_window.js')
    });
    const savedUrl = process.env.HUB_API_URL;
    process.env.HUB_API_URL = 'http://hub.test:10000';
    const Cache = proxyquire('../../../../src/mirror/operational_cache.js', {
        '../connectors/hub': Connector, '../observability': observability,
        '../lib/log_window.js': require('../../../../src/lib/log_window.js')
    });
    const explorer = { util: new Utility(createConfigInfoStub()) };
    const cache = new Cache(explorer);
    if (savedUrl === undefined) delete process.env.HUB_API_URL; else process.env.HUB_API_URL = savedUrl;
    explorer.hubOperational = cache;
    const { loadData } = proxyquire('../../../../src/explorer/request/load_data.js', {
        '../../observability': observability, '../../lib/log_window.js': require('../../../../src/lib/log_window.js')
    });
    // The reader contract: null from the cache means unreachable past the ceiling.
    explorer.db = { getData: async (cfg) => {
        const rows = await cache.getRows('getproposals', { status: cfg.status });
        if (rows) return [rows, rows.length];
        const err = new Error('Hub unreachable');
        err.name = 'HubUnavailableError';
        throw err;
    } };
    return { explorer, loadData, axiosStub };
}

async function outage(requests) {
    const lines = [];
    const { explorer, loadData } = build(lines);
    const codes = await Promise.all(Array.from({ length: requests }, async (_, i) => {
        const st = { cfg: { status: 's' + i }, response: { code: 200, json: null } };
        await loadData(explorer, { path: '/x/' + i }, st);
        return st.response.code;
    }));
    return { lines: lines.filter((l) => l.level === 'warn' || l.level === 'error'), codes };
}

describe('hub outage log volume', function () {
    afterEach(function () { sinon.restore(); });

    it('writes each outage event at most once, however many requests arrive', async function () {
        const small = await outage(20);
        const large = await outage(400);
        expect(small.codes.every((c) => c === 503)).to.equal(true);
        expect(large.codes.every((c) => c === 503)).to.equal(true);
        expect(large.lines.length).to.be.greaterThan(0);
        // The count may differ by the one shed notice that only a large burst reaches
        // (it is already limited to one per cache TTL), never by the request count.
        for (const r of [small, large]) {
            const per = {};
            for (const l of r.lines) per[l.event] = (per[l.event] || 0) + 1;
            for (const [event, n] of Object.entries(per)) expect(n, event).to.equal(1);
        }
        expect(large.lines.length).to.be.at.most(small.lines.length + 1);
        expect(large.lines.length).to.be.at.most(6);
    });

    it('carries a stack on at most one line and none on request-level lines', async function () {
        const r = await outage(400);
        const stacked = r.lines.filter((l) => l.fields.stack);
        expect(stacked.length).to.be.at.most(1);
        for (const l of r.lines.filter((x) => x.event.startsWith('PROCESS_REQUEST'))) expect(l.fields.stack).to.equal(undefined);
    });
});

describe('logWindowed', function () {
    let clock, lines, logger, owner;
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
        lines = []; logger = makeLogger(lines); owner = {};
    });
    afterEach(function () { clock.restore(); });

    it('counts inside a window and reports the count on the next window first line', function () {
        for (let i = 0; i < 10; i++) logWindowed(owner, logger, 'warn', 'E', { i }, { stack: 'S' });
        expect(lines.length).to.equal(1);
        clock.tick(61000);
        logWindowed(owner, logger, 'warn', 'E', {}, { stack: 'S' });
        expect(lines.length).to.equal(2);
        expect(lines[1].fields.suppressed).to.equal(9);
    });

    it('sends the stack on the first line only, across windows', function () {
        logWindowed(owner, logger, 'warn', 'E', {}, { stack: 'S' });
        clock.tick(61000);
        logWindowed(owner, logger, 'warn', 'E', {}, { stack: 'S' });
        expect(lines[0].fields.stack).to.equal('S');
        expect(lines[1].fields.stack).to.equal(undefined);
    });

    it('windows each event and each owner separately', function () {
        logWindowed(owner, logger, 'warn', 'A', {});
        logWindowed(owner, logger, 'warn', 'B', {});
        logWindowed({}, logger, 'warn', 'A', {});
        expect(lines.length).to.equal(3);
    });
});
