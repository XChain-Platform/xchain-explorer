/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * ISSUE format 7 opts a token into bridging with BRIDGE_CHAINS, MIN_DEPTH and
 * LOCK_BRIDGE, stored on `issues` as raw wire text. The action detail reads them
 * for format 7 only, in a statement of its own, so a replica that predates the
 * bridge-fields migration keeps serving every ISSUE page instead of failing the
 * main read with an unknown column. The card shows them for format 7 alone.
 *********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const assert     = require('assert');
const proxyquire = require('proxyquire');
const { JSDOM }  = require('jsdom');
const Utility    = require('../../../../src/lib/utility.js');
const { DbQueryError } = require('../../../../src/db/shared.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ACTION = 5151;
const CONTENT    = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content');
const CLIENT_SRC = require('../../../helpers/content-source.js').clientSource();
const JQUERY     = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');

function issueRow(format) {
    return { action: 'ISSUE', action_format: format, action_index: ACTION, tick: 'BRDG',
        source: 'addr-1', block_index: 100, timestamp: 1700000000, tx_hash: 'hash',
        tx_index: 7, memo: null, status: 'valid' };
}

function unknownColumnError() {
    const driver = new Error("Unknown column 'i1.bridge_chains' in 'field list'");
    driver.errno = 1054;
    driver.code  = 'ER_BAD_FIELD_ERROR';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// A db over a replica whose `issues` does or does not carry the bridge columns.
// `probe` is what information_schema answers; `columns` is what the table really has.
function makeDb(format, { probe = true, columns = true } = {}) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        const text = String(sql);
        db.queries.push(text);
        if (/information_schema\.COLUMNS/i.test(text))
            return probe ? [{ COLUMN_NAME: 'bridge_chains' }, { COLUMN_NAME: 'min_depth' }, { COLUMN_NAME: 'lock_bridge' }] : [];
        if (/i1\.bridge_chains/.test(text)) {
            if (!columns) throw unknownColumnError();
            return [{ bridge_chains: 'LTC,DOGE', min_depth: '6', lock_bridge: '1' }];
        }
        if (/FROM\s+issues/.test(text)) return [issueRow(format)];
        return [];
    };
    db.getActionType      = async () => 'ISSUE';
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'LTC', data: {} };
const bridgeReads = (db) => db.queries.filter((q) => /i1\.bridge_chains/.test(q)).length;

describe('ISSUE format 7 action detail', function () {

    it('attaches the bridge fields the format 7 action carried', async function () {
        const db   = makeDb(7);
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.bridge_chains, 'LTC,DOGE');
        assert.strictEqual(data.min_depth, '6');
        assert.strictEqual(data.lock_bridge, '1');
    });

    it('keeps the bridge columns out of the main ISSUE read', async function () {
        const db = makeDb(7);
        await db.getActionData(config, ACTION);
        const main = db.queries.find((q) => /FROM\s+issues/.test(q) && !/i1\.bridge_chains/.test(q));
        assert.ok(main, 'the main ISSUE read must still run');
        assert.ok(!/bridge_chains|min_depth|lock_bridge/.test(main), 'a missing column there would fail every ISSUE page');
    });

    it('reads nothing more for any other format', async function () {
        const db   = makeDb(0);
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(bridgeReads(db), 0);
        assert.ok(!('bridge_chains' in data), 'a format 0 payload keeps its prior shape');
    });

    it('serves null bridge fields on a replica the probe says lacks the columns', async function () {
        const db   = makeDb(7, { probe: false, columns: false });
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(bridgeReads(db), 0);
        assert.strictEqual(data.bridge_chains, null);
        assert.strictEqual(data.tick, 'BRDG', 'the rest of the page still renders');
    });

    it('survives a probe that answered wrong, then stops asking', async function () {
        const db   = makeDb(7, { probe: true, columns: false });
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.min_depth, null);
        assert.strictEqual(bridgeReads(db), 1);
        const mainReads = () => db.queries.filter((q) => /FROM\s+issues/.test(q) && !/i1\.bridge_chains/.test(q)).length;
        const before = mainReads();
        // A second action, so the action cache cannot answer for it.
        await db.getActionData(config, ACTION + 1);
        assert.ok(mainReads() > before, 'the second read must reach the database, not a cache');
        assert.strictEqual(bridgeReads(db), 1, 'the recorded absence skips the statement next time');
    });
});

// Render the shipped ISSUE card and read one cell.
function renderIssue(data) {
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only', url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'TDOGE';
    win.showIssueDetails(data);
    return {
        hidden: () => win.jQuery('#info-issue .issue-bridge-card').hasClass('d-none'),
        cell: (cls) => win.jQuery('#info-issue .' + cls).text()
    };
}

describe('client: the ISSUE bridge card', function () {

    it('shows the opt-in fields on a format 7 action', function () {
        const card = renderIssue({ action_format: 7, tick: 'BRDG', bridge_chains: 'LTC,DOGE', min_depth: '6', lock_bridge: '1' });
        assert.strictEqual(card.hidden(), false);
        assert.strictEqual(card.cell('issue-bridge-chains'), 'LTC, DOGE');
        assert.strictEqual(card.cell('issue-min-depth'), '6 confirmations');
        assert.strictEqual(card.cell('issue-lock-bridge'), 'Locked');
    });

    it('names the explicit none and the no-raise depth', function () {
        const card = renderIssue({ action_format: 7, tick: 'BRDG', bridge_chains: '-', min_depth: '0', lock_bridge: '0' });
        assert.strictEqual(card.cell('issue-bridge-chains'), 'None');
        assert.strictEqual(card.cell('issue-min-depth'), 'Platform default');
        assert.strictEqual(card.cell('issue-lock-bridge'), 'Unlocked');
    });

    it('stays hidden on every other format', function () {
        assert.strictEqual(renderIssue({ action_format: 0, tick: 'BRDG' }).hidden(), true);
        assert.strictEqual(renderIssue({ action_format: 6, tick: 'BRDG' }).hidden(), true);
    });
});
