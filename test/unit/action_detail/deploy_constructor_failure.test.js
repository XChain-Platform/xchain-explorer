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
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { DEPLOY } = require('../../../src/action-detail/contracts.js');

const CONTENT = path.resolve(__dirname, '../../../src/content');
const CLIENT_SRC = require('../../helpers/content-source.js').clientSource();

function bootPage(){
    const markup = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only'
    });
    const win = dom.window;
    Object.defineProperty(win, 'localStorage', { value: {
        getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}
    } });
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.eval(fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = { coin: 'RDOGE' };
    return win;
}

describe('failed DEPLOY constructor detail', function(){
    it('attaches the terminal execution verdict when the contract row is gone', async function(){
        let issued = [];
        const db = { doQuery: async (config, sql, args) => {
            issued.push({ sql: String(sql), args });
            return [{ status: 'reverted', error_message: 'constructor failed' }];
        } };
        const data = { action_format: 2, action_index: 600, gas_used: '7' };
        await DEPLOY.afterMain({ db, config: {}, action_index: 600 }, data);
        assert.equal(issued.length, 1);
        assert.match(issued[0].sql, /FROM contract_executions/);
        assert.deepEqual(issued[0].args, [600]);
        assert.deepEqual(data, {
            action_format: 2, action_index: 600, gas_used: '7',
            status: 'reverted', error_message: 'constructor failed',
            deployed_contract_index: null, assembly_status: 'reverted', contract_deleted: true
        });
    });

    it('does not invent terminal fields without an execution verdict', async function(){
        const db = { doQuery: async () => [] };
        const data = { action_format: 2, action_index: 601 };
        await DEPLOY.afterMain({ db, config: {}, action_index: 601 }, data);
        for(const field of ['status', 'error_message', 'deployed_contract_index', 'assembly_status', 'contract_deleted'])
            assert.equal(Object.prototype.hasOwnProperty.call(data, field), false, field);
    });

    it('does not query when the main contract row was found', async function(){
        let issued = 0;
        const db = { doQuery: async () => { issued++; return []; } };
        const data = { action_format: 2, action_index: 602, code_hash: 'abc' };
        await DEPLOY.afterMain({ db, config: {}, action_index: 602 }, data);
        assert.equal(issued, 0);
    });

    it('renders a literal failure with no contract link and hides contract-only rows', function(){
        const win = bootPage();
        win.showDeployDetails({
            action_format: 2, action_index: 600, contract_deleted: true,
            status: 'reverted', error_message: '<img src=x>'
        });
        const cell = win.jQuery('#info-deploy .deploy-contract');
        assert.equal(cell.text(), 'Not deployed: <img src=x>');
        assert.equal(cell.find('a, img').length, 0);
        for(const selector of ['.deploy-code-hash', '.deploy-api-version', '.deploy-stakeable'])
            assert.equal(win.jQuery('#info-deploy ' + selector).closest('tr').hasClass('d-none'), true);
        assert.equal(win.jQuery('#info-deploy .deploy-staking-row').hasClass('d-none'), true);
    });

    it('keeps the legacy link when no deleted-contract verdict is present', function(){
        const win = bootPage();
        win.showDeployDetails({ action_format: 2, action_index: 603, status: 'invalid' });
        assert.equal(win.jQuery('#info-deploy .deploy-contract a').attr('href'), '/RDOGE/contract/603');
    });
});
