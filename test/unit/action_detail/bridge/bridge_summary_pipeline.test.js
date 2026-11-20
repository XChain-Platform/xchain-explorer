/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const { REGISTRY } = require('../../../../src/action-detail');
const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { srcText } = require('../../../helpers/source_text');
const { extractFn } = require('../../../helpers/source_slice');

const configInfo = createConfigInfoStub();
const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});
const projectionDb = new Database({ configInfo, util: new Utility(configInfo) });
const CLIENT_SRC = srcText('src/content/js/xchain.js');

function settlementDb(row) {
    return {
        async doQuery(config, sql) {
            if(/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: 'bridge_settlements' }];
            if(/FROM bridge_settlements/.test(sql)) return [row];
            return [];
        }
    };
}

function render(details) {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const contentDir = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content', 'js');
    dom.window.XC = { coin: 'DOGE' };
    dom.window.eval(fs.readFileSync(path.join(contentDir, 'network_coin.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(contentDir, 'formatters.js'), 'utf8'));
    dom.window.eval('function formatAmount(v){ return String(v); }');
    dom.window.eval(extractFn(CLIENT_SRC, 'actionDetail_renderSystemActions', 'xchain.js'));
    return dom.window.actionDetail_renderSystemActions('', 'XBRIDGE', details, 'DOGE');
}

describe('XBRIDGE injected-leg summary pipeline', function () {
    it('carries a settlement destination through projection into the shipped summary', async function () {
        const row = { transfer_id: 'e'.repeat(64), kind: 'transfer', tick: 'DANK',
            src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE', dest_address: 'Ddest' };
        const data = { action: 'XBRIDGE', action_format: 5, status: 'valid' };
        await REGISTRY.XBRIDGE.afterMain({ db: settlementDb(row), config: { coin: 'DOGE' }, action_index: 77 }, data);
        const details = projectionDb.projectActionSummary(data).details;
        expect(details).to.include({ dest_chain: 'DOGE', dest_address: 'Ddest', bridge_kind: 'transfer' });
        const html = render(details);
        expect(html).to.contain('to DOGE');
        expect(html).to.contain('(transfer)');
    });
});
