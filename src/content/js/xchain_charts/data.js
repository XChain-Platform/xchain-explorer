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
 * XChain chart layer (XCC)
 */
'use strict';

var xcChartsDay = 86400000;

    // Zoom presets. Order is load-bearing: the index is what gets persisted to
    // localStorage.marketChartZoom, matching the index Highstock's rangeSelector
    // writes there, so existing visitors keep their stored preference.
    var xcChartsRanges = [
        { key: '1d',  label: '1d',  ms: xcChartsDay },
        { key: '2d',  label: '2d',  ms: 2 * xcChartsDay },
        { key: '1w',  label: '1w',  ms: 7 * xcChartsDay },
        { key: '1m',  label: '1m',  months: 1 },
        { key: '3m',  label: '3m',  months: 3 },
        { key: '6m',  label: '6m',  months: 6 },
        { key: '1y',  label: '1y',  months: 12 },
        { key: 'ytd', label: 'YTD', ytd: true },
        { key: 'all', label: 'All', all: true }
    ];

    // Highstock's rangeSelector.selected default was 3 (1 month).
    var xcChartsDefaultRangeIndex = 3;

    // Formatters are indirected so Node tests can drive the tooltip builders
    // without jQuery/moment/numeral/mathjs loaded. In the browser these fall
    // through to the helpers xchain.js already defines.
    var xcChartsFormatters = {
        amount: function(v){
            if(typeof formatAmount === 'function' && typeof bcformat === 'function')
                return formatAmount(bcformat(v, 8));
            return String(v);
        },
        volume: function(v){
            if(typeof numeral === 'function')
                return numeral(v).format('0,0.00000000');
            return String(v);
        },
        time: function(ms){
            if(typeof moment === 'function')
                return moment(ms).format('MMMM Mo YYYY HH:mm');
            return new Date(ms).toISOString();
        }
    };

    // Escape anything that reaches tooltip markup. Ticker names are
    // user-supplied on-chain strings and the tooltips are rendered with
    // innerHTML, so this is the boundary that keeps them inert.
    function xcChartsEscape(v){
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function xcChartsRangeIndex(key){
        for(var i = 0; i < xcChartsRanges.length; i++)
            if(xcChartsRanges[i].key === key) return i;
        return -1;
    }

    // Accepts whatever localStorage hands back: the legacy numeric index, a
    // range key, or junk. Always resolves to a valid key.
    function xcChartsNormalizeRange(stored){
        if(stored === null || typeof stored === 'undefined' || stored === '')
            return xcChartsRanges[xcChartsDefaultRangeIndex].key;
        var asString = String(stored);
        if(xcChartsRangeIndex(asString) !== -1)
            return asString;
        var idx = parseInt(asString, 10);
        if(!isNaN(idx) && idx >= 0 && idx < xcChartsRanges.length)
            return xcChartsRanges[idx].key;
        return xcChartsRanges[xcChartsDefaultRangeIndex].key;
    }

    // Resolve a preset to an explicit x-axis window anchored on the newest data
    // point, mirroring how Highstock anchored its range buttons. Returns null
    // for 'all' (and for empty data), which means "let the scale auto-fit".
    function xcChartsRangeWindow(key, maxTs){
        var range = xcChartsRanges[xcChartsRangeIndex(xcChartsNormalizeRange(key))];
        if(range.all || !maxTs)
            return null;
        var max = Number(maxTs);
        if(range.ms)
            return { min: max - range.ms, max: max };
        if(range.ytd){
            var jan = new Date(max);
            return { min: Date.UTC(jan.getUTCFullYear(), 0, 1), max: max };
        }
        // Calendar months, so "3m" from Mar 31 lands on Dec 31 rather than
        // drifting by the 30/31-day mismatch a fixed millisecond span gives.
        var d = new Date(max);
        d.setUTCMonth(d.getUTCMonth() - range.months);
        return { min: d.getTime(), max: max };
    }

    function xcChartsTooltipRow(label, value, unit, cls){
        return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
               '<td>' + xcChartsEscape(label) + '</td>' +
               '<td class="separator">:</td>' +
               '<td class="text-right">' + xcChartsEscape(value) + '</td>' +
               '<td>' + xcChartsEscape(unit) + '</td></tr>';
    }

    function xcChartsTooltipTable(rows){
        return '<table class="xc-chart-tooltip-table">' + rows.join('') + '</table>';
    }

    function xcChartsCandlestickTooltip(o){
        var rows = [
            xcChartsTooltipRow('Open',  xcChartsFormatters.amount(o.open),  o.tick2, 'first'),
            xcChartsTooltipRow('High',  xcChartsFormatters.amount(o.high),  o.tick2),
            xcChartsTooltipRow('Low',   xcChartsFormatters.amount(o.low),   o.tick2),
            xcChartsTooltipRow('Close', xcChartsFormatters.amount(o.close), o.tick2),
            xcChartsTooltipRow('Volume', xcChartsFormatters.volume(o.volume || 0), o.tick1, 'border-top-1')
        ];
        return '<b>' + xcChartsEscape(xcChartsFormatters.time(o.time)) + '</b><br>' + xcChartsTooltipTable(rows);
    }

    // A single timestamp can carry several trades at different prices. Collapse
    // them by price and report both the base-token volume and its quote-token
    // value, newest price first, which is what the old line tooltip did.
    function xcChartsAggregateTrades(prices, volumes, time){
        var totals = {};
        for(var i = 0; i < prices.length; i++){
            var p = prices[i];
            if(!p || Number(p.x) !== Number(time)) continue;
            var vol = volumes[i] ? Number(volumes[i].y) : 0,
                key = String(p.y);
            if(!totals[key]) totals[key] = [0, 0];
            totals[key][0] += vol;
            totals[key][1] += Number(p.y) * vol;
        }
        var info = [];
        for(var price in totals)
            if(Object.prototype.hasOwnProperty.call(totals, price))
                info.push([Number(price), totals[price][0], totals[price][1]]);
        info.sort(function(a, b){ return b[0] - a[0]; });
        return info;
    }

    function xcChartsLineTooltip(o){
        var rows = [];
        var entries = o.entries && o.entries.length ? o.entries : [[o.price, o.volume, Number(o.price) * Number(o.volume)]];
        for(var i = 0; i < entries.length; i++){
            rows.push(xcChartsTooltipRow('Price',  xcChartsFormatters.amount(entries[i][0]), o.tick2, i === 0 ? 'first' : ''));
            rows.push(xcChartsTooltipRow('Volume', xcChartsFormatters.amount(entries[i][1]), o.tick1));
            rows.push('<tr><td colspan="2"></td><td class="text-right">' +
                      xcChartsEscape(xcChartsFormatters.amount(entries[i][2])) + '</td><td>' + xcChartsEscape(o.tick2) + '</td></tr>');
        }
        return '<b>' + xcChartsEscape(xcChartsFormatters.time(o.time)) + '</b><br>' + xcChartsTooltipTable(rows);
    }

    function xcChartsDepthTooltip(o){
        var rows = [
            xcChartsTooltipRow('Price', xcChartsFormatters.amount(o.price), o.tick2, 'first'),
            xcChartsTooltipRow('Sum',   xcChartsFormatters.amount(o.sum1),  o.tick1),
            '<tr><td colspan="2"></td><td class="text-right">' +
                xcChartsEscape(xcChartsFormatters.amount(o.sum2)) + '</td><td>' + xcChartsEscape(o.tick2) + '</td></tr>'
        ];
        return '<b>' + xcChartsEscape(o.side === 'bids' ? 'Buy' : 'Sell') + ' Depth</b>' + xcChartsTooltipTable(rows);
    }

    // Shared skeleton for the two time-series charts. Chart.js has no vertical
    // pane concept, so the price/volume split is expressed as two stacked
    // cartesian scales weighted 2:1 (the 60%/35% Highstock layout).

function xcChartsLastTimestamp(rows){
        var max = 0;
        for(var i = 0; i < (rows || []).length; i++){
            var t = Number(rows[i][0]);
            if(t > max) max = t;
        }
        return max;
    }

var xcChartsDataPart = {
        RANGES: xcChartsRanges,
        DEFAULT_RANGE_INDEX: xcChartsDefaultRangeIndex,
        formatters: xcChartsFormatters,
        escapeHtml: xcChartsEscape,
        rangeIndex: xcChartsRangeIndex,
        normalizeRange: xcChartsNormalizeRange,
        rangeWindow: xcChartsRangeWindow,
        candlestickTooltip: xcChartsCandlestickTooltip,
        aggregateTrades: xcChartsAggregateTrades,
        lineTooltip: xcChartsLineTooltip,
        depthTooltip: xcChartsDepthTooltip,
        lastTimestamp: xcChartsLastTimestamp
    };

if(typeof module === 'object' && module.exports){
    module.exports = xcChartsDataPart;
} else {
    var xcChartsRoot = (typeof self !== 'undefined') ? self : this;
    xcChartsRoot.XCC = Object.assign(xcChartsRoot.XCC || {}, xcChartsDataPart);
}
