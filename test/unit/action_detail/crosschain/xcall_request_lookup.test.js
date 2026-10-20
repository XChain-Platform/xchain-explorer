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
const { openIndexerTables } = require('../../../helpers/indexer_ddl_sqlite.js');
const { XCALL } = require('../../../../src/action-detail/crosschain');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }

const ROOT = path.resolve(__dirname, '../../../..');
const CLIENT_SRC = srcText('src/content/js/xchain.js');

const { extractFn: sliceFunction } = require('../../../helpers/source_slice');
const extractFn = (name) => sliceFunction(CLIENT_SRC, name);

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

        const sq = openIndexerTables(this, ['index_statuses', 'xcalls']);
        if(!sq) return;
        sq.exec(`
            INSERT INTO index_statuses (id, status) VALUES (1, 'valid'), (2, 'invalid: reused call id');
            INSERT INTO xcalls (action_index, version, call_id, callback_action_index, block_index, status_id) VALUES
                (100, 0, 'shared-call', 501, 600, 1),
                (200, 0, 'shared-call', 502, 650, 1),
                (300, 0, 'shared-call', 999, 690, 2);
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
