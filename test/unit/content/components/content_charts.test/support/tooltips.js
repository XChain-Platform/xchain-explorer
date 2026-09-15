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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const XCC = require('../../../../src/content/js/xchain_charts.js');

// Chart.js draws its own tooltip on the canvas; these market tooltips are
// HTML tables, so the markup is built here and injected. Pin the formatters
// so the assertions are about layout, not about numeral/mathjs rounding.
let savedTooltipFormatters;
function setTooltipFormatters() {
    savedTooltipFormatters = { ...XCC.formatters };
    XCC.formatters.amount = v => Number(v).toFixed(8);
    XCC.formatters.volume = v => Number(v).toFixed(8);
    XCC.formatters.time   = ms => 'T' + ms;
}
function restoreTooltipFormatters() {
    Object.assign(XCC.formatters, savedTooltipFormatters);
}

describe('XCC tooltips', () => {
    beforeEach(setTooltipFormatters);
    afterEach(restoreTooltipFormatters);

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

});

describe('XCC tooltips', () => {
    beforeEach(setTooltipFormatters);
    afterEach(restoreTooltipFormatters);

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
