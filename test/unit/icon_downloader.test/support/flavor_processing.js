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

// One coin/network flavor end to end: discovery, then the batch SELECT that picks
// the due tokens, then the loop over them. Only the database connection is faked,
// so the ordering between those three is exercised for real.
{

    iconSuite('_processFlavor()', function () {
        it('logs "queue empty" when SELECT returns no rows', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([
                [],  // discover INSERT
                [],  // discover UPDATE
                [],  // SELECT batch (empty)
            ]);
            const pool  = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            const logMsgs = [];
            d.log = (m) => logMsgs.push(m);
            d.discover    = sinon.stub().resolves();
            d.processToken = sinon.stub().resolves();

            conn.query.reset();
            conn.query.resolves([]);

            await d.processFlavor(flavor);

            expect(d.processToken.callCount).to.equal(0);
            expect(logMsgs.some(m => m.includes('queue empty'))).to.equal(true);
        });

    });

    iconSuite('_processFlavor()', function () {
        it('calls _processToken once per row and releases conn', async function () {
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().returns(null) });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const rows = [
                { icon_id: 1, token_id: 10, attempts: 0, description: null, tick: 'AAA' },
                { icon_id: 2, token_id: 11, attempts: 0, description: null, tick: 'BBB' },
            ];

            const conn = {
                query:   sinon.stub(),
                release: sinon.stub().resolves(),
            };
            // First three calls: discover (insert, description-drift re-stale, action:
            // one-shot re-stale); fourth call: SELECT
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves([]);
            conn.query.onCall(3).resolves(rows);

            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            d.processToken = sinon.stub().resolves();
            // Override sleep so test is fast
            const sleepCalls = [];
            d.cfg.requestDelayMs = 0;

            await d.processFlavor(flavor);

            expect(d.processToken.callCount).to.equal(2);
            expect(conn.release.callCount).to.equal(1);
        });

    });

    iconSuite('_processFlavor()', function () {
        it('releases conn even when _discover throws', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = {
                query:   sinon.stub().rejects(new Error('db error')),
                release: sinon.stub().resolves(),
            };
            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            try {
                await d.processFlavor(flavor);
            } catch (e) {
            }
            expect(conn.release.callCount).to.equal(1);
        });

    });

    iconSuite('_processFlavor()', function () {
        it('stops processing rows when _stop is set mid-batch', async function () {
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().returns(null) });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const rows = [
                { icon_id: 1, token_id: 10, attempts: 0, description: null, tick: 'AAA' },
                { icon_id: 2, token_id: 11, attempts: 0, description: null, tick: 'BBB' },
            ];

            const conn = {
                query:   sinon.stub(),
                release: sinon.stub().resolves(),
            };
            // First three calls: discover (insert, description-drift re-stale, action:
            // one-shot re-stale); fourth call: SELECT
            conn.query.onCall(0).resolves([]);
            conn.query.onCall(1).resolves([]);
            conn.query.onCall(2).resolves([]);
            conn.query.onCall(3).resolves(rows);

            const pool = makeMockPool(conn);
            const flavor = { coin: 'BTC', network: 'mainnet', pool };

            const processed = [];
            d.processToken = sinon.stub().callsFake(async (conn2, flv, row) => {
                processed.push(row.tick);
                d._stop = true;  // stop after first
            });
            d.cfg.requestDelayMs = 0;

            await d.processFlavor(flavor);
            expect(processed).to.deep.equal(['AAA']);
        });

        // The batch SELECT is the only reader of the backoff markFailure writes.
        // Without the 'failed' branch below, a retryable failure is parked with a
        // next_retry_at no query ever looks at again. Shape only; the row-level
        // proof runs against a real MariaDB in
        // test/conformance/icon-retry-selection.test.js.
    });

    iconSuite('_processFlavor()', function () {
        it('batch SELECT re-admits failed rows whose backoff timer has elapsed', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const sqls = [];
            const conn = {
                query:   sinon.stub().callsFake(async (sql) => { sqls.push(sql); return []; }),
                release: sinon.stub().resolves(),
            };
            const pool = makeMockPool(conn);

            d.log = () => {};
            await d.processFlavor({ coin: 'BTC', network: 'mainnet', pool });

            const select = sqls.find(s => s.includes('FROM icons i') && /^\s*SELECT/.test(s));
            expect(select, 'expected processFlavor to emit a batch SELECT').to.be.a('string');
            const flat = select.replace(/\s+/g, ' ');
            expect(flat).to.include("i.status IN ('pending','stale')");
            expect(flat).to.include("i.status = 'failed'");
            expect(flat).to.include('i.next_retry_at IS NOT NULL');
            expect(flat).to.include('i.next_retry_at <= NOW()');
        });
    });
}
