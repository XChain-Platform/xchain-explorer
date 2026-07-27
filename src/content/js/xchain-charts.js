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
 *
 * Thin adapter between the explorer's market data and Chart.js (MIT). It exists
 * because the explorer previously drove Highstock, which is proprietary and
 * cannot be redistributed from a public AGPL repo. Chart.js has no stock-chart
 * preset, so the pieces Highstock gave us for free - the zoom range selector,
 * the HTML tooltip tables, the PNG export button, the price-over-volume pane
 * split - are rebuilt here once and shared by all three market chart views.
 *
 * Everything above the "browser layer" marker is pure and runs under Node, so
 * the range math, tooltip markup and chart configs are unit tested without a
 * DOM. See test/unit/content-charts.test.js.
 */
(function(root, factory){
    if(typeof module === 'object' && module.exports)
        module.exports = factory();
    else
        root.XCC = factory();
})(typeof self !== 'undefined' ? self : this, function(){
    'use strict';

    var DAY = 86400000;

    // Zoom presets. Order is load-bearing: the index is what gets persisted to
    // localStorage.marketChartZoom, and it matches the index the Highstock
    // rangeSelector used to write, so existing visitors keep their preference.
    var RANGES = [
        { key: '1d',  label: '1d',  ms: DAY },
        { key: '2d',  label: '2d',  ms: 2 * DAY },
        { key: '1w',  label: '1w',  ms: 7 * DAY },
        { key: '1m',  label: '1m',  months: 1 },
        { key: '3m',  label: '3m',  months: 3 },
        { key: '6m',  label: '6m',  months: 6 },
        { key: '1y',  label: '1y',  months: 12 },
        { key: 'ytd', label: 'YTD', ytd: true },
        { key: 'all', label: 'All', all: true }
    ];

    // Highstock's rangeSelector.selected default was 3 (1 month).
    var DEFAULT_RANGE_INDEX = 3;

    // Formatters are indirected so Node tests can drive the tooltip builders
    // without jQuery/moment/numeral/mathjs loaded. In the browser these fall
    // through to the helpers xchain.js already defines.
    var formatters = {
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
    function esc(v){
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function rangeIndex(key){
        for(var i = 0; i < RANGES.length; i++)
            if(RANGES[i].key === key) return i;
        return -1;
    }

    // Accepts whatever localStorage hands back: the legacy numeric index, a
    // range key, or junk. Always resolves to a valid key.
    function normalizeRange(stored){
        if(stored === null || typeof stored === 'undefined' || stored === '')
            return RANGES[DEFAULT_RANGE_INDEX].key;
        var asString = String(stored);
        if(rangeIndex(asString) !== -1)
            return asString;
        var idx = parseInt(asString, 10);
        if(!isNaN(idx) && idx >= 0 && idx < RANGES.length)
            return RANGES[idx].key;
        return RANGES[DEFAULT_RANGE_INDEX].key;
    }

    // Resolve a preset to an explicit x-axis window anchored on the newest data
    // point, mirroring how Highstock anchored its range buttons. Returns null
    // for 'all' (and for empty data), which means "let the scale auto-fit".
    function rangeWindow(key, maxTs){
        var range = RANGES[rangeIndex(normalizeRange(key))];
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

    function tooltipRow(label, value, unit, cls){
        return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
               '<td>' + esc(label) + '</td>' +
               '<td class="separator">:</td>' +
               '<td class="text-right">' + esc(value) + '</td>' +
               '<td>' + esc(unit) + '</td></tr>';
    }

    function tooltipTable(rows){
        return '<table class="xc-chart-tooltip-table">' + rows.join('') + '</table>';
    }

    function candlestickTooltip(o){
        var rows = [
            tooltipRow('Open',  formatters.amount(o.open),  o.tick2, 'first'),
            tooltipRow('High',  formatters.amount(o.high),  o.tick2),
            tooltipRow('Low',   formatters.amount(o.low),   o.tick2),
            tooltipRow('Close', formatters.amount(o.close), o.tick2),
            tooltipRow('Volume', formatters.volume(o.volume || 0), o.tick1, 'border-top-1')
        ];
        return '<b>' + esc(formatters.time(o.time)) + '</b><br>' + tooltipTable(rows);
    }

    // A single timestamp can carry several trades at different prices. Collapse
    // them by price and report both the base-token volume and its quote-token
    // value, newest price first, which is what the old line tooltip did.
    function aggregateTrades(prices, volumes, time){
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

    function lineTooltip(o){
        var rows = [];
        var entries = o.entries && o.entries.length ? o.entries : [[o.price, o.volume, Number(o.price) * Number(o.volume)]];
        for(var i = 0; i < entries.length; i++){
            rows.push(tooltipRow('Price',  formatters.amount(entries[i][0]), o.tick2, i === 0 ? 'first' : ''));
            rows.push(tooltipRow('Volume', formatters.amount(entries[i][1]), o.tick1));
            rows.push('<tr><td colspan="2"></td><td class="text-right">' +
                      esc(formatters.amount(entries[i][2])) + '</td><td>' + esc(o.tick2) + '</td></tr>');
        }
        return '<b>' + esc(formatters.time(o.time)) + '</b><br>' + tooltipTable(rows);
    }

    function depthTooltip(o){
        var rows = [
            tooltipRow('Price', formatters.amount(o.price), o.tick2, 'first'),
            tooltipRow('Sum',   formatters.amount(o.sum1),  o.tick1),
            '<tr><td colspan="2"></td><td class="text-right">' +
                esc(formatters.amount(o.sum2)) + '</td><td>' + esc(o.tick2) + '</td></tr>'
        ];
        return '<b>' + esc(o.side === 'bids' ? 'Buy' : 'Sell') + ' Depth</b>' + tooltipTable(rows);
    }

    // Shared skeleton for the two time-series charts. Chart.js has no vertical
    // pane concept, so the price/volume split is expressed as two stacked
    // cartesian scales weighted 2:1 (the 60%/35% Highstock layout).
    function timeSeriesOptions(){
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                title:  { display: false },
                tooltip: { enabled: false }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { tooltipFormat: 'MMMM Do YYYY HH:mm' },
                    grid: { color: 'rgba(128,128,128,0.15)' },
                    ticks: { maxRotation: 0, autoSkip: true }
                },
                price: {
                    type: 'linear',
                    position: 'left',
                    stack: 'market',
                    stackWeight: 2,
                    min: 0,
                    title: { display: true, text: 'Price' },
                    grid: { color: 'rgba(128,128,128,0.15)' }
                },
                volume: {
                    type: 'linear',
                    position: 'left',
                    stack: 'market',
                    stackWeight: 1,
                    min: 0,
                    title: { display: true, text: 'Volume' },
                    grid: { color: 'rgba(128,128,128,0.15)' }
                }
            }
        };
    }

    function toXY(pairs){
        var out = [];
        for(var i = 0; i < (pairs || []).length; i++)
            out.push({ x: Number(pairs[i][0]), y: Number(pairs[i][1]) });
        return out;
    }

    function toOHLC(rows){
        var out = [];
        for(var i = 0; i < (rows || []).length; i++)
            out.push({
                x: Number(rows[i][0]),
                o: Number(rows[i][1]),
                h: Number(rows[i][2]),
                l: Number(rows[i][3]),
                c: Number(rows[i][4])
            });
        return out;
    }

    function lastTimestamp(rows){
        var max = 0;
        for(var i = 0; i < (rows || []).length; i++){
            var t = Number(rows[i][0]);
            if(t > max) max = t;
        }
        return max;
    }

    // data: { ohlc: [[ms,o,h,l,c],..], volume: [[ms,v],..] }
    function candlestickConfig(data, opts){
        opts = opts || {};
        var options = timeSeriesOptions();
        return {
            type: 'candlestick',
            data: {
                datasets: [{
                    label: 'OHLC',
                    yAxisID: 'price',
                    data: toOHLC(data && data.ohlc),
                    color: { up: '#339349', down: '#a42015', unchanged: '#7d7d7d' },
                    borderColor: { up: '#339349', down: '#a42015', unchanged: '#7d7d7d' }
                }, {
                    label: 'Volume',
                    type: 'bar',
                    yAxisID: 'volume',
                    data: toXY(data && data.volume),
                    backgroundColor: 'rgba(51,147,73,0.45)',
                    borderColor: 'rgba(51,147,73,0.8)',
                    borderWidth: 1,
                    maxBarThickness: 20
                }],
            },
            options: options,
            xcTooltip: function(items){
                var point = {
                    time: items.length ? items[0].parsed.x : 0,
                    tick1: opts.tick1,
                    tick2: opts.tick2,
                    open: 0, high: 0, low: 0, close: 0, volume: 0
                };
                for(var i = 0; i < items.length; i++){
                    var raw = items[i].raw || {};
                    if(items[i].datasetIndex === 0){
                        point.open  = raw.o;
                        point.high  = raw.h;
                        point.low   = raw.l;
                        point.close = raw.c;
                    } else {
                        point.volume = raw.y;
                    }
                }
                return candlestickTooltip(point);
            }
        };
    }

    // data: { trades: [[ms,price],..], volume: [[ms,vol],..] }
    function lineConfig(data, opts){
        opts = opts || {};
        var prices  = toXY(data && data.trades),
            volumes = toXY(data && data.volume);
        return {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Price',
                    yAxisID: 'price',
                    data: prices,
                    borderColor: '#325d88',
                    backgroundColor: '#325d88',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0
                }, {
                    label: 'Volume',
                    type: 'bar',
                    yAxisID: 'volume',
                    data: volumes,
                    backgroundColor: 'rgba(51,147,73,0.45)',
                    borderColor: 'rgba(51,147,73,0.8)',
                    borderWidth: 1,
                    maxBarThickness: 20
                }]
            },
            options: timeSeriesOptions(),
            xcTooltip: function(items){
                if(!items.length) return '';
                var time = items[0].parsed.x;
                return lineTooltip({
                    time: time,
                    entries: aggregateTrades(prices, volumes, time),
                    tick1: opts.tick1,
                    tick2: opts.tick2
                });
            }
        };
    }

    // orders: { asks: [[price, cumVol, cumValue],..], bids: [...] }
    // Both sides arrive pre-accumulated and pre-sorted from xchain.js.
    function depthConfig(orders, opts){
        opts = opts || {};
        orders = orders || {};
        var sideOf = {};
        function series(name, color){
            var rows = orders[name] || [],
                out  = [];
            for(var i = 0; i < rows.length; i++){
                var price = Number(rows[i][0]);
                sideOf[price] = { side: name, sum1: rows[i][1], sum2: rows[i][2] };
                out.push({ x: price, y: Number(rows[i][1]) });
            }
            return {
                label: name === 'asks' ? 'Asks' : 'Bids',
                data: out,
                borderColor: color,
                backgroundColor: color + '40',
                borderWidth: 2,
                fill: 'origin',
                pointRadius: 2,
                tension: 0
            };
        }
        var datasets = [series('asks', '#a42015'), series('bids', '#339349')];
        return {
            type: 'line',
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,
                interaction: { mode: 'nearest', intersect: false },
                plugins: {
                    legend: { display: false },
                    title:  { display: false },
                    tooltip: { enabled: false }
                },
                scales: {
                    x: { type: 'linear', title: { display: false }, grid: { color: 'rgba(128,128,128,0.15)' } },
                    y: { type: 'linear', title: { display: false }, grid: { color: 'rgba(128,128,128,0.15)' } }
                }
            },
            xcTooltip: function(items){
                if(!items.length) return '';
                var price = items[0].parsed.x,
                    meta  = sideOf[price] || { side: 'asks', sum1: 0, sum2: 0 };
                return depthTooltip({
                    price: price,
                    sum1:  meta.sum1,
                    sum2:  meta.sum2,
                    side:  meta.side,
                    tick1: opts.tick1,
                    tick2: opts.tick2
                });
            }
        };
    }

    // Pin the x scale to a preset window. Returns the config so callers can chain.
    function applyRange(config, key, maxTs){
        var win = rangeWindow(key, maxTs);
        var x = config.options.scales.x;
        if(win){
            x.min = win.min;
            x.max = win.max;
        } else {
            delete x.min;
            delete x.max;
        }
        return config;
    }

    function isEmptyConfig(config){
        var sets = (config.data && config.data.datasets) || [];
        for(var i = 0; i < sets.length; i++)
            if(sets[i].data && sets[i].data.length) return false;
        return true;
    }

    var api = {
        RANGES: RANGES,
        DEFAULT_RANGE_INDEX: DEFAULT_RANGE_INDEX,
        formatters: formatters,
        escapeHtml: esc,
        rangeIndex: rangeIndex,
        normalizeRange: normalizeRange,
        rangeWindow: rangeWindow,
        candlestickTooltip: candlestickTooltip,
        aggregateTrades: aggregateTrades,
        lineTooltip: lineTooltip,
        depthTooltip: depthTooltip,
        candlestickConfig: candlestickConfig,
        lineConfig: lineConfig,
        depthConfig: depthConfig,
        applyRange: applyRange,
        lastTimestamp: lastTimestamp,
        isEmptyConfig: isEmptyConfig
    };

    // ------------------------------------------------------------------
    // Browser layer. Skipped under Node so the module stays require()-able.
    // ------------------------------------------------------------------
    if(typeof document === 'undefined')
        return api;

    var instances = {};

    function tooltipElement(){
        var el = document.getElementById('xc-chart-tooltip');
        if(!el){
            el = document.createElement('div');
            el.id = 'xc-chart-tooltip';
            el.className = 'xc-chart-tooltip';
            document.body.appendChild(el);
        }
        return el;
    }

    // Chart.js only ships a canvas-drawn tooltip; the market tooltips are HTML
    // tables, so they are rendered into a floating div positioned off the
    // canvas rect (the useHTML:true equivalent).
    function externalTooltip(build){
        return function(context){
            var el      = tooltipElement(),
                tooltip = context.tooltip;
            if(!tooltip || tooltip.opacity === 0){
                el.style.opacity = 0;
                return;
            }
            var html = build(tooltip.dataPoints || []);
            if(!html){
                el.style.opacity = 0;
                return;
            }
            el.innerHTML = html;
            var rect = context.chart.canvas.getBoundingClientRect();
            el.style.opacity = 1;
            el.style.left = (rect.left + window.pageXOffset + tooltip.caretX + 12) + 'px';
            el.style.top  = (rect.top  + window.pageYOffset + tooltip.caretY + 12) + 'px';
        };
    }

    function button(label, title){
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline-secondary xc-chart-btn';
        b.innerHTML = label;
        if(title) b.title = title;
        return b;
    }

    function downloadPng(chart, name){
        var a = document.createElement('a');
        a.href = chart.toBase64Image('image/png', 1);
        a.download = (name || 'chart') + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function buildToolbar(container, chart, opts){
        var bar = document.createElement('div');
        bar.className = 'xc-chart-toolbar';

        if(opts.rangeSelector){
            var group = document.createElement('div');
            group.className = 'btn-group btn-group-sm xc-chart-ranges';
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', 'Chart zoom');
            RANGES.forEach(function(range, idx){
                var b = button(range.label, 'Zoom: ' + range.label);
                b.setAttribute('data-range', range.key);
                if(range.key === opts.range) b.classList.add('active');
                b.addEventListener('click', function(){
                    group.querySelectorAll('button').forEach(function(x){ x.classList.remove('active'); });
                    b.classList.add('active');
                    try { localStorage.setItem('marketChartZoom', idx); } catch(e){ /* private mode */ }
                    var win = rangeWindow(range.key, opts.maxTs);
                    if(win){
                        chart.options.scales.x.min = win.min;
                        chart.options.scales.x.max = win.max;
                    } else {
                        delete chart.options.scales.x.min;
                        delete chart.options.scales.x.max;
                    }
                    chart.update('none');
                });
                group.appendChild(b);
            });
            bar.appendChild(group);
        }

        var save = button('<i class="fa fa-download"></i>', 'Download PNG');
        save.className += ' xc-chart-export';
        save.addEventListener('click', function(){ downloadPng(chart, opts.name); });
        bar.appendChild(save);

        container.appendChild(bar);
    }

    /**
     * Draw a config into a container element, replacing whatever was there.
     * opts: { name, height, rangeSelector, range, maxTs, noData }
     */
    function render(containerId, config, opts){
        opts = opts || {};
        var container = document.getElementById(containerId);
        if(!container) return null;

        if(instances[containerId]){
            instances[containerId].destroy();
            delete instances[containerId];
        }
        container.innerHTML = '';
        container.classList.add('xc-chart');

        if(isEmptyConfig(config)){
            var msg = document.createElement('div');
            msg.className = 'xc-chart-nodata';
            msg.textContent = opts.noData || 'No data found';
            container.appendChild(msg);
            return null;
        }

        var wrap = document.createElement('div');
        wrap.className = 'xc-chart-canvas';
        wrap.style.height = (opts.height || 400) + 'px';
        var canvas = document.createElement('canvas');
        wrap.appendChild(canvas);

        if(config.xcTooltip)
            config.options.plugins.tooltip.external = externalTooltip(config.xcTooltip);

        // Toolbar is appended before the canvas so it sits above the plot, but
        // it needs the chart instance, so the canvas is constructed first.
        container.appendChild(wrap);
        var chart = new Chart(canvas.getContext('2d'), config);
        buildToolbar(container, chart, opts);
        container.insertBefore(container.lastChild, wrap);

        instances[containerId] = chart;
        return chart;
    }

    function destroy(containerId){
        if(instances[containerId]){
            instances[containerId].destroy();
            delete instances[containerId];
        }
    }

    api.render  = render;
    api.destroy = destroy;
    api.externalTooltip = externalTooltip;
    api.instances = instances;

    return api;
});
