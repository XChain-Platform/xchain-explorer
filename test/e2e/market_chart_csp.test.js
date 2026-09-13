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
 * The market page draws its charts under a CSP with no 'unsafe-eval'.
 *
 * src/api.js sets script-src 'self' 'unsafe-inline' and deliberately does NOT
 * grant 'unsafe-eval'. The chart views are fetched as HTML fragments and
 * injected into #market-chart-container. jQuery 1.10.2 hands every <script>
 * it finds in injected markup to jQuery.globalEval, which is literally
 * window.eval(string): under that policy the browser refuses the call, the
 * exception is thrown inside the AJAX success handler where nothing catches
 * it, and the chart never draws while the page still reports 200 and reads
 * green. That is D-E071 / , and it is environment-dependent only in
 * that a laxer policy hides it.
 *
 * The fix is build-level: the drawing code ships inside xchain.js, the
 * fragments are markup only, and the injector strips scripts before insertion.
 * These tests pin all three halves, with window.eval standing in for the CSP
 * (a policy without 'unsafe-eval' makes eval throw, which is exactly what the
 * stub does).
 *
 * DOM-level; uses no database, unlike its siblings in this directory.
 *
 * Run: mocha test/e2e/market-chart-csp.test.js --timeout 0
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const ROOT      = path.resolve(__dirname, '..', '..');
const JS_DIR    = path.join(ROOT, 'src', 'content', 'js');
const CHART_DIR = path.join(ROOT, 'src', 'content', 'charts');
const SRC       = fs.readFileSync(path.join(JS_DIR, 'xchain.js'), 'utf8');

const FRAGMENTS = ['line.html', 'candlestick.html', 'market-depth.html'];

// Lift one top-level function out of xchain.js by brace matching. Same approach
// the content-client unit tests use: the bundle is a browser script, not a
// module, so there is nothing to require.
function extractFn(name){
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found in xchain.js: ' + name);
    let depth = 0, i = SRC.indexOf('{', start);
    for(; i < SRC.length; i++){
        if(SRC[i] === '{') depth++;
        else if(SRC[i] === '}'){ depth--; if(depth === 0){ i++; break; } }
    }
    return SRC.slice(start, i);
}

// A page with jQuery loaded and eval() refused, the way the browser refuses it
// under script-src without 'unsafe-eval'. Returns the window plus the eval
// counter so a test can assert the eval path was never taken at all.
function cspPage(extraSetup){
    const dom = new JSDOM('<!DOCTYPE html><body><div id="market-chart-container"></div></body>',
        { runScripts: 'outside-only' });
    const win = dom.window;
    const ctx = dom.getInternalVMContext();

    vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'jquery.min.js'), 'utf8'), ctx);
    if(extraSetup)
        vm.runInContext(extraSetup, ctx);

    const calls = { eval: 0 };
    // jQuery 1.10's globalEval resolves window.eval at call time, so replacing
    // it here intercepts exactly the call the CSP would refuse.
    win.execScript = undefined;
    win.eval = function(){
        calls.eval++;
        throw new win.Error("EvalError: call to eval() blocked by Content-Security-Policy");
    };
    return { win, calls };
}

