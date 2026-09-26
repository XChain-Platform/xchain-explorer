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
 * market_updates.js
 *
 * Custom javascript for xchain explorer
 */

// Request market data and update the header with this information
function updateMarketBasics(market){
    loadApiData(XC.coin, 'market', market, null, function(o){
        // An answer without a resolvable pair (the API returns no row for an
        // unknown pair) is a resolution failure; say so instead of leaving
        // every panel on "Loading".
        if(!o || isNull(o.tick2)){
            showMarketNotFound(String(market).split('/')[0]);
            return;
        }
        // Update page with token names
        $('.tick1-name').text(o.tick1);
        $('.tick2-name').text(o.tick2);
        // Update Market information header
        $('#tokenIconLink1').attr('href',tokenUrl(XC.coin, o.tick1));
        $('#tokenIconLink2').attr('href',tokenUrl(XC.coin, o.tick2));
        $('#tokenIcon1').attr('src', getTokenIcon(o.tick1));
        $('#tokenIcon2').attr('src', getTokenIcon(o.tick2));
        $('#tokenLink1').attr('href', tokenUrl(XC.coin, o.tick1));
        $('#tokenLink2').attr('href', tokenUrl(XC.coin, o.tick2));
        $('#market-swap-button').attr('href', '/' + XC.coin + '/market/' + encodeURIComponent(String(o.tick2)) + '/' + encodeURIComponent(String(o.tick1)));
        // Update Price information header
        $('#tick1-price').text(formatAmount(bcformat(o.tick1_price,8)));
        $('#tick1-24h-high').text(formatAmount(bcformat(o.tick1_24hr_high,8)));
        $('#tick1-24h-low').text(formatAmount(bcformat(o.tick1_24hr_low,8)));
        $('#tick1-24h-price').text(formatAmount(bcformat(o.tick1_24hr_price,8)));
        $('#tick1-24h-change').text(formatAmount(bcformat(o.tick1_24hr_change,8)));
        $('#tick1-24h-volume').text(formatAmount(bcformat(o.tick1_24hr_volume,8)));
    });
}

// Request market orderbook data and populating the buy/sell order tabs
function updateMarketOrders(market, page, full, count=0 ){
    loadApiData(XC.coin, 'market', market, 'orderbook?page=' + page, function(o){
        if(o){
            // Store the orderbook data in a global variable
            XC.CHART_DATA.orderbook = o;
            var asks_total1 = 0,
                asks_total2 = 0,
                bids_total1 = 0,
                bids_total2 = 0;
            // Calculate amount and sums for asks
            $.each(o.asks, function(idx, data){
                data[2] = bcmul(data[0],data[1]);
                data[3] = bcadd(asks_total1, data[2]);
                data[4] = bcadd(asks_total2, data[1]);
                asks_total1  = data[3];
                asks_total2  = data[4];
            });
            // Calculate amount and sums for bids
            $.each(o.bids, function(idx, data){
                data[2] = bcmul(data[0],data[1]);
                data[3] = bcadd(bids_total1, data[2]);
                data[4] = bcadd(bids_total2, data[1]);
                bids_total1  = data[3];
                bids_total2  = data[4];
            });
            // Define config for orderbook datatables
            let config = {
                dom:            't',
                sortable:       false,
                searching:      false,
                ordering:       false,
                scrollCollapse: false,
                paging:         false,
                createdRow: function( row, data, idx ){
                    $('td', row).eq(0).text(formatAmount(bcformat(data[0],8)));
                    $('td', row).eq(1).text(formatAmount(bcformat(data[1],8)));
                    $('td', row).eq(2).text(formatAmount(bcformat(data[2],8)));
                    $('td', row).eq(3).text(formatAmount(bcformat(data[3],8)));
                    $('td', row).eq(4).text(formatAmount(bcformat(data[4],8)));
                }
            };
            // Initialize the sell orders table
            $('#datatable-sells').DataTable(Object.assign({}, config, {
                data: o.asks,
                language: {
                    emptyTable: "No sell orders found"
                }
            }));
            // Initialize the buy orders table
            $('#datatable-buys').DataTable(Object.assign({}, config, {
                data: o.bids,
                language: {
                    emptyTable: "No buy orders found"
                }
            }));
        }
    });
}

