/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * One jsdom realm carrying the shipped jQuery and the shipped client, the same
 * boot the other content_client_search suites use. searchNavigate is replaced
 * with a recorder because jsdom cannot navigate, so a redirect is observed as
 * the call the page makes rather than as a changed location.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'src', 'content');
const SOURCES    = require('../../../../../../helpers/content-source.js');
const CLIENT_SRC = SOURCES.clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');

function bootClient(url, body){
    const dom = new JSDOM('<!doctype html><html><body>' + (body || '') + '</body></html>', {
        runScripts: 'outside-only',
        url: url
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    const navigations = [];
    win.searchNavigate = function(dest, replace){ navigations.push({ dest: dest, replace: replace === true }); };
    return { win, navigations };
}

module.exports = { bootClient, SOURCES };
