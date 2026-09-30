'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const HTML_DIR = path.resolve(__dirname, '../../../../src/content/html');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../../../src/content/js/jquery.min.js'), 'utf8');

function pageSource(file) {
    return fs.readFileSync(path.join(HTML_DIR, file), 'utf8');
}

function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('function not found: ' + name);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('unterminated function: ' + name);
}

function renderMissing(spec) {
    const source = pageSource(spec.file);
    const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const dom = new JSDOM('<!doctype html><body>' + markup + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = {
            coin: 'RBTC', chain: 'BTC', network: 'regtest', name: 'Bitcoin',
            query: '${spec.query}', pageInfo: {}, actionInfo: {}, transactionInfo: {}, tokenInfo: {}
        };
        var addressId = String(XC.query);
        function updatePageInfo() { window.__pageInfoUpdates = (window.__pageInfoUpdates || 0) + 1; }
        ${extractFunction(source, spec.fn)}
    `);
    dom.window[spec.fn]();
    return { source, window: dom.window, $: dom.window.$ };
}

const CASES = [
    {
        file: 'action.html', fn: 'renderActionNotFound', marker: '#action-not-found',
        query: '404404', title: 'Action #404404 Not Found', body: 'No action exists at this index.',
        nullGuard: /if\(!o \|\| isNull\(o\.action_index\)\)[\s\S]*?renderActionNotFound\(\)/,
        failureWire: /}, renderActionNotFound\);/
    },
    {
        file: 'address.html', fn: 'renderAddressNotFound', marker: '#address-not-found',
        query: 'mMissingAddress', title: 'mMissingAddress Address Not Found', body: 'No address exists with this identifier.',
        nullGuard: /if\(o && o\.address\)[\s\S]*?else\s*{\s*renderAddressNotFound\(\)/,
        failureWire: /}, renderAddressNotFound\);/
    },
    {
        file: 'transaction.html', fn: 'renderTransactionNotFound', marker: '#transaction-not-found',
        query: 'missing-tx', title: 'missing-tx Transaction Not Found', body: 'No transaction exists with this hash.',
        nullGuard: /if\(!o \|\| !o\.tx_hash\)[\s\S]*?renderTransactionNotFound\(\)/,
        failureWire: /}, renderTransactionNotFound\);/
    },
    {
        file: 'token.html', fn: 'renderTokenNotFound', marker: '#token-not-found',
        query: 'MISSING', title: 'MISSING Token Not Found', body: 'No token is issued under this tick.',
        nullGuard: /if\(o && o\.info\)[\s\S]*?else\s*{\s*renderTokenNotFound\(\)/,
        failureWire: /}, renderTokenNotFound\);/
    },
    {
        file: 'block.html', fn: 'renderBlockNotFound', marker: '#block-not-found',
        query: '999999999', title: 'Block #999999999 Not Found', body: 'No block exists at this height.',
        nullGuard: /if\(!o \|\| isNull\(o\.block_index\)\)[\s\S]*?renderBlockNotFound\(\)/,
        failureWire: /}, renderBlockNotFound\);/
    },
    {
        file: 'contract.html', fn: 'renderContractNotFound', marker: '#contract-not-found',
        query: '999999999', title: 'Contract 999999999 Not Found', body: 'No contract exists at this index.',
        nullGuard: /else\s*{\s*renderContractNotFound\(\)/,
        failureWire: /\.fail\(renderContractNotFound\)/
    }
];

describe('detail pages with nonexistent entities', function () {
    for (const spec of CASES) {
        it(spec.file + ' replaces placeholders with an explicit not-found state', function () {
            const page = renderMissing(spec);
            expect(page.$(spec.marker).text()).to.equal(spec.body);
            expect(page.window.XC.pageInfo.title).to.equal(spec.title);
            expect(page.window.__pageInfoUpdates).to.equal(1);
            expect(page.$('body').text()).to.not.contain('Invalid date GMT');
            expect(page.window.XC.pageInfo.title).to.not.contain('undefined');
        });

        it(spec.file + ' maps null success bodies and HTTP failures to that state', function () {
            const source = pageSource(spec.file);
            expect(source).to.match(spec.nullGuard);
            expect(source).to.match(spec.failureWire);
        });
    }
});
