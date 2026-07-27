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
 * Market chart layer, and the licence gate that put it here.
 *
 * The explorer used to vendor and serve Highstock/Highcharts, which is
 * proprietary: free for non-commercial use only, and never redistributable
 * from a public AGPL repo. That was the one finding able to block the public
 * repo flip ( / LICENSE-IP-HYGIENE.md IP-1), so the three market chart
 * views were moved onto Chart.js (MIT).
 *
 * Two things are pinned here:
 *
 *   1. The licence outcome. No Highcharts asset may reappear under
 *      src/content, and every charting asset now served has to carry a
 *      permissive banner. A silent re-vendor is the regression that matters.
 *   2. The behaviour that swap had to reproduce by hand, because Chart.js
 *      has no stock-chart preset: the zoom range presets (including the
 *      legacy numeric localStorage value Highstock wrote), the HTML tooltip
 *      tables, and the price-over-volume pane split.
 *
 * Run: mocha test/unit/content-charts.test.js --timeout 0
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
const JS_DIR      = path.join(CONTENT_DIR, 'js');
const CSS_DIR     = path.join(CONTENT_DIR, 'css');
const CHARTS_DIR  = path.join(CONTENT_DIR, 'charts');
const TEMPLATE    = path.join(CONTENT_DIR, 'html', 'template.html');

const XCC = require(path.join(JS_DIR, 'xchain-charts.js'));

