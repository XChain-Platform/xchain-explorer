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

// SLOW_REQUEST must log once per window, not once per slow request. runRequest hands
// sendResponse a fresh host bag per request, so window state kept on the host never
// survives a request; this drives sendResponse the way processRequest does (one new
// host per request, one long-lived explorer) and counts the lines.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

function makeLogger(lines) {
    const rec = (level) => (event, fields) => lines.push({ level, event, fields: fields || {} });
    return { warn: rec('warn'), error: rec('error'), info() {}, debug() {} };
}

describe('SLOW_REQUEST log volume', function () {
    let clock, lines, sendResponse, explorer;

    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: 5000000, toFake: ['Date'] });
        lines = [];
        const logger = makeLogger(lines);
        ({ sendResponse } = proxyquire('../../../../src/explorer/request/send_response.js', {
            '../../observability': { getLogger: () => logger },
            '../../lib/log_window.js': require('../../../../src/lib/log_window.js')
        }));
        explorer = {
            headers: {},
            util: {
                isNull: (v) => v === null || v === undefined,
                getTimer: () => 500,
                getTimerString: (t) => t + 'ms',
                jsonStringify: (j) => JSON.stringify(j)
            }
        };
    });
    afterEach(function () { clock.restore(); sinon.restore(); });

    // One request through the per-request path: a fresh host bag, as processRequest builds it.
    function slowRequest(i) {
        const res = { set() {}, status() {}, send() {} };
        const st = { cfg: { type: 'api' }, response: { code: 200, json: { ok: true } }, debugTimer: 0 };
        const host = { configEnv: () => ({}), stats: { record() {}, slow() {} } };
        sendResponse(explorer, { path: '/x/' + i }, res, st, host);
    }

    it('writes one line per window and carries the suppressed count to the next', function () {
        for (let i = 0; i < 47; i++) slowRequest(i);
        const first = lines.filter((l) => l.event === 'SLOW_REQUEST');
        expect(first.length).to.equal(1);
        expect(first[0].fields.suppressed).to.equal(undefined);

        clock.tick(61000);
        for (let i = 0; i < 10; i++) slowRequest(i);
        const all = lines.filter((l) => l.event === 'SLOW_REQUEST');
        expect(all.length).to.equal(2);
        expect(all[1].fields.suppressed).to.equal(46);
    });
});
