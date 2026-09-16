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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Determine if a given network is supported in this xchain-explorer instance
function isNetworkSupported(coin, callback){
    getExplorerStatusInfo(function(o){
        let supported = false;
        if(o && o.supported && o.supported[coin])
            supported = true;
        if(typeof callback === 'function')
            callback(supported);
    });
}

// Determine if a given network is available in this xchain-explorer instance
function isNetworkAvailable(coin, callback){
    getExplorerStatusInfo(function(o){
        let supported = false;
        if(o && o.available && o.available[coin])
            supported = true;
        if(typeof callback === 'function')
            callback(supported);
    });
}

// Handle wrapping search terms in a span to highlight the term
function highlightSearchTerm(term, text){
    // A nullable column reaches here as a real null (a BROADCAST v3 carries no
    // message, a v0 carries no memo, a token can have no description), and
    // String(null) is the four-character word "null", so an absent value would
    // render as that text. Same defect class as the nullToBlank cells, by a
    // third route: blank it before the coercion below can name it.
    if(isNull(text)) return '';
    // This result is inserted via .html() on the list pages, and `text` is
    // untrusted on-chain content (memo / message / description). Escape it
    // first so the only markup we introduce is the highlight <span>. Without
    // this, a token memo/description of "<img src=x onerror=…>" is stored XSS.
    text = escapeHtml(String(text));
    term = escapeHtml(String(term));
    if(!term) return text;
    // Escape regex metacharacters so a crafted search term can't form an invalid
    // or catastrophic-backtracking (ReDoS) pattern; match within the escaped text.
    let safe  = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex = new RegExp(safe, 'gi');
    return text.replace(regex, function(match){
        return '<span class="highlight-search-term">' + match + '</span>';
    });
}

// Handle update the search network on the search page
function setSearchNetwork(coin){
    $('#search-form li a').each(function(){
        var el = $(this);
        if(el.data('coin')==coin){
            let html = el.html();
            $('#search-coin').val(coin);
            $('#search-coin-dropdown').html(html);
        }
    });
    // Handle displaying `Network not available` message
    isNetworkAvailable(coin, function(supported){
        var el = $('#networkNotSupported');
        if(supported){
            el.hide();
        } else {
            el.show();
        }
    });
}

// Populate the search networks dropdown on the search page
function populateSearchNetworks(type='supported'){
    let o       = XC.status,
        data    = (type=='available') ? o.available : o.supported,
        mainnet = '',
        testnet = '',
        regtest = '';
    // Loop through networks and generate menu items
    for(let coin in data){
        let info    = String(data[coin]).replace(')','').split('(');
        let chain   = String(info[0]).trim();
        let network = String(info[1]).toLowerCase();
        let iconCls = getNetworkIcon(chain, network);
        let item    = '<li><a class="dropdown-item" data-coin="' + coin + '" title="' + chain + '" ><span class="wrapicon-25"><i class="fa ' + iconCls + '" ></i></span>' + chain + '</a></li>';
        if(network=='mainnet') mainnet += item;
        if(network=='testnet') testnet += item;
        if(network=='regtest') regtest += item;
    }
    // Create the final menu with headers and menu items
    let menu = '';
    if(!isNull(mainnet)) menu += '<li><h6 class="dropdown-header">Mainnet</h6></li>' + mainnet;
    if(!isNull(testnet)) menu += '<li><h6 class="dropdown-header">Testnet</h6></li>' + testnet;
    if(!isNull(regtest)) menu += '<li><h6 class="dropdown-header">Regtest</h6></li>' + regtest;
    // Update the search coin networks dropdown with the new menu
    $('#search-coin-dropdown-menu').html(menu);
}