// Every file under src/content is served verbatim to the browser and is
// checked into a repo slated to go public, so both legs of the Highcharts
// problem (entitlement, redistribution) live in this directory.
function walk(dir){
    const out = [];
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name);
        if(entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

describe('src/content charting assets: licence hygiene', () => {

    it('vendors no Highcharts/Highstock file', () => {
        const offenders = walk(CONTENT_DIR)
            .map(f => path.relative(CONTENT_DIR, f))
            .filter(f => /highchart|highstock/i.test(f));
        expect(offenders, 'proprietary Highcharts assets are back under src/content').to.deep.equal([]);
    });

    it('references no Highcharts asset or API from any served page or script', () => {
        // The library files are only half of it: a leftover <script> tag or a
        // Highcharts.* call would break the chart views, and a leftover CSS
        // link would 404 on every page load. Prose mentioning the migration is
        // fine, so match asset paths and global calls rather than the word.
        const patterns = [
            /["'][^"']*\/(?:highcharts|highstock)[\w.-]*\.(?:js|css)["']/i,
            /\bHighcharts\s*\./,
            /\bHighstock\s*\./,
            /\bclass\s*=\s*["'][^"']*\bhighcharts-/i
        ];
        const offenders = [];
        for(const file of walk(CONTENT_DIR)){
            if(!/\.(html|js|css)$/i.test(file)) continue;
            const body = fs.readFileSync(file, 'utf8');
            if(patterns.some(p => p.test(body)))
                offenders.push(path.relative(CONTENT_DIR, file));
        }
        expect(offenders, 'Highcharts is still referenced').to.deep.equal([]);
    });

    it('serves the Chart.js stack with its upstream MIT banners intact', () => {
        // IP-3 in the same audit: an earlier copyright sweep stamped our AGPL
        // header onto vendored files and destroyed their attribution. These
        // three must keep the upstream notice that grants us the right to
        // redistribute them at all.
        const expected = [
            ['chart.umd.js',                'Chart.js'],
            ['chartjs-adapter-moment.js',   'chartjs-adapter-moment'],
            ['chartjs-chart-financial.js',  'chartjs-chart-financial']
        ];
        for(const [file, project] of expected){
            const full = path.join(JS_DIR, file);
            expect(fs.existsSync(full), `${file} is not vendored`).to.equal(true);
            const banner = fs.readFileSync(full, 'utf8').slice(0, 600);
            expect(banner, `${file} lost its attribution`).to.include(project);
            expect(banner, `${file} lost its MIT notice`).to.match(/MIT [Ll]icense/);
            expect(banner, `${file} carries our copyright over upstream's`).to.not.include('Dankest, LLC');
        }
    });

    it('loads the chart stack from template.html and nothing proprietary', () => {
        const html = fs.readFileSync(TEMPLATE, 'utf8');
        for(const src of ['/js/chart.umd.js', '/js/chartjs-adapter-moment.js',
                          '/js/chartjs-chart-financial.js', '/js/xchain-charts.js'])
            expect(html, `template.html does not load ${src}`).to.include(src);
        expect(html).to.include('/css/xchain-charts.css');
        expect(fs.existsSync(path.join(CSS_DIR, 'xchain-charts.css'))).to.equal(true);
    });

    it('drives all three chart views through the XCC layer', () => {
        const views = {
            'line.html':         'lineConfig',
            'candlestick.html':  'candlestickConfig',
            'market-depth.html': 'depthConfig'
        };
        for(const [file, builder] of Object.entries(views)){
            const body = fs.readFileSync(path.join(CHARTS_DIR, file), 'utf8');
            expect(body, `${file} does not build its config via XCC`).to.include('XCC.' + builder);
            expect(body, `${file} does not render via XCC`).to.include('XCC.render');
        }
    });

    it('keeps the adapter loaded after Chart.js, which it patches', () => {
        // chartjs-adapter-moment and chartjs-chart-financial both reach for the
        // global Chart at load time; ordering them ahead of chart.umd.js throws
        // on every page rather than only on the market pages.
        const html = fs.readFileSync(TEMPLATE, 'utf8');
        const at = s => html.indexOf(s);
        expect(at('/js/chart.umd.js')).to.be.below(at('/js/chartjs-adapter-moment.js'));
        expect(at('/js/chart.umd.js')).to.be.below(at('/js/chartjs-chart-financial.js'));
        expect(at('/js/chart.umd.js')).to.be.below(at('/js/xchain-charts.js'));
        // moment is a peer of the adapter and must already be on the page.
        expect(at('/js/moment.min.js')).to.be.below(at('/js/chartjs-adapter-moment.js'));
    });
});

describe('XCC zoom range presets', () => {

    it('exposes the nine presets Highstock offered, in the same order', () => {
        expect(XCC.RANGES.map(r => r.key))
            .to.deep.equal(['1d', '2d', '1w', '1m', '3m', '6m', '1y', 'ytd', 'all']);
        expect(XCC.RANGES[XCC.DEFAULT_RANGE_INDEX].key).to.equal('1m');
    });

    it('reads the legacy numeric localStorage value Highstock wrote', () => {
        // Visitors carry a marketChartZoom index from the old rangeSelector.
        expect(XCC.normalizeRange(0)).to.equal('1d');
        expect(XCC.normalizeRange('4')).to.equal('3m');
        expect(XCC.normalizeRange(8)).to.equal('all');
    });

    it('accepts a range key and falls back on anything unusable', () => {
        expect(XCC.normalizeRange('ytd')).to.equal('ytd');
        expect(XCC.normalizeRange(null)).to.equal('1m');
        expect(XCC.normalizeRange('')).to.equal('1m');
        expect(XCC.normalizeRange('99')).to.equal('1m');
        expect(XCC.normalizeRange('nonsense')).to.equal('1m');
    });

    it('anchors fixed-span windows on the newest data point', () => {
        const max = Date.UTC(2026, 6, 27, 12, 0, 0);
        expect(XCC.rangeWindow('1d', max)).to.deep.equal({ min: max - 86400000, max });
        expect(XCC.rangeWindow('1w', max)).to.deep.equal({ min: max - 7 * 86400000, max });
    });

    it('walks calendar months rather than a fixed day count', () => {
        // A 3 x 30-day span from Mar 31 lands on Dec 31 of the wrong month;
        // the range buttons are labelled in months, so step in months.
        const max = Date.UTC(2026, 2, 31, 0, 0, 0);
        const win = XCC.rangeWindow('3m', max);
        expect(new Date(win.min).getUTCMonth()).to.equal(11);
        expect(new Date(win.min).getUTCFullYear()).to.equal(2025);
    });

    it('starts YTD at Jan 1 of the newest point year', () => {
        const max = Date.UTC(2026, 6, 27, 12, 0, 0);
        expect(XCC.rangeWindow('ytd', max).min).to.equal(Date.UTC(2026, 0, 1));
    });

    it('returns no window for "all", and for an empty series', () => {
        expect(XCC.rangeWindow('all', Date.now())).to.equal(null);
        expect(XCC.rangeWindow('1m', 0)).to.equal(null);
    });

    it('pins and unpins the x scale via applyRange', () => {
        const cfg = XCC.lineConfig({ trades: [[1000, 5]], volume: [[1000, 2]] }, {});
        const max = Date.UTC(2026, 6, 27);
        XCC.applyRange(cfg, '1d', max);
        expect(cfg.options.scales.x.min).to.equal(max - 86400000);
        expect(cfg.options.scales.x.max).to.equal(max);
        XCC.applyRange(cfg, 'all', max);
        expect(cfg.options.scales.x).to.not.have.property('min');
        expect(cfg.options.scales.x).to.not.have.property('max');
    });

    it('reports the newest timestamp of an unsorted series', () => {
        expect(XCC.lastTimestamp([[30, 1], [10, 1], [20, 1]])).to.equal(30);
        expect(XCC.lastTimestamp([])).to.equal(0);
        expect(XCC.lastTimestamp(undefined)).to.equal(0);
    });
});

describe('XCC chart configs', () => {

    const ohlcData = {
        ohlc:   [[1000, 1, 3, 0.5, 2], [2000, 2, 4, 1.5, 3]],
        volume: [[1000, 10], [2000, 20]]
    };

    it('builds a candlestick chart with a separate volume dataset', () => {
        const cfg = XCC.candlestickConfig(ohlcData, { tick1: 'PEPECREATURE', tick2: 'XCHAIN' });
        expect(cfg.type).to.equal('candlestick');
        expect(cfg.data.datasets).to.have.length(2);
        expect(cfg.data.datasets[0].data[0]).to.deep.equal({ x: 1000, o: 1, h: 3, l: 0.5, c: 2 });
        expect(cfg.data.datasets[0].yAxisID).to.equal('price');
        expect(cfg.data.datasets[1].type).to.equal('bar');
        expect(cfg.data.datasets[1].yAxisID).to.equal('volume');
        expect(cfg.data.datasets[1].data[1]).to.deep.equal({ x: 2000, y: 20 });
    });

    it('stacks price over volume 2:1, the pane split Highstock gave for free', () => {
        const scales = XCC.candlestickConfig(ohlcData, {}).options.scales;
        expect(scales.price.stack).to.equal(scales.volume.stack);
        expect(scales.price.stackWeight).to.equal(2);
        expect(scales.volume.stackWeight).to.equal(1);
        // Scale declaration order is what puts price on top.
        expect(Object.keys(scales)).to.deep.equal(['x', 'price', 'volume']);
        expect(scales.x.type).to.equal('time');
    });

    it('never lets a negative axis floor appear under price or volume', () => {
        const scales = XCC.lineConfig({ trades: [[1, 1]], volume: [[1, 1]] }, {}).options.scales;
        expect(scales.price.min).to.equal(0);
        expect(scales.volume.min).to.equal(0);
    });

    it('builds a line chart with price and volume series', () => {
        const cfg = XCC.lineConfig({ trades: [[1000, 5], [2000, 7]], volume: [[1000, 2], [2000, 4]] }, {});
        expect(cfg.type).to.equal('line');
        expect(cfg.data.datasets[0].data).to.deep.equal([{ x: 1000, y: 5 }, { x: 2000, y: 7 }]);
        expect(cfg.data.datasets[1].type).to.equal('bar');
    });

    it('builds a filled two-sided depth chart on a price axis', () => {
        const cfg = XCC.depthConfig({
            asks: [[10, 1, 10], [11, 3, 43]],
            bids: [[9,  2, 18], [8,  5, 58]]
        }, { tick1: 'PEPECREATURE', tick2: 'XCHAIN' });
        expect(cfg.data.datasets.map(d => d.label)).to.deep.equal(['Asks', 'Bids']);
        expect(cfg.data.datasets[0].fill).to.equal('origin');
        expect(cfg.data.datasets[0].data).to.deep.equal([{ x: 10, y: 1 }, { x: 11, y: 3 }]);
        // Depth is price-versus-volume, not a time series.
        expect(cfg.options.scales.x.type).to.equal('linear');
    });

    it('treats a config with only empty datasets as no-data', () => {
        expect(XCC.isEmptyConfig(XCC.lineConfig({ trades: [], volume: [] }, {}))).to.equal(true);
        expect(XCC.isEmptyConfig(XCC.lineConfig({ trades: [[1, 1]], volume: [] }, {}))).to.equal(false);
        expect(XCC.isEmptyConfig(XCC.depthConfig({}, {}))).to.equal(true);
    });

    it('survives missing or partial data without throwing', () => {
        expect(() => XCC.candlestickConfig(undefined, {})).to.not.throw();
        expect(() => XCC.lineConfig({}, {})).to.not.throw();
        expect(() => XCC.depthConfig({ asks: [] }, {})).to.not.throw();
    });
});

describe('XCC tooltips', () => {

    // Chart.js draws its own tooltip on the canvas; these market tooltips are
    // HTML tables, so the markup is built here and injected. Pin the formatters
    // so the assertions are about layout, not about numeral/mathjs rounding.
    let saved;
    beforeEach(() => {
        saved = { ...XCC.formatters };
        XCC.formatters.amount = v => Number(v).toFixed(8);
        XCC.formatters.volume = v => Number(v).toFixed(8);
        XCC.formatters.time   = ms => 'T' + ms;
    });
    afterEach(() => Object.assign(XCC.formatters, saved));

    it('renders open/high/low/close plus volume for a candle', () => {
        const html = XCC.candlestickTooltip({
            time: 1000, open: 1, high: 3, low: 0.5, close: 2, volume: 10,
            tick1: 'PEPECREATURE', tick2: 'XCHAIN'
        });
        expect(html).to.include('<b>T1000</b>');
        for(const label of ['Open', 'High', 'Low', 'Close', 'Volume'])
            expect(html, `missing ${label} row`).to.include('<td>' + label + '</td>');
        expect(html).to.include('3.00000000');
        expect(html).to.include('PEPECREATURE');
        expect(html).to.include('XCHAIN');
    });

    it('collapses several trades at one timestamp by price, highest first', () => {
        const prices  = [{ x: 100, y: 2 }, { x: 100, y: 3 }, { x: 100, y: 2 }, { x: 200, y: 9 }];
        const volumes = [{ x: 100, y: 1 }, { x: 100, y: 5 }, { x: 100, y: 4 }, { x: 200, y: 7 }];
        const info = XCC.aggregateTrades(prices, volumes, 100);
        expect(info).to.deep.equal([
            [3, 5, 15],   // price 3: 5 base, 15 quote
            [2, 5, 10]    // prices 2 merged: 1 + 4 base
        ]);
        // The point at a different timestamp must not leak in.
        expect(info.map(r => r[0])).to.not.include(9);
    });

    it('renders one price/volume pair per aggregated trade', () => {
        const html = XCC.lineTooltip({
            time: 100,
            entries: [[3, 5, 15], [2, 5, 10]],
            tick1: 'PEPECREATURE', tick2: 'XCHAIN'
        });
        expect((html.match(/<td>Price<\/td>/g) || []).length).to.equal(2);
        expect((html.match(/<td>Volume<\/td>/g) || []).length).to.equal(2);
    });

    it('falls back to the single point when there is nothing to aggregate', () => {
        const html = XCC.lineTooltip({ time: 100, entries: [], price: 4, volume: 2, tick1: 'A', tick2: 'B' });
        expect(html).to.include('4.00000000');
        expect(html).to.include('2.00000000');
        expect((html.match(/<td>Price<\/td>/g) || []).length).to.equal(1);
    });

    it('labels a depth point by the side of the book it came from', () => {
        expect(XCC.depthTooltip({ price: 1, sum1: 2, sum2: 2, side: 'bids' })).to.include('Buy Depth');
        expect(XCC.depthTooltip({ price: 1, sum1: 2, sum2: 2, side: 'asks' })).to.include('Sell Depth');
    });

    it('escapes ticker names, which are attacker-controlled on-chain strings', () => {
        // Tooltips are injected with innerHTML, so an unescaped ticker would be
        // stored XSS on the market page.
        const html = XCC.candlestickTooltip({
            time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1,
            tick1: '<img src=x onerror=alert(1)>', tick2: '"><script>alert(2)</script>'
        });
        expect(html).to.not.include('<img');
        expect(html).to.not.include('<script>');
        expect(html).to.include('&lt;img');
    });

    it('reports the same tooltip for a candle rebuilt from Chart.js points', () => {
        // xcTooltip is the bridge Chart.js calls with its own dataPoints shape;
        // a shape change there silently blanks every tooltip.
        const cfg = XCC.candlestickConfig({
            ohlc:   [[1000, 1, 3, 0.5, 2]],
            volume: [[1000, 10]]
        }, { tick1: 'PEPECREATURE', tick2: 'XCHAIN' });
        const html = cfg.xcTooltip([
            { datasetIndex: 0, parsed: { x: 1000 }, raw: { x: 1000, o: 1, h: 3, l: 0.5, c: 2 } },
            { datasetIndex: 1, parsed: { x: 1000 }, raw: { x: 1000, y: 10 } }
        ]);
        expect(html).to.include('<b>T1000</b>');
        expect(html).to.include('10.00000000');
        expect(html).to.include('0.50000000');
    });

    it('resolves the depth tooltip back to the correct side and sums', () => {
        const cfg = XCC.depthConfig({
            asks: [[10, 1, 10]],
            bids: [[9,  2, 18]]
        }, { tick1: 'PEPECREATURE', tick2: 'XCHAIN' });
        expect(cfg.xcTooltip([{ parsed: { x: 9 } }])).to.include('Buy Depth');
        expect(cfg.xcTooltip([{ parsed: { x: 10 } }])).to.include('Sell Depth');
        expect(cfg.xcTooltip([])).to.equal('');
    });
});
