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

var xcChartsRoot = (typeof self !== 'undefined') ? self : this;
var data = (typeof module === 'object' && module.exports)
    ? require('./data.js') : xcChartsRoot.XCC;
var xcChartsCandlestickTooltip = data.candlestickTooltip,
        xcChartsAggregateTrades = data.aggregateTrades,
        xcChartsLineTooltip = data.lineTooltip,
        xcChartsDepthTooltip = data.depthTooltip,
        xcChartsRangeWindow = data.rangeWindow;

function xcChartsWithExact(point, exact){
    for(var key in exact)
        if(Object.prototype.hasOwnProperty.call(exact, key))
            Object.defineProperty(point, key, { value: exact[key], enumerable: false });
    return point;
}

function xcChartsTimeSeriesOptions(){
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

    function xcChartsToXY(pairs){
        var out = [];
        for(var i = 0; i < (pairs || []).length; i++)
            out.push(xcChartsWithExact(
                { x: Number(pairs[i][0]), y: Number(pairs[i][1]) },
                { exactX: String(pairs[i][0]), exactY: String(pairs[i][1]) }
            ));
        return out;
    }

    function xcChartsToOHLC(rows){
        var out = [];
        for(var i = 0; i < (rows || []).length; i++)
            out.push(xcChartsWithExact({
                x: Number(rows[i][0]),
                o: Number(rows[i][1]),
                h: Number(rows[i][2]),
                l: Number(rows[i][3]),
                c: Number(rows[i][4])
            }, {
                exactO: String(rows[i][1]),
                exactH: String(rows[i][2]),
                exactL: String(rows[i][3]),
                exactC: String(rows[i][4])
            }));
        return out;
    }



    // data: { ohlc: [[ms,o,h,l,c],..], volume: [[ms,v],..] }
    function xcChartsCandlestickConfig(data, opts){
        opts = opts || {};
        var options = xcChartsTimeSeriesOptions();
        return {
            type: 'candlestick',
            data: {
                datasets: [{
                    label: 'OHLC',
                    yAxisID: 'price',
                    data: xcChartsToOHLC(data && data.ohlc),
                    color: { up: '#339349', down: '#a42015', unchanged: '#7d7d7d' },
                    borderColor: { up: '#339349', down: '#a42015', unchanged: '#7d7d7d' }
                }, {
                    label: 'Volume',
                    type: 'bar',
                    yAxisID: 'volume',
                    data: xcChartsToXY(data && data.volume),
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
                        point.open  = raw.exactO == null ? raw.o : raw.exactO;
                        point.high  = raw.exactH == null ? raw.h : raw.exactH;
                        point.low   = raw.exactL == null ? raw.l : raw.exactL;
                        point.close = raw.exactC == null ? raw.c : raw.exactC;
                    } else {
                        point.volume = raw.exactY == null ? raw.y : raw.exactY;
                    }
                }
                return xcChartsCandlestickTooltip(point);
            }
        };
    }

    // data: { trades: [[ms,price],..], volume: [[ms,vol],..] }
    function xcChartsLineConfig(data, opts){
        opts = opts || {};
        var prices  = xcChartsToXY(data && data.trades),
            volumes = xcChartsToXY(data && data.volume);
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
            options: xcChartsTimeSeriesOptions(),
            xcTooltip: function(items){
                if(!items.length) return '';
                var time = items[0].parsed.x;
                return xcChartsLineTooltip({
                    time: time,
                    entries: xcChartsAggregateTrades(prices, volumes, time),
                    tick1: opts.tick1,
                    tick2: opts.tick2
                });
            }
        };
    }

    function xcChartsDepthSeries(rows, name, color, sideOf){
        var out = [];
        for(var i = 0; i < rows.length; i++){
            var price = Number(rows[i][0]);
            sideOf[price] = { side: name, sum1: rows[i][1], sum2: rows[i][2] };
            out.push(xcChartsWithExact(
                { x: price, y: Number(rows[i][1]) },
                { exactX: String(rows[i][0]), exactY: String(rows[i][1]), side: name,
                    sum1: String(rows[i][1]), sum2: String(rows[i][2]) }
            ));
        }
        return {
            label: name === 'asks' ? 'Asks' : 'Bids', data: out,
            borderColor: color, backgroundColor: color + '40', borderWidth: 2,
            fill: 'origin', pointRadius: 2, tension: 0
        };
    }

    // orders: { asks: [[price, cumVol, cumValue],..], bids: [...] }
    // Both sides arrive pre-accumulated and pre-sorted from xchain.js.
    function xcChartsDepthConfig(orders, opts){
        opts = opts || {};
        orders = orders || {};
        var sideOf = {};
        var datasets = [
            xcChartsDepthSeries(orders.asks || [], 'asks', '#a42015', sideOf),
            xcChartsDepthSeries(orders.bids || [], 'bids', '#339349', sideOf)
        ];
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
                var raw = items[0].raw || {},
                    price = raw.exactX == null ? items[0].parsed.x : raw.exactX,
                    meta = raw.side ? raw : (sideOf[items[0].parsed.x] || { side: 'asks', sum1: 0, sum2: 0 });
                return xcChartsDepthTooltip({
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
    function xcChartsApplyRange(config, key, maxTs){
        var win = xcChartsRangeWindow(key, maxTs);
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

    function xcChartsIsEmptyConfig(config){
        var sets = (config.data && config.data.datasets) || [];
        for(var i = 0; i < sets.length; i++)
            if(sets[i].data && sets[i].data.length) return false;
        return true;
    }

var xcChartsConfigsPart = {
        candlestickConfig: xcChartsCandlestickConfig,
        lineConfig: xcChartsLineConfig,
        depthConfig: xcChartsDepthConfig,
        applyRange: xcChartsApplyRange,
        isEmptyConfig: xcChartsIsEmptyConfig
    };

if(typeof module === 'object' && module.exports){
    module.exports = xcChartsConfigsPart;
} else {
    xcChartsRoot.XCC = Object.assign(xcChartsRoot.XCC || {}, xcChartsConfigsPart);
}
