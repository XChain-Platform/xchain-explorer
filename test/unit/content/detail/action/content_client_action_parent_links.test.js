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
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '..', '..', '..', '../../src/content');
const CLIENT_SRC = require('../../../../helpers/content-source.js').clientSource();
const JQUERY = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION = path.join(CONTENT, 'html', 'action.html');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only'
    });
    const win = dom.window;
    Object.defineProperty(win, 'localStorage', { value: {
        getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}
    } });
    win.numeral = function(value){
        return { format: function(){ return Number(value).toLocaleString('en-US'); } };
    };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = { coin: 'RDOGE' };
    return win;
}

const CASES = [
    ['showOrderCancelDetails', '#info-order-cancel .order-cancel-action-index', 'order_action_index'],
    ['showOrderEditDetails', '#info-order-edit .order-edit-action-index', 'order_action_index'],
    ['showSwapCancelDetails', '#info-swap-cancel .swap-cancel-action-index', 'swap_action_index'],
    ['showSwapEditDetails', '#info-swap-edit .swap-edit-action-index', 'swap_action_index'],
    ['showDispenserCancelDetails', '#info-dispenser-cancel .dispenser-cancel-action-index', 'dispenser_action_index'],
    ['showDispenserEditDetails', '#info-dispenser-edit .dispenser-edit-action-index', 'dispenser_action_index']
];

describe('cancel and edit parent links', function(){
    it('renders every missing-parent sentinel without an anchor', function(){
        for(const [fn, selector, field] of CASES){
            for(const value of [0, '0', null, undefined]){
                const win = bootPage();
                win[fn]({ [field]: value, memo: 'kept memo' });
                expect(win.jQuery(selector).text().trim(), fn + ' ' + String(value)).to.equal('-');
                expect(win.jQuery(selector + ' a'), fn + ' anchor').to.have.length(0);
            }
        }
    });

    it('keeps nonzero parent links for every renderer', function(){
        for(const [fn, selector, field] of CASES){
            const win = bootPage();
            win[fn]({ [field]: 1234, memo: 'kept memo' });
            expect(win.jQuery(selector + ' a').attr('href'), fn).to.equal('/RDOGE/action/1234');
            expect(win.jQuery(selector).text().trim(), fn).to.equal('1,234');
        }
    });

    it('keeps the rejected child memo visible', function(){
        const cases = [
            ['showOrderCancelDetails', '#info-order-cancel .order-cancel-memo', 'order_action_index'],
            ['showOrderEditDetails', '#info-order-edit .order-edit-memo', 'order_action_index'],
            ['showDispenserCancelDetails', '#info-dispenser-cancel .dispenser-cancel-memo', 'dispenser_action_index']
        ];
        for(const [fn, selector, field] of cases){
            const win = bootPage();
            win[fn]({ [field]: 0, memo: 'refusal context' });
            expect(win.jQuery(selector).text()).to.equal('refusal context');
        }
    });
});