// Handle updating the page info (title, description, canonical, robots, social cards)
function updatePageInfo(){
    var info = XC.pageInfo;
    // Update page title
    let title = XC.pageInfo.defaultTitle;
    if(!isNull(info.title))
        title = info.title + ' | ' + XC.pageInfo.defaultTitle;
    $('html head title').text(title);
    // Update page description
    if(!isNull(info.description))
        $('meta[name="description"]').attr('content',info.description);
    // Generate and update the Canonical URL
    let win  = window.location,
        host = win.protocol + '//' + win.host,
        path = (!isNull(info.canonical)) ? info.canonical : win.pathname,
        url  = host + path;
    // A <link> carries its target in href. Setting src here left every page
    // shipping an EMPTY canonical while still marked index,follow.
    $('link[rel="canonical"]').attr('href', url);
    // Keep the social cards in step with the canonical page identity, or every
    // shared explorer link previews as the bare site-wide default.
    $('meta[property="og:url"]').attr('content', url);
    $('meta[property="og:title"]').attr('content', title);
    $('meta[name="twitter:title"]').attr('content', title);
    if(!isNull(info.description)){
        $('meta[property="og:description"]').attr('content', info.description);
        $('meta[name="twitter:description"]').attr('content', info.description);
    }
    // Update robots tag
    if(!isNull(info.robots))
        $('meta[name="robots"]').attr('content',info.robots);
}

// Resolve the counter-tick of a market pair. A market URL may name only the
// primary tick (/{COIN}/market/{TICK}); the counter then comes from the top
// market listed for that tick, never from the missing path segment (an absent
// segment would stringify as the literal "undefined"). A counter given in the
// URL passes through unchanged. `fail` runs when no market exists for the
// tick, so the page can say so rather than render a half-composed pair.
function resolveMarketPair(tick1, tick2, done, fail){
    if(!isNull(tick2)){
        done(tick2);
        return;
    }
    loadApiData(XC.coin, 'markets', tick1, null, function(o){
        let list    = (o && o.data) ? o.data : [],
            wanted  = String(tick1).toUpperCase(),
            counter = null;
        for(let idx in list){
            // The list re-orients each pair around the searched tick, so take
            // whichever side is not the tick we asked about.
            let m = list[idx],
                c = (String(m.tick1).toUpperCase()==wanted) ? m.tick2 : m.tick1;
            if(!isNull(c) && String(c).toUpperCase()!=wanted){
                counter = c;
                break;
            }
        }
        if(!isNull(counter)){
            done(counter);
        } else if(typeof fail==='function'){
            fail();
        }
    });
}

// Render a visible failed-resolution state for a market page. Silently blank
// panels (or a stringified "undefined") hide that the requested pair does not
// exist on this chain, so the failure is stated in the title and the panels.
function showMarketNotFound(tick){
    XC.pageInfo.title = tick + ' Market Not Found';
    updatePageInfo();
    $('.market-name').text(tick + ' MARKET NOT FOUND');
    $('.market-description').text('No market was found for ' + tick + ' on the ' + XC.name + ' (' + XC.network + ') blockchain network');
    $('.loading-data').text('No market data available');
}

// Handle updating/displaying market information
function loadMarket(market){
    updateMarketBasics(market);
    updateMarketOrders(market, 1, true);
    updateMarketHistory(market, 1, true);
}

// Draw the simple line view from the trade series already parsed into XC.CHART_DATA
function renderMarketChartLine(){
    let data = XC.CHART_DATA.trades;
    if(!data)
        return;
    let maxTs = XCC.lastTimestamp(data.trades),
        range = XCC.normalizeRange(ls.getItem('marketChartZoom')),
        cfg   = XCC.lineConfig(data, { tick1: XC.tick1, tick2: XC.tick2 });
    XCC.applyRange(cfg, range, maxTs);
    XCC.render('market-chart-line', cfg, {
        name:          'market',
        height:        400,
        rangeSelector: true,
        range:         range,
        maxTs:         maxTs,
        noData:        'No Trades Found'
    });
}

// Draw the candlestick view from the OHLC series already parsed into XC.CHART_DATA
function renderMarketChartCandlestick(){
    let data = XC.CHART_DATA.ohlc;
    if(!data)
        return;
    let maxTs = XCC.lastTimestamp(data.ohlc),
        range = XCC.normalizeRange(ls.getItem('marketChartZoom')),
        cfg   = XCC.candlestickConfig(data, { tick1: XC.tick1, tick2: XC.tick2 });
    XCC.applyRange(cfg, range, maxTs);
    // Failover to the simple line chart if the candlestick controller is
    // unavailable or the data will not plot
    try {
        XCC.render('market-chart-candlestick', cfg, {
            name:          'candlestick',
            height:        400,
            rangeSelector: true,
            range:         range,
            maxTs:         maxTs,
            noData:        'No Trades Found'
        });
    } catch(e){
        loadMarketChart('line');
    }
}