// Request market history data and save to XC.CHART_DATA
function updateMarketHistory(market, page=1, full=false, count=0){
    // Reset any stored chart data
    if(full && page==1)
        XC.RAW_CHART_DATA = [];
    // Load a page worth of market history data
    loadApiData(XC.coin, 'market', market, 'history?page=' + page, function(o){
        marketUpdates_handleHistory(o, market, page, full, count);
    });
}

// Complete pagination before preparing the market chart data.
function marketUpdates_handleHistory(o, market, page, full, count){
    if(o.data){
        // Extract just the raw data to display in the chart
        o.data.forEach(function(data){
            XC.RAW_CHART_DATA.push([data.timestamp, data.price, data.amount]);
        });
        count = bcadd(count, o.data.length);
    }
    // If a full update was requested, keep updating
    if(full && count < o.total){
        updateMarketHistory(market, page+1, true, count);
        return;
    }
    marketUpdates_renderHistory();
}

// Prepare and publish the trade and candle series for the chart.
function marketUpdates_renderHistory(){
    // Break raw data up into useful arrays
    var data    = XC.RAW_CHART_DATA,
        trades  = [], // Time / Price
        volume  = []; // Timestamp / Volume (trades)
    // Sort the data by date oldest to newest
    data.sort(function(a,b){
        if(a[0] < b[0]) return -1;
        if(a[0] > b[0]) return 1;
        return 0;
    });
    // Split data into price and volume arrays
    // Multiply timestamp by 1000 to convert to milliseconds
    $.each(data,function(idx, item){
        trades.push([item[0] * 1000,item[1]]);  // Time / Price
        volume.push([item[0] * 1000,item[2]]);  // Time / Volume
    });
    let candles = marketUpdates_historyCandles(data);
    // Save the processed chart data for easy reference
    XC.CHART_DATA.trades = {
        trades: trades,
        volume: volume
    }
    XC.CHART_DATA.ohlc = {
        ohlc: candles.ohlc,
        volume: candles.volume
    };
    // Re-draw whichever market chart view is currently mounted with the new data
    if(typeof XC.chartRenderer === 'function')
        XC.chartRenderer();
}

// Aggregate raw trades into timestamped candle and volume arrays.
function marketUpdates_historyCandles(data){
    var ohlc    = [], // Time / Open / High / Low / Close
        volume2 = [], // Timestamp / Volume (ohlc)
        tstamp  = 0,
        open    = 0,
        high    = 0,
        low     = 0,
        close   = 0,
        vol     = 0;
    // Split data into ohlc and volume arrays
    $.each(data,function(idx, item){
        if(item[0]==tstamp){
            close  = item[1];
            if(bcnum(item[1]).gt(bcnum(high))) high = item[1];
            if(bcnum(item[1]).lt(bcnum(low)))  low  = item[1];
            // Accumulate volume via bignumber to avoid IEEE-754 drift on
            // high-precision token amounts and overflow past MAX_SAFE_INTEGER
            // for large-supply 0-decimal tokens.
            vol = bcadd(vol, item[2]);
        } else {
            // Add data to the arrays
            if(tstamp){
                var ms = tstamp * 1000; // Multiply timestamp by 1000 to convert to milliseconds
                ohlc.push([ms, open, high, low, close]);
                volume2.push([ms, vol]);
            }
            // Update stats
            tstamp = item[0];
            open   = item[1];
            high   = item[1];
            low    = item[1];
            close  = item[1];
            vol    = item[2];
        }
    });
    return { ohlc: ohlc, volume: volume2 };
}
