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
 ********************************************************************/

const assert     = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockReq, mockRes } = require('../../fixtures/mock-query-args.js');
const themes = require('../../../src/content/themes/resolve.js');

describe('theme.json resolution', function () {

    it('resolves an extends chain root first so the child loads over its parent', function () {
        const chain = themes.resolveChain(themes.THEMES_DIR, 'skin-demo');
        assert.deepEqual(chain, ['classic', 'skin-demo']);

        const page = '<link type="text/css" rel="stylesheet" href="/themes/classic/tokens.css">';
        const rendered = themes.applyToHtml(page, { queryTheme: 'skin-demo' });
        assert.ok(rendered.indexOf('/themes/classic/tokens.css') < rendered.indexOf('/themes/skin-demo/tokens.css'));
    });

    it('rejects unknown names and names that could escape the theme directory', function () {
        assert.equal(themes.resolveChain(themes.THEMES_DIR, 'missing-theme'), null);
        assert.equal(themes.resolveChain(themes.THEMES_DIR, '../classic'), null);
    });
});

describe('theme selection precedence', function () {

    it('uses the configured default when no request selection is present', function () {
        const selected = themes.resolveForRequest({ defaultThemeName: 'skin-demo' });
        assert.equal(selected.name, 'skin-demo');
    });

    it('uses the cookie over the configured default', function () {
        const selected = themes.resolveForRequest({
            defaultThemeName: 'skin-demo',
            cookieHeader: 'other=value; xc_theme=classic'
        });
        assert.equal(selected.name, 'classic');
    });

    it('uses the query override over the cookie and configured default', function () {
        const selected = themes.resolveForRequest({
            defaultThemeName: 'classic',
            cookieHeader: 'xc_theme=classic',
            queryTheme: 'skin-demo'
        });
        assert.equal(selected.name, 'skin-demo');
    });

    it('falls back loudly to the default when the requested theme does not resolve', function () {
        const fallbacks = [];
        const selected = themes.resolveForRequest({
            defaultThemeName: 'classic',
            queryTheme: 'missing-theme',
            onFallback: (requested, fallback) => fallbacks.push({ requested, fallback })
        });
        assert.equal(selected.name, 'classic');
        assert.deepEqual(fallbacks, [{ requested: 'missing-theme', fallback: 'classic' }]);
    });

    it('falls back loudly to classic when the configured default does not resolve', function () {
        const fallbacks = [];
        const selected = themes.resolveForRequest({
            defaultThemeName: 'missing-theme',
            onFallback: (requested, fallback) => fallbacks.push({ requested, fallback })
        });
        assert.equal(selected.name, 'classic');
        assert.deepEqual(fallbacks, [{ requested: 'missing-theme', fallback: 'classic' }]);
    });
});

describe('theme default configuration', function () {
    const config = require('../../../src/config.js');
    const original = process.env.EXPLORER_DEFAULT_THEME;

    afterEach(function () {
        if(original === undefined) delete process.env.EXPLORER_DEFAULT_THEME;
        else process.env.EXPLORER_DEFAULT_THEME = original;
    });

    it('defaults to classic', function () {
        delete process.env.EXPLORER_DEFAULT_THEME;
        assert.equal(config.defaultTheme(), 'classic');
    });

    it('reads EXPLORER_DEFAULT_THEME live', function () {
        process.env.EXPLORER_DEFAULT_THEME = 'skin-demo';
        assert.equal(config.defaultTheme(), 'skin-demo');
    });
});

const mockApp = { use(){}, get(){}, post(){}, enable(){} };
const expressMock = () => mockApp;
expressMock.static = () => {};
expressMock.json = () => {};

class MockDB {
    async init(){}
    getMaxMethodResults(){ return 100; }
    async getData(){ return [null, null]; }
}

const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
    express: expressMock,
    './db/index.js': MockDB
});

function makeExplorer(defaultTheme){
    const configInfo = createConfigInfoStub();
    configInfo.defaultTheme = () => defaultTheme || 'classic';
    return new XChainExplorer(mockApp, configInfo);
}

function request(reqPath, query, cookie){
    const req = mockReq(reqPath, query || {});
    if(cookie) req.headers.cookie = cookie;
    return req;
}

describe('theme selection on rendered pages', function () {

    it('a config default themes the rendered page', async function () {
        const explorer = makeExplorer('skin-demo');
        const res = mockRes();
        await explorer.processRequest(request('/about'), res);
        assert.match(res._body, /href="\/themes\/skin-demo\/tokens\.css"/);
    });

    it('a cookie themes the rendered page', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processRequest(request('/about', {}, 'xc_theme=skin-demo'), res);
        assert.match(res._body, /href="\/themes\/skin-demo\/tokens\.css"/);
    });

    it('a query override beats a cookie on the rendered page', async function () {
        const explorer = makeExplorer();
        const res = mockRes();
        await explorer.processRequest(request('/about', { theme: 'classic' }, 'xc_theme=skin-demo'), res);
        assert.match(res._body, /href="\/themes\/classic\/tokens\.css"/);
        assert.equal(res._body.includes('/themes/skin-demo/tokens.css'), false);
    });

    it('?theme=skin-demo restyles any page and removing it restores the default', async function () {
        const explorer = makeExplorer();
        const themed = mockRes();
        await explorer.processRequest(request('/about', { theme: 'skin-demo' }), themed);
        assert.match(themed._body, /href="\/themes\/skin-demo\/tokens\.css"/);

        const restored = mockRes();
        await explorer.processRequest(request('/about'), restored);
        assert.match(restored._body, /href="\/themes\/classic\/tokens\.css"/);
        assert.equal(restored._body.includes('/themes/skin-demo/tokens.css'), false);
    });

    it('an unknown query theme logs and renders with the default stylesheet', async function () {
        const warnings = [];
        const originalWarn = console.warn;
        const explorer = makeExplorer();
        const res = mockRes();
        console.warn = (message) => warnings.push(String(message));
        try {
            await explorer.processRequest(request('/about', { theme: 'missing-theme' }), res);
        } finally {
            console.warn = originalWarn;
        }
        assert.match(res._body, /href="\/themes\/classic\/tokens\.css"/);
        assert.ok(warnings.some((warning) => warning.includes('THEME_RESOLUTION_FALLBACK')));
        assert.ok(warnings.some((warning) => warning.includes('missing-theme')));
    });
});
