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
 * Content viewer origin configuration and server-side page injection.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('../../../src/config.js');
const { renderPage } = require('../../../src/explorer/request/render_page.js');

const HTML_DIR = path.join(__dirname, '..', '..', '..', 'src', 'content', 'html');
const originalOrigin = process.env.EXPLORER_CONTENT_VIEWER_ORIGIN;

async function renderToken(origin){
    const explorer = {
        configInfo: { contentViewerOrigin: () => origin },
        util: {
            fileExists: async (file) => fs.existsSync(file),
            fileGetContents: async (file) => fs.readFileSync(file, 'utf8')
        }
    };
    const st = { cfg: { type: 'html', file: 'token.html' }, response: {} };
    await renderPage(explorer, st);
    return st.response.html;
}

describe('content viewer origin', function () {

    afterEach(function () {
        if(originalOrigin === undefined) delete process.env.EXPLORER_CONTENT_VIEWER_ORIGIN;
        else process.env.EXPLORER_CONTENT_VIEWER_ORIGIN = originalOrigin;
    });

    it('is empty when EXPLORER_CONTENT_VIEWER_ORIGIN is absent or is not an HTTPS origin', function () {
        const rejected = [undefined, '', 'http://viewer.example', 'not a URL',
            'https://viewer.example/path', 'https://viewer.example?mode=frame'];

        for(const value of rejected){
            if(value === undefined) delete process.env.EXPLORER_CONTENT_VIEWER_ORIGIN;
            else process.env.EXPLORER_CONTENT_VIEWER_ORIGIN = value;
            assert.strictEqual(config.contentViewerOrigin(), '', String(value));
        }
    });

    it('normalizes a configured HTTPS origin', function () {
        process.env.EXPLORER_CONTENT_VIEWER_ORIGIN = '  https://viewer.example:8443/  ';
        assert.strictEqual(config.contentViewerOrigin(), 'https://viewer.example:8443');
    });

    it('fills the token page setting with a JSON string', async function () {
        const html = await renderToken('https://viewer.example');
        assert.match(html, /XC\.contentViewerOrigin = "https:\/\/viewer\.example";/);
        assert.doesNotMatch(html, /\{CONTENT_VIEWER_ORIGIN\}/);
    });

    it('escapes a less-than sign before placing the value in an inline script', async function () {
        const html = await renderToken('https://viewer.example/<script>');
        assert.match(html, /XC\.contentViewerOrigin = "https:\/\/viewer\.example\/\\u003cscript>";/);
        assert.doesNotMatch(html, /viewer\.example\/<script>/);
    });

});
