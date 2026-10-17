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
 **********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const VIEWER_PATH = path.resolve(__dirname, '../../../../src/content/viewer/viewer.html');
const VIEWER_HTML = fs.readFileSync(VIEWER_PATH, 'utf8');

function loadViewer() {
    const posts = [];
    const dom = new JSDOM(VIEWER_HTML, {
        runScripts: 'dangerously',
        beforeParse(window) {
            window.postMessage = (message) => posts.push(message);
        },
    });
    const send = (source, data) => dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', { source, data }));
    return { dom, posts, send };
}

describe('standalone content viewer page', () => {
    it('announces that it is ready to its parent', () => {
        const { dom, posts } = loadViewer();

        expect(posts).to.deep.include({ type: 'xchain-viewer-ready' });
        dom.window.close();
    });

    it('renders only the first valid HTML message from its parent', () => {
        const { dom, send } = loadViewer();
        const foreign = new JSDOM('').window;

        send(foreign, { type: 'xchain-viewer-html', html: '<p id="foreign">foreign</p>' });
        send(dom.window, { type: 'unrelated', html: '<p id="wrong-type">wrong</p>' });
        send(dom.window, { type: 'xchain-viewer-html', html: 5 });

        expect(dom.window.document.getElementById('foreign')).to.equal(null);
        expect(dom.window.document.getElementById('wrong-type')).to.equal(null);

        send(dom.window, { type: 'xchain-viewer-html', html: '<p id="first">first</p>' });
        send(dom.window, { type: 'xchain-viewer-html', html: '<p id="second">second</p>' });

        expect(dom.window.document.getElementById('first')).not.to.equal(null);
        expect(dom.window.document.getElementById('second')).to.equal(null);
        foreign.close();
        dom.window.close();
    });
});
