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
 * The three market chart views actually draw.
 *
 * content-charts.test.js pins the configs, which is pure data. This harness
 * pins the half that only fails at runtime: the vendored Chart.js stack
 * loading in browser order, the financial plugin registering a candlestick
 * controller against that exact Chart.js version, the stacked price/volume
 * scales resolving, and XCC.render building the toolbar and tooltip bridge.
 *
 * Those are precisely the failure modes the Highcharts swap could introduce
 * silently: every one of them leaves the unit configs green and the market
 * page blank.
 *
 * jsdom has no canvas backend, so a no-op 2D context stands in. Chart.js only
 * needs it for measurement and painting, and layout still runs for real, which
 * is what is under test.
 *
 * Run: mocha test/unit/content-charts-render.test.js --timeout 0
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const JS_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'js');

// Enough of CanvasRenderingContext2D for Chart.js to measure and paint into.
function stubContext(canvas){
    return {
        canvas,
        save(){}, restore(){}, beginPath(){}, closePath(){}, moveTo(){}, lineTo(){},
        bezierCurveTo(){}, quadraticCurveTo(){}, arc(){}, arcTo(){}, rect(){}, ellipse(){},
        fill(){}, stroke(){}, clip(){}, fillRect(){}, strokeRect(){}, clearRect(){},
        fillText(){}, strokeText(){}, translate(){}, rotate(){}, scale(){}, setTransform(){},
        resetTransform(){}, setLineDash(){}, getLineDash(){ return []; }, drawImage(){},
        putImageData(){}, isPointInPath(){ return false; },
        createLinearGradient(){ return { addColorStop(){} }; },
        createRadialGradient(){ return { addColorStop(){} }; },
        createPattern(){ return {}; },
        getImageData(){ return { data: new Uint8ClampedArray(4) }; },
        measureText(t){
            return { width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
        }
    };
}

// Load the vendored bundles into one window in the same order template.html
// does. They are UMD, so they attach to the window they are evaluated against.
function bootWindow(){
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="market-chart"></div></body></html>',
        // A real origin, otherwise jsdom refuses localStorage, which the zoom
        // preference is stored in.
        { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://xchain.io/BTC/market/XCHAIN/PEPECREATURE' }
    );
    const { window } = dom;

    window.HTMLCanvasElement.prototype.getContext = function(){ return stubContext(this); };
    window.HTMLCanvasElement.prototype.toDataURL  = function(){ return 'data:image/png;base64,AAAA'; };

    // jsdom reports a zero-sized layout box for everything; Chart.js would then
    // resolve to a 0x0 canvas and skip its scales entirely.
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth',  { get(){ return 800; } });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get(){ return 400; } });
    window.HTMLElement.prototype.getBoundingClientRect = function(){
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400 };
    };

    // Chart.js binds a ResizeObserver for its responsive mode; jsdom has none.
    window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };

    // moment is the vendored copy the page already carries; the Chart.js date
    // adapter takes it as a peer, so load the same file the browser loads.
    const files = [
        'moment.min.js',
        'chart.umd.js',
        'chartjs-adapter-moment.js',
        'chartjs-chart-financial.js',
        'xchain-charts.js'
    ];
    for(const file of files){
        const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
        // module/exports are passed undefined so the UMD wrappers take their
        // browser branch, exactly as they do when served as <script> tags.
        const fn = new window.Function('window', 'self', 'globalThis', 'document', 'module', 'exports', src);
        fn.call(window, window, window, window, window.document, undefined, undefined);
    }
    return window;
}

// A day of hourly candles, which is the shape updateMarketHistory() produces.
function sampleSeries(){
    const now    = Date.UTC(2026, 6, 27, 0, 0, 0),
          ohlc   = [], volume = [], trades = [];
    for(let i = 0; i < 40; i++){
        const t = now - (40 - i) * 3600000,
              o = 1 + i * 0.01;
        ohlc.push([t, o, o + 0.05, o - 0.03, o + 0.02]);
        volume.push([t, 10 + i]);
        trades.push([t, o + 0.02]);
    }
    return { ohlc, volume, trades, maxTs: now - 3600000 };
}

