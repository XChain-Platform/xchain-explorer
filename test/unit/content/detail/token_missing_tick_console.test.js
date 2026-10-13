'use strict';

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
 * A token page for a tick with no token on that chain: the API answers 404,
 * and the page's fetch must treat that as the not-found state and write
 * nothing to the console itself. The "Failed to load resource" line a browser
 * prints for any non-2xx request comes from its network layer, which no page
 * script can silence; this suite pins that the page adds no line of its own.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { expect } = require('chai');

const { extractFn } = require('../../../helpers/source_slice.js');

const JS_DIR    = path.resolve(__dirname, '../../../../src/content/js');
const API_SRC   = fs.readFileSync(path.join(JS_DIR, 'xchain/api_proof.js'), 'utf8');
const TOKEN_SRC = fs.readFileSync(path.resolve(__dirname, '../../../../src/content/html/token.html'), 'utf8');

// loadApiData with $.getJSON answering the way jQuery does for an HTTP 404.
function loadWith404(debug){
    const consoleCalls = [];
    const logged = [];
    const record = name => (...args) => consoleCalls.push([name, args]);
    const context = vm.createContext({
        console: { log: record('log'), warn: record('warn'), error: record('error'), info: record('info') },
        XC: { debug },
        XCLogger: { log: (...args) => logged.push(args) },
        $: {
            getJSON(url){
                return { fail(cb){ cb({ status: 404, responseJSON: { error: 'The requested resource was not found.', code: 'NOT_FOUND' } }); } };
            }
        }
    });
    vm.runInContext(extractFn(API_SRC, 'loadApiData'), context);
    const outcome = { success: 0, errback: [] };
    context.loadApiData('TLTC', 'token', 'XCHAIN', null,
        () => { outcome.success++; },
        (body, xhr) => { outcome.errback.push({ body, status: xhr && xhr.status }); });
    return { consoleCalls, logged, outcome };
}

describe('token page for a tick with no token', function () {
    it('routes the 404 to the errback with the parsed body', function () {
        const { outcome } = loadWith404(false);
        expect(outcome.success).to.equal(0);
        expect(outcome.errback).to.deep.equal([{ body: { error: 'The requested resource was not found.', code: 'NOT_FOUND' }, status: 404 }]);
    });

    it('writes nothing to the console outside debug mode', function () {
        const { consoleCalls, logged } = loadWith404(false);
        expect(consoleCalls).to.deep.equal([]);
        expect(logged).to.deep.equal([]);
    });

    it('wires the token fetch failure to the not-found render', function () {
        expect(TOKEN_SRC).to.match(/loadApiData\(XC\.coin, 'token', XC\.query, null, function\(o\)\{[\s\S]*?\}, renderTokenNotFound\);/);
    });
});
