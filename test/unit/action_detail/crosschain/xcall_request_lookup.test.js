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
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const path   = require('path');
const { JSDOM } = require('jsdom');
const { srcText } = require('../../../helpers/source_text');
const { XCALL } = require('../../../../src/action-detail/crosschain');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }

const ROOT = path.resolve(__dirname, '../../../..');
const CLIENT_SRC = srcText('src/content/js/xchain.js');

function extractFn(name) {
    const start = CLIENT_SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = CLIENT_SRC.indexOf('{', start);
    let depth = 0;
    let end = braceStart;
    for(; end < CLIENT_SRC.length; end++) {
        if(CLIENT_SRC[end] === '{') depth++;
        else if(CLIENT_SRC[end] === '}' && --depth === 0) return CLIENT_SRC.slice(start, end + 1);
    }
    throw new Error('unterminated function: ' + name);
}

function renderCallbackLink(data) {
    const dom = new JSDOM(`<!DOCTYPE html><body><div id="info-xcall"><table>
        <tr class="xcall-callback-row d-none">
            <td class="xcall-callback-result"></td>
            <td class="xcall-callback-action"></td>
        </tr>
    </table></div></body>`, { runScripts: 'outside-only' });
    dom.window.eval(require('fs').readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function isNull(value){ return value === null || value === undefined; }
        function formatHash(value){ return isNull(value) ? '-' : String(value); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
    `);
    dom.window.eval(extractFn('showXcallDetails'));
    dom.window.showXcallDetails(data);
    return dom.window.document.querySelector('.xcall-callback-action a');
}

describe('XCALL result delivery request lookup', function() {
    it('links the newest valid request when a later invalid request reuses the call id', async function() {
        if(!sqlite) this.skip();

        const sq = new sqlite.DatabaseSync(':memory:');
        sq.exec(`
            CREATE TABLE index_statuses (id INTEGER PRIMARY KEY, status TEXT);
            CREATE TABLE xcalls (
                action_index INTEGER,
                version INTEGER,
                call_id TEXT,
                callback_action_index INTEGER,
                status_id INTEGER
            );
            INSERT INTO index_statuses VALUES (1, 'valid'), (2, 'invalid: reused call id');
            INSERT INTO xcalls VALUES
                (100, 0, 'shared-call', 501, 1),
                (200, 0, 'shared-call', 502, 1),
                (300, 0, 'shared-call', 999, 2);
        `);

        const db = {
            util: { isNull: value => value === null || value === undefined },
            async doQuery(config, sql, args) {
                if(String(sql).includes('cross_chain_call_callbacks')) {
                    return [{
                        call_id: 'shared-call',
                        result_status: 'ok',
                        callback_block_index: 700
                    }];
                }
                return sq.prepare(sql).all(...args);
            }
        };
        const data = { call_id: null };

        await XCALL.afterMain({ db, config: {}, action_index: 700 }, data);

        assert.equal(data.callback_action_index, 502);
        const link = renderCallbackLink(data);
        assert.ok(link);
        assert.equal(link.getAttribute('href'), '/BTC/action/502');
        assert.equal(link.textContent, '502');
    });
});