describe('market chart views render against the vendored Chart.js stack', function(){

    let window, XCC, series;

    before(function(){
        window = bootWindow();
        XCC    = window.XCC;
        series = sampleSeries();
    });

    afterEach(function(){
        if(XCC) XCC.destroy('market-chart');
    });

    it('loads Chart.js and the market chart layer as browser globals', () => {
        expect(typeof window.Chart, 'chart.umd.js did not attach window.Chart').to.equal('function');
        expect(typeof XCC, 'xchain-charts.js did not attach window.XCC').to.equal('object');
        expect(typeof XCC.render, 'XCC loaded without its browser layer').to.equal('function');
    });

    it('registers the candlestick controller from the financial plugin', () => {
        // The plugin declares a chart.js ^4 peer; a version bump that breaks
        // registration only shows up as a blank candlestick view.
        expect(() => window.Chart.registry.getController('candlestick')).to.not.throw();
        expect(window.Chart._adapters._date.prototype.format,
            'the moment date adapter did not install').to.be.a('function');
    });

    it('draws the candlestick view with a live price and volume scale', () => {
        const cfg = XCC.candlestickConfig(
            { ohlc: series.ohlc, volume: series.volume },
            { tick1: 'PEPECREATURE', tick2: 'XCHAIN' }
        );
        XCC.applyRange(cfg, '1d', series.maxTs);
        const chart = XCC.render('market-chart', cfg, {
            rangeSelector: true, range: '1d', maxTs: series.maxTs, noData: 'No Trades Found'
        });
        expect(chart, 'candlestick view produced no chart').to.not.equal(null);
        expect(chart.data.datasets).to.have.length(2);
        expect(Object.keys(chart.scales).sort()).to.deep.equal(['price', 'volume', 'x']);
        // Both panes must get real, non-degenerate pixel space, which is what
        // the stacked-scale layout is doing for us.
        expect(chart.scales.price.height).to.be.above(0);
        expect(chart.scales.volume.height).to.be.above(0);
        expect(chart.scales.price.height).to.be.above(chart.scales.volume.height);
        expect(chart.scales.x.min).to.equal(series.maxTs - 86400000);
    });

    it('draws the line view', () => {
        const cfg = XCC.lineConfig({ trades: series.trades, volume: series.volume }, {});
        const chart = XCC.render('market-chart', cfg, { rangeSelector: true, range: '1m', maxTs: series.maxTs });
        expect(chart).to.not.equal(null);
        expect(chart.config.type).to.equal('line');
        expect(chart.scales.price.height).to.be.above(0);
    });

    it('draws the market depth view with both sides of the book', () => {
        const cfg = XCC.depthConfig({
            asks: [[10, 1, 10], [11, 3, 43], [12, 6, 115]],
            bids: [[9, 2, 18], [8, 5, 58], [7, 9, 86]]
        }, { tick1: 'PEPECREATURE', tick2: 'XCHAIN' });
        const chart = XCC.render('market-chart', cfg, { noData: 'No buy or sell orders found' });
        expect(chart).to.not.equal(null);
        expect(chart.data.datasets).to.have.length(2);
        expect(chart.scales.x.type).to.equal('linear');
        // Depth has no time axis, so no zoom presets are offered.
        expect(window.document.querySelectorAll('#market-chart .xc-chart-ranges')).to.have.length(0);
    });

    it('offers the nine zoom presets plus a PNG export on time-series views', () => {
        const cfg = XCC.lineConfig({ trades: series.trades, volume: series.volume }, {});
        XCC.render('market-chart', cfg, { rangeSelector: true, range: '1m', maxTs: series.maxTs });
        const container = window.document.getElementById('market-chart');
        expect(container.querySelectorAll('.xc-chart-ranges button')).to.have.length(XCC.RANGES.length);
        expect(container.querySelectorAll('.xc-chart-export')).to.have.length(1);
        expect(container.querySelector('.xc-chart-ranges button.active').getAttribute('data-range')).to.equal('1m');
    });

    it('re-windows the x scale and persists the choice when a preset is clicked', () => {
        const cfg = XCC.lineConfig({ trades: series.trades, volume: series.volume }, {});
        const chart = XCC.render('market-chart', cfg, { rangeSelector: true, range: '1m', maxTs: series.maxTs });
        const container = window.document.getElementById('market-chart');
        container.querySelector('.xc-chart-ranges button[data-range="1d"]').click();
        expect(chart.options.scales.x.min).to.equal(series.maxTs - 86400000);
        // The stored value stays the numeric index Highstock used, so the
        // preference survives in both directions during the rollout.
        expect(window.localStorage.getItem('marketChartZoom')).to.equal('0');
        container.querySelector('.xc-chart-ranges button[data-range="all"]').click();
        expect(chart.options.scales.x.min).to.equal(undefined);
    });

    it('renders HTML tooltip tables off-canvas rather than blanking', () => {
        const cfg = XCC.candlestickConfig(
            { ohlc: series.ohlc, volume: series.volume },
            { tick1: 'PEPECREATURE', tick2: 'XCHAIN' }
        );
        const chart = XCC.render('market-chart', cfg, {});
        const external = chart.options.plugins.tooltip.external;
        expect(external, 'the HTML tooltip bridge was not wired').to.be.a('function');
        external({
            chart,
            tooltip: {
                opacity: 1, caretX: 10, caretY: 20,
                dataPoints: [
                    { datasetIndex: 0, parsed: { x: series.ohlc[0][0] }, raw: { o: 1, h: 3, l: 0.5, c: 2 } },
                    { datasetIndex: 1, parsed: { x: series.ohlc[0][0] }, raw: { y: 10 } }
                ]
            }
        });
        const el = window.document.getElementById('xc-chart-tooltip');
        expect(el, 'no tooltip element was created').to.not.equal(null);
        expect(el.innerHTML).to.include('Open');
        expect(el.innerHTML).to.include('PEPECREATURE');
        expect(el.style.opacity).to.equal('1');
        // Hiding must not leave stale numbers on screen.
        external({ chart, tooltip: { opacity: 0 } });
        expect(el.style.opacity).to.equal('0');
    });

    it('shows the empty-state message instead of an axis-only chart', () => {
        const chart = XCC.render('market-chart', XCC.lineConfig({ trades: [], volume: [] }, {}), {
            noData: 'No Trades Found'
        });
        expect(chart).to.equal(null);
        const container = window.document.getElementById('market-chart');
        expect(container.querySelector('.xc-chart-nodata').textContent).to.equal('No Trades Found');
        expect(container.querySelector('canvas')).to.equal(null);
    });

    it('destroys the previous chart when a view is swapped into the same container', () => {
        // loadMarketChart() re-loads a fragment into #market-chart-container on
        // every tab switch; leaking instances is how Chart.js starts throwing
        // "Canvas is already in use".
        const first = XCC.render('market-chart', XCC.lineConfig({ trades: series.trades, volume: series.volume }, {}), {});
        const second = XCC.render('market-chart', XCC.candlestickConfig({ ohlc: series.ohlc, volume: series.volume }, {}), {});
        expect(second).to.not.equal(null);
        expect(second).to.not.equal(first);
        expect(window.document.getElementById('market-chart').querySelectorAll('canvas')).to.have.length(1);
    });
});