describe('market charts draw under a CSP without unsafe-eval', function(){

    it('the shipped chart fragments carry no script to evaluate', function(){
        FRAGMENTS.forEach(function(name){
            const html = fs.readFileSync(path.join(CHART_DIR, name), 'utf8');
            expect(/<script\b/i.test(html), name + ' still ships an inline <script>').to.equal(false);
        });
    });

    it('injecting a chart fragment never reaches eval, and the container is populated', function(){
        const { win, calls } = cspPage(extractFn('loadChartFragment'));
        const html = fs.readFileSync(path.join(CHART_DIR, 'line.html'), 'utf8');

        let drew = 0;
        win.loadChartFragment('#market-chart-container', html, function(){ drew++; });

        expect(calls.eval, 'the injector took the globalEval path').to.equal(0);
        expect(win.document.getElementById('market-chart-line'), 'chart mount point missing').to.not.equal(null);
        expect(drew, 'the renderer was not run after injection').to.equal(1);
    });

    it('a fragment that regains a script is still injected without evaluating it', function(){
        const { win, calls } = cspPage(extractFn('loadChartFragment'));
        const hostile = '<div id="market-chart-line"></div>'
            + '<script type="text/javascript">window.__EVALUATED__ = true;</script>';

        // No throw: the whole defect was an uncaught exception on this line.
        win.loadChartFragment('#market-chart-container', hostile);

        expect(calls.eval, 'the injected script was handed to eval').to.equal(0);
        expect(win.__EVALUATED__, 'the injected script ran').to.equal(undefined);
        expect(win.document.getElementById('market-chart-line')).to.not.equal(null);
        expect(win.document.querySelector('#market-chart-container script'),
            'the script node survived into the DOM').to.equal(null);
    });

    it('the removed path is what used to break: jQuery .html() evals an injected script', function(){
        // Witness for the defect, so a future refactor back onto .load()/.html()
        // cannot look harmless. This asserts the vendored jQuery's behaviour,
        // not ours.
        const { win, calls } = cspPage();
        const withScript = '<div></div><script type="text/javascript">window.__EVALUATED__ = true;</script>';

        expect(function(){
            win.jQuery('#market-chart-container').html(withScript);
        }).to.throw(/Content-Security-Policy/);
        expect(calls.eval).to.equal(1);
    });

    it('the line renderer draws from XC.CHART_DATA with no eval and no fragment script', function(){
        const stubs = [
            'var XC = { tick1: "XCHAIN", tick2: "TOKENONE", CHART_DATA: {} };',
            'var ls = { getItem: function(){ return null; }, setItem: function(){} };',
            'var XCCalls = [];',
            'var XCC = {',
            '  lastTimestamp: function(rows){ return rows.length ? rows[rows.length-1][0] : 0; },',
            '  normalizeRange: function(v){ return v; },',
            '  lineConfig: function(d, o){ return { data: d, opts: o }; },',
            '  applyRange: function(){},',
            '  render: function(id, cfg, opts){ XCCalls.push({ id: id, cfg: cfg, opts: opts }); return {}; }',
            '};'
        ].join('\n');

        const { win, calls } = cspPage(stubs + '\n' + extractFn('loadChartFragment') + '\n' + extractFn('renderMarketChartLine'));
        const html = fs.readFileSync(path.join(CHART_DIR, 'line.html'), 'utf8');

        win.XC.CHART_DATA.trades = { trades: [[1000, 2], [2000, 3]], volume: [[1000, 5], [2000, 6]] };
        win.loadChartFragment('#market-chart-container', html, win.renderMarketChartLine);

        expect(calls.eval).to.equal(0);
        expect(win.XCCalls, 'the line view never rendered').to.have.length(1);
        expect(win.XCCalls[0].id).to.equal('market-chart-line');
        expect(win.XCCalls[0].opts.noData).to.equal('No Trades Found');
    });

    it('a renderer is registered for every chart view the market page offers', function(){
        // The market page lists line, candlestick and market-depth; a view with
        // no renderer would load an empty fragment and draw nothing at all now
        // that the drawing code no longer travels with the markup.
        ['renderMarketChartLine', 'renderMarketChartCandlestick', 'renderMarketChartDepth'].forEach(function(fn){
            expect(SRC.indexOf('function ' + fn + '('), fn + ' is missing from xchain.js').to.be.greaterThan(-1);
        });
        FRAGMENTS.forEach(function(name){
            const view = name.replace(/\.html$/, '');
            expect(SRC.indexOf("'" + view + "':"), 'no renderer registered for ' + view).to.be.greaterThan(-1);
        });
    });
});
