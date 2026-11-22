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
 * The compact action summary falls back to a humanized type name for any type
 * with no branch of its own. That fallback is silent, so the set of types that
 * rely on it is pinned here: a newly registered type fails this file until it
 * gets a summary branch or joins the list on purpose. BET's branch names its
 * shape from the record format, so a feed, a wager, a cancel, a resolve and a
 * list edit no longer all list as 'Bet'.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');
const { ACTION_TYPES } = require('../../../../src/action-detail');

const CONTENT     = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content');
const DETAIL_SRC  = fs.readFileSync(path.join(CONTENT, 'js', 'xchain', 'action_detail.js'), 'utf8');
const SYSTEM_SRC  = fs.readFileSync(path.join(CONTENT, 'js', 'xchain', 'action_system_summaries.js'), 'utf8');
// The summary is split across these two parts; a branch in either one counts.
const SUMMARY_SRC = DETAIL_SRC + '\n' + SYSTEM_SRC;
const CLIENT_SRC  = require('../../../helpers/content-source.js').clientSource();
const JQUERY      = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');

// Types with no summary branch in either part: their list row is the humanized name alone.
const FALLBACK_ONLY = [
    'BATCH', 'BET_EDIT', 'COINPAY', 'CROSS_SETTLE', 'NODEPROOF', 'UNKNOWN', 'XCALL', 'XEXEC'
];

// Types the system part summarizes once a row carries its fields; a sparse row
// of one of these still falls back to the humanized name.
const SYSTEM_SUMMARIZED = ['BET_EXPIRE', 'COINPAY_EXPIRE', 'ROLLCALL', 'XBRIDGE'];

// Every type the summary source names in an `action=='X'` test or an includes() list.
function summarizedTypes(){
    const seen = new Set();
    for(const m of SUMMARY_SRC.matchAll(/action\s*==\s*'([A-Z_]+)'/g)) seen.add(m[1]);
    for(const m of SUMMARY_SRC.matchAll(/\[((?:\s*'[A-Z_]+'\s*,?)+)\]\.includes\(action\)/g))
        for(const t of m[1].matchAll(/'([A-Z_]+)'/g)) seen.add(t[1]);
    return seen;
}

function bootSummary(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'TDOGE';
    return function(action, info){ return win.getActionDetails(action, info); };
}

describe('client: the summary fallback set is declared, not silent', function(){

    it('every registered type without a summary branch is on the fallback list, and only those', function(){
        const covered = summarizedTypes();
        const missing = ACTION_TYPES.filter((t) => !covered.has(t)).sort();
        expect(missing).to.deep.equal(FALLBACK_ONLY.slice().sort());
    });

    it('the system summary types are counted as summarized, not as fallback-only', function(){
        const covered = summarizedTypes();
        for(const t of SYSTEM_SUMMARIZED){
            expect(covered.has(t), t).to.equal(true);
            expect(FALLBACK_ONLY, t).to.not.include(t);
        }
    });

    it('every summary part getActionDetails calls is defined in the scanned source', function(){
        const called = new Set([...DETAIL_SRC.matchAll(/(actionDetail_render\w+Actions)\(html,/g)].map((m) => m[1]));
        expect(called.size).to.be.greaterThan(0);
        for(const fn of called)
            expect(SUMMARY_SRC, fn).to.match(new RegExp('function\\s+' + fn + '\\s*\\('));
    });

    it('a populated system row renders its own summary, not the humanized name', function(){
        const summary = bootSummary();
        expect(summary('ROLLCALL', { epoch_height: 7 })).to.equal('Roll call for epoch 7');
        expect(summary('COINPAY_EXPIRE', { obligation_action_index: 9 })).to.contain('Expired obligation');
        expect(summary('BET_EXPIRE', { feed_action_index: 3 })).to.contain('Expired bet feed');
        expect(summary('XBRIDGE', { dest_chain: 'BTC' })).to.contain('Bridge to BTC');
    });

    it('a fallback-only type still renders its humanized name', function(){
        const summary = bootSummary();
        expect(summary('BET_EXPIRE', {})).to.equal('Bet expire');
        expect(summary('XBRIDGE', {})).to.equal('Xbridge');
    });
});

describe('client: BET summaries name the record shape', function(){

    it('names each non-wager format', function(){
        const summary = bootSummary();
        expect(summary('BET', { action_format: 0 })).to.equal('Create bet feed');
        expect(summary('BET', { action_format: 1 })).to.equal('Cancel bet feed');
        expect(summary('BET', { action_format: 3 })).to.equal('Resolve bet feed');
        expect(summary('BET', { action_format: 4 })).to.equal('Edit bet feed lists');
    });

    it('states the stake of a wager and links its token', function(){
        const html = bootSummary()('BET', { action_format: 2, tick: 'DANK', amount: '5' });
        expect(html).to.match(/^Wager /);
        expect(html).to.contain('/TDOGE/token/DANK');
        expect(html).to.contain('5');
    });

    it('a wager row without its stake fields reads Wager, never undefined', function(){
        expect(bootSummary()('BET', { action_format: 2 })).to.equal('Wager');
    });

    it('a row with no format keeps the generic name', function(){
        expect(bootSummary()('BET', {})).to.equal('Bet');
    });
});
