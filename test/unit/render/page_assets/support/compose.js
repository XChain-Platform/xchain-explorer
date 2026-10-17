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
 * Pages as the server sends them, through the shipped renderPage().
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..', '..', '..', '..', '..');
const HTML_DIR = path.join(ROOT, 'src', 'content', 'html');

const { renderPage } = require(path.join(ROOT, 'src', 'explorer', 'request', 'render_page.js'));
const listPage = require(path.join(ROOT, 'src', 'render', 'list_page.js'));

const explorer = {
    util: {
        fileExists:       async (file) => fs.existsSync(file),
        fileGetContents:  async (file) => fs.readFileSync(file, 'utf8')
    }
};

/** Every page fragment a route can name, the shell itself excluded. */
function fragments(){
    return fs.readdirSync(HTML_DIR).filter((f) => f.endsWith('.html') && f !== 'template.html').sort();
}

/** The composed page for one fragment name, as sent. */
async function compose(file){
    const st = { cfg: { type: 'html', file }, response: {} };
    await renderPage(explorer, st);
    return st.response.html;
}

/** Every page a route can serve: the fragments, then the list pages. */
function allPages(){
    return [...fragments(), ...listPage.pages()];
}

module.exports = { ROOT, HTML_DIR, compose, fragments, allPages, listPage };