// Draw the market depth view from the orderbook already stored on XC.CHART_DATA
function renderMarketChartDepth(){
    let orders = XC.CHART_DATA.orderbook,
        types  = ['asks','bids'];
    if(!orders)
        return;
    // A market with only one side of the book still has to draw
    $.each(types, function(idx,name){
        if(!Array.isArray(orders[name]))
            orders[name] = [];
    });
    // Accumulate each side into running volume/value sums, which is what the
    // depth curve plots and what the tooltip reports
    $.each(types, function(idx,name){
        var a = 0,
            b = 0;
        $.each(orders[name],function(ndx,data){
            data[2] = numeral(parseFloat(data[0]) * parseFloat(data[1])).format('0.00000000');
            a       = numeral(parseFloat(a) + parseFloat(data[1])).format('0.00000000');
            b       = numeral(parseFloat(b) + parseFloat(data[2])).format('0.00000000');
            data[1] = a;
            data[2] = b;
        });
    });
    // Convert all values to floats
    $.each(types, function(idx,name){
        $.each(orders[name],function(ndx,data){
            data[0] = parseFloat(data[0]);
            data[1] = parseFloat(data[1]);
        });
    });
    // Sort the data in ascending order
    $.each(types, function(idx, name){
        orders[name].sort(function(a,b){
            if(a[0] < b[0]) return -1;
            if(a[0] > b[0]) return 1;
            return 0;
        });
    });
    let cfg = XCC.depthConfig(orders, { tick1: XC.tick1, tick2: XC.tick2 });
    XCC.render('market-chart-depth', cfg, {
        name:   'market-depth',
        height: 400,
        noData: 'No buy or sell orders found'
    });
}

// Every market chart view draws from a renderer that ships inside this bundle.
// A fragment that carries its own <script> block is a hazard here, because
// jQuery 1.10's .load()/.html() hands any script it finds to jQuery.globalEval,
// which is window.eval() of a string. Under a Content-Security-Policy without
// 'unsafe-eval' (the policy this service actually sets, src/api.js) that eval
// is refused, the exception is uncaught inside the AJAX success handler, and
// the chart silently never draws while the page still reads green. Keeping the
// drawing code here and the fragments script-free removes the eval entirely.
let MARKET_CHART_RENDERERS = {
    'line':         renderMarketChartLine,
    'candlestick':  renderMarketChartCandlestick,
    'market-depth': renderMarketChartDepth
};

// Insert an HTML fragment WITHOUT evaluating any script it carries.
// $.parseHTML(html) defaults keepScripts to false, so script nodes are dropped
// before they can reach the globalEval path described above.
function loadChartFragment(target, html, done){
    let nodes = $.parseHTML(String(html || ''));
    $(target).empty().append(nodes);
    if(typeof done === 'function')
        done();
}

// Handle loading a market chart and uplading the title and icon
function loadMarketChart(chart){
    // Hide all tab panels and only show the active one
    $('.tab-pane').removeClass('active show');
    $('#tab-pane-charts').addClass('active show');
    let el = $('#chart-dropdown-' + chart);
    // Update datatable header to show correct icon and text for the data
    var icon = el.find('i').attr('class'),
        text = 'Charts - ' + el.text();
    $('#datatable-header-icon').removeClass().addClass(icon);
    $('#datatable-header-text').text(text);
    // The active view's renderer is what the data refresh re-runs
    let renderer = MARKET_CHART_RENDERERS[chart] || null;
    XC.chartRenderer = renderer;
    // Handle loading the correct chart markup, scripts stripped
    $.get('/charts/' + chart + '.html', function(html){
        loadChartFragment('#market-chart-container', html, renderer);
    }, 'html');
    if(['line','candlestick'].includes(chart))
        ls.setItem('marketChart',chart);
}
