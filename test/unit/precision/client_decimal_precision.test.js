'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const JS_DIR = path.resolve(__dirname, '../../../src/content/js');
const JQUERY = fs.readFileSync(path.join(JS_DIR, 'jquery.min.js'), 'utf8');
const MATH = fs.readFileSync(path.join(JS_DIR, 'math.min.js'), 'utf8');
const NUMERAL = fs.readFileSync(path.join(JS_DIR, 'numeral.js'), 'utf8');
const FORMATTERS = fs.readFileSync(path.join(JS_DIR, 'formatters.js'), 'utf8');
const NETWORK_STATUS = fs.readFileSync(path.join(JS_DIR, 'xchain/network_status.js'), 'utf8');

function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    let end = braceStart;
    for(; end < src.length; end++){
        if(src[end] === '{') depth++;
        if(src[end] === '}' && --depth === 0){ end++; break; }
    }
    return src.slice(start, end);
}

function mathWindow(){
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(MATH);
    dom.window.eval(NUMERAL);
    dom.window.eval(`
        function isNull(v){ return v === null || v === undefined || v === ''; }
        function isNumeric(v){ return v !== '' && isFinite(v); }
        ${extractFn(NETWORK_STATUS, 'bcnum')}
        ${extractFn(NETWORK_STATUS, 'bcformat')}
        ${extractFn(NETWORK_STATUS, 'bcadd')}
        ${extractFn(NETWORK_STATUS, 'bcmul')}
        ${extractFn(NETWORK_STATUS, 'bcdiv')}
    `);
    return dom;
}

describe('client decimal precision', function(){
    it('keeps exact depth amounts and notionals for chart tooltips', function(){
        const dom = mathWindow();
        dom.window.eval(`
            var $ = { each: function(rows, fn){
                Object.keys(rows).forEach(function(key){ fn(key, rows[key]); });
            } };
            var XC = { tick1: 'BIG', tick2: 'USD', CHART_DATA: {
                orderbook: { asks: [['1.00000001', '9007199254740993']], bids: [] }
            } };
            var captured;
            var XCC = {
                depthConfig: function(orders){ captured = orders; return {}; },
                render: function(){}
            };
        `);
        dom.window.eval(fs.readFileSync(path.join(JS_DIR, 'xchain/search_market.js'), 'utf8'));
        dom.window.renderMarketChartDepth();
        expect(dom.window.captured.asks[0][1]).to.equal('9007199254740993.00000000');
        expect(dom.window.captured.asks[0][2]).to.equal('9007199344812985.54740993');
    });

    it('compares candle prices as decimals and preserves exact volume strings', function(){
        const dom = mathWindow();
        dom.window.eval(`
            var $ = { each: function(rows, fn){ rows.forEach(function(row, idx){ fn(idx, row); }); } };
        `);
        dom.window.eval(fs.readFileSync(path.join(JS_DIR, 'xchain/market_updates.js'), 'utf8'));
        const result = dom.window.marketUpdates_historyCandles([
            [1, '9', '9007199254740993'],
            [1, '10', '1'],
            [2, '11', '1']
        ]);
        expect(Array.from(result.ohlc[0])).to.deep.equal([1000, '9', '10', '9', '10']);
        expect(result.volume[0][1]).to.equal('9007199254740994');
    });
});

describe('client decimal precision', function(){
    it('renders token prices without narrowing decimal strings through numeral', function(){
        const dom = mathWindow();
        dom.window.eval(JQUERY);
        dom.window.eval(NUMERAL);
        dom.window.eval(extractFn(FORMATTERS, 'formatAmount'));
        dom.window.eval(`
            var XC = { coin: 'RDOGE', coin_price: '1' };
            function tokenUrl(){ return '#'; }
            function formatLink(){ return ''; }
            function showLockStatus(){ return ''; }
            function renderControllerBindings(){}
            function renderOpenPolls(){}
            function renderLinkedFiles(){}
            function tokenInfo_renderLists(){}
        `);
        // The page loads protocol.js as a classic script, so its helpers are globals;
        // an eval of the strict-mode file would keep them local, so drop the directive.
        dom.window.eval(fs.readFileSync(path.join(JS_DIR, 'formatters/protocol.js'), 'utf8').replace("'use strict';", ''));
        dom.window.eval(fs.readFileSync(path.join(JS_DIR, 'xchain/token_info.js'), 'utf8'));
        dom.window.document.body.innerHTML = '<span id="market-price-coin"></span>';
        dom.window.tokenInfo_renderSummary({
            controllers: [], open_polls: [], linked_files: [], lists: {},
            supply: { current: '1', max: '1' }, mints: { max: '1' },
            info: { owner: 'mOwner', coin: 'DOGE' },
            market: { price: '90071992.54740993', floor: '0' },
            callback: { tick: null }, locks: {}
        }, '', '0,0.00000000', '0,0.00');
        expect(dom.window.$('#market-price-coin').text()).to.equal('90,071,992.54740993');
    });
});
