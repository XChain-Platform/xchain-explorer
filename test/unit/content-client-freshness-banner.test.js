/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The delayed-data banner. While a coin's indexed tip is stale the pages
 * keep rendering from the database and this banner says where the data
 * stops and why; when the coin is current it is hidden. The sentence is
 * composed from the per-coin maps /status already publishes, so these tests
 * feed it status bodies shaped like the live endpoint's.
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');

function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

// A /status body as the live endpoint shapes it, for one measured coin.
function status(coin, over) {
    const s = {
        stale:                  { [coin]: true },
        last_block:             { [coin]: 151038 },
        tip_age_seconds:        { [coin]: 215254 },
        replica_halted:         { [coin]: false },
        indexer_state:          { [coin]: 'behind' },
        indexer_wait_clears_at: { [coin]: null }
    };
    for (const k of Object.keys(over || {})) s[k] = { [coin]: over[k] };
    return s;
}

const openWindows = [];
afterEach(() => { while (openWindows.length) openWindows.pop().close(); });

function harness(opts = {}) {
    const dom = new JSDOM('<!DOCTYPE html><body>' +
        '<div id="freshness-banner" style="display:none;"><span id="freshness-banner-text"></span></div>' +
        '</body>', { runScripts: 'outside-only' });
    const w = dom.window;
    openWindows.push(w);
    const shown = { visible: false, text: '' };
    const statusCalls = [];
    // The two jQuery calls the banner makes, tracked rather than rendered.
    w.$ = (sel) => ({
        text: (t) => { if (sel === '#freshness-banner-text') shown.text = t; },
        show: () => { if (sel === '#freshness-banner') shown.visible = true; },
        hide: () => { if (sel === '#freshness-banner') shown.visible = false; }
    });
    w.getExplorerStatusInfo = (cb, force) => { statusCalls.push(force); };
    w.XC = Object.assign({ coin: 'TBTC', freshnessRecheckMs: 5 }, opts.XC || {});
    w.eval('function isNull(v){ return (v === null || v === undefined || v === ""); }');
    w.eval(extractFn('formatTipAge'));
    w.eval(extractFn('freshnessBannerText'));
    w.eval(extractFn('updateFreshnessBanner'));
    return { w, shown, statusCalls };
}

describe('freshness banner (content/js/xchain.js)', function () {

    describe('formatTipAge', function () {
        it('rounds to one coarse unit', function () {
            const { w } = harness();
            expect(w.formatTipAge(30)).to.equal('under a minute');
            expect(w.formatTipAge(90)).to.equal('2 minutes');
            expect(w.formatTipAge(3600)).to.equal('1 hour');
            expect(w.formatTipAge(215254)).to.equal('2 days');
            expect(w.formatTipAge(null)).to.equal(null);
            expect(w.formatTipAge(-5)).to.equal(null);
        });
    });

    describe('freshnessBannerText', function () {
        it('is null for a current coin, so the banner stays hidden', function () {
            const { w } = harness();
            expect(w.freshnessBannerText(status('TBTC', { stale: false }), 'TBTC')).to.equal(null);
            expect(w.freshnessBannerText({ stale: {} }, 'TBTC')).to.equal(null);
            expect(w.freshnessBannerText(null, 'TBTC')).to.equal(null);
        });

        it('names the last confirmed block, its age, and that the indexer is catching up', function () {
            const { w } = harness();
            const t = w.freshnessBannerText(status('TBTC'), 'TBTC');
            expect(t).to.include('#151,038');
            expect(t).to.include('about 2 days ago');
            expect(t).to.include('catching up');
            expect(t).to.include('everything up to that block is shown');
        });

        it('says indexing is paused when the replica carries a halt', function () {
            const { w } = harness();
            const t = w.freshnessBannerText(status('TBTC', { replica_halted: true }), 'TBTC');
            expect(t).to.include('paused');
            expect(t).to.not.include('catching up');
        });

        it('explains a consensus wait on a future-dated next block with its countdown', function () {
            const { w } = harness();
            const clears = new Date(Date.now() + 25 * 60 * 1000).toISOString();
            const t = w.freshnessBannerText(status('TBTC', { indexer_state: 'future_block_wait', indexer_wait_clears_at: clears }), 'TBTC');
            expect(t).to.include('ahead of this server');
            expect(t).to.match(/in about 2[45] minutes/);
        });

        it('still explains itself when the tip fields are missing', function () {
            const { w } = harness();
            const t = w.freshnessBannerText({ stale: { TBTC: true } }, 'TBTC');
            expect(t).to.not.include('#');
            expect(t).to.include('catching up');
        });

        it('only ever reads the page coin, not a sibling that happens to be stale', function () {
            const { w } = harness();
            expect(w.freshnessBannerText(status('TBTC'), 'TLTC')).to.equal(null);
        });
    });

    describe('updateFreshnessBanner', function () {
        it('shows the banner with the sentence while the coin is stale', function () {
            const { w, shown } = harness();
            w.XC.status = status('TBTC');
            w.updateFreshnessBanner();
            expect(shown.visible).to.equal(true);
            expect(shown.text).to.include('#151,038');
        });

        it('hides it once the coin is current', function () {
            const { w, shown } = harness();
            w.XC.status = status('TBTC');
            w.updateFreshnessBanner();
            w.XC.status = status('TBTC', { stale: false });
            w.updateFreshnessBanner();
            expect(shown.visible).to.equal(false);
        });

        it('re-reads /status on its own cadence while stale, forcing past the localStorage window, once at a time', async function () {
            const { w, shown, statusCalls } = harness();
            w.XC.status = status('TBTC');
            w.updateFreshnessBanner();
            w.updateFreshnessBanner();
            expect(shown.visible).to.equal(true);
            await new Promise((r) => setTimeout(r, 30));
            expect(statusCalls).to.deep.equal([true]);
        });

        it('does nothing on a page with no coin', function () {
            const { w, shown } = harness({ XC: { coin: null } });
            w.XC.status = status('TBTC');
            w.updateFreshnessBanner();
            expect(shown.visible).to.equal(false);
        });
    });
});
