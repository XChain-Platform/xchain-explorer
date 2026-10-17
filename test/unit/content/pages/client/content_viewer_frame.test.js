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
 **********************************************************************/

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');
const { extractFn } = require('../../../../helpers/source_slice');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const MEDIA = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/token_media.js'), 'utf8');
const CONTENT = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/token_content.js'), 'utf8');
const VIEWER = fs.readFileSync(path.join(ROOT, 'src/content/viewer/viewer.html'), 'utf8');

function bindHarness(origin){
    const attrs = {};
    const posts = [];
    const listeners = {};
    let click;
    const contentWindow = { postMessage(message, target){ posts.push({ message, target }); } };
    const iframe = { contentWindow };
    const frame = {
        attr(name, value){ attrs[name] = value; return this; },
        removeAttr(name){ delete attrs[name]; return this; },
        show(){ return this; },
        height(){ return this; }
    };
    const generic = { show(){ return this; }, hide(){ return this; } };
    const context = vm.createContext({
        cachedJson: { html: '<p id="token">token</p>' },
        XC: { contentViewerOrigin: origin },
        document: { getElementById(){ return iframe; } },
        window: { addEventListener(type, fn){ listeners[type] = fn; } },
        $: (selector) => {
            if(selector === '#customContentViewer' || selector === iframe) return frame;
            if(selector === '#loadCustomContentButton') return { click(fn){ click = fn; } };
            return generic;
        },
        isNull: () => false,
        isFinite
    });
    const program = [
        extractFn(MEDIA, 'buildSandboxedContentDoc', 'token_media.js'),
        extractFn(MEDIA, 'customContentViewerUrl', 'token_media.js'),
        extractFn(MEDIA, 'customContentViewerSandbox', 'token_media.js'),
        extractFn(MEDIA, 'customContentHeightToApply', 'token_media.js'),
        'var CUSTOM_CONTENT_MIN_HEIGHT=50,CUSTOM_CONTENT_MAX_HEIGHT=20000,CUSTOM_CONTENT_MAX_RESIZES=25;',
        extractFn(CONTENT, 'tokenContent_bindCustomContent', 'token_content.js'),
        'tokenContent_bindCustomContent({ html: "yes" });'
    ].join('\n');
    vm.runInContext(program, context);
    click();
    return { attrs, posts, listeners, contentWindow };
}

describe('isolated custom content viewer', function(){
    it('announces readiness and accepts only the first valid parent document', function(){
        const posts = [];
        const dom = new JSDOM(VIEWER, {
            runScripts: 'dangerously',
            beforeParse(window){ window.postMessage = (message) => posts.push(message); }
        });
        const window = dom.window;
        const foreign = new JSDOM('').window;
        const send = (source, data) => window.dispatchEvent(new window.MessageEvent('message', { source, data }));

        send(foreign, { type: 'xchain-viewer-html', html: '<p id="foreign"></p>' });
        send(window, { type: 'wrong', html: '<p id="wrong"></p>' });
        send(window, { type: 'xchain-viewer-html', html: 7 });
        send(window, { type: 'xchain-viewer-html', html: '<p id="accepted"></p>' });
        send(window, { type: 'xchain-viewer-html', html: '<p id="second"></p>' });

        expect(posts).to.deep.include({ type: 'xchain-viewer-ready' });
        expect(window.document.getElementById('accepted')).to.not.equal(null);
        expect(window.document.getElementById('foreign')).to.equal(null);
        expect(window.document.getElementById('wrong')).to.equal(null);
        expect(window.document.getElementById('second')).to.equal(null);
    });

    it('builds the configured viewer URL and grants same-origin only in isolated mode', function(){
        const program = [
            extractFn(MEDIA, 'customContentViewerUrl', 'token_media.js'),
            extractFn(MEDIA, 'customContentViewerSandbox', 'token_media.js'),
            '({ url: customContentViewerUrl, sandbox: customContentViewerSandbox })'
        ].join('\n');
        const helpers = vm.runInNewContext(program);

        expect(helpers.url('https://viewer.example')).to.equal('https://viewer.example/viewer.html');
        expect(helpers.url('')).to.equal('');
        expect(helpers.sandbox('https://viewer.example')).to.contain('allow-same-origin');
        expect(helpers.sandbox('')).to.not.contain('allow-same-origin');
    });

    it('loads the configured frame and sends HTML only for its authenticated ready event', function(){
        const origin = 'https://viewer.example';
        const harness = bindHarness(origin);
        expect(harness.attrs.src).to.equal(origin + '/viewer.html');
        expect(harness.attrs).to.not.have.property('srcdoc');
        expect(harness.attrs.sandbox).to.contain('allow-same-origin');

        harness.listeners.message({
            source: harness.contentWindow,
            origin: 'https://wrong.example',
            data: { type: 'xchain-viewer-ready' }
        });
        expect(harness.posts).to.have.length(0);
        harness.listeners.message({
            source: harness.contentWindow,
            origin,
            data: { type: 'xchain-viewer-ready' }
        });
        expect(harness.posts).to.have.length(1);
        expect(harness.posts[0].target).to.equal(origin);
        expect(harness.posts[0].message.type).to.equal('xchain-viewer-html');
        expect(harness.posts[0].message.html).to.contain('<p id="token">token</p>');
    });

    it('keeps the no-configuration fallback opaque and srcdoc-based', function(){
        const harness = bindHarness('');
        expect(harness.attrs).to.not.have.property('src');
        expect(harness.attrs.srcdoc).to.contain('<p id="token">token</p>');
        expect(harness.attrs.sandbox).to.not.contain('allow-same-origin');
    });

    it('pins the ready handshake to the iframe source and configured origin', function(){
        const bind = extractFn(CONTENT, 'tokenContent_bindCustomContent', 'token_content.js');
        expect(bind).to.contain("d.type === 'xchain-viewer-ready'");
        expect(bind).to.match(/e\.source !== iframe\.contentWindow/);
        expect(bind).to.match(/e\.origin !== XC\.contentViewerOrigin/);
        expect(bind).to.contain("type: 'xchain-viewer-html'");
        expect(bind).to.contain('buildSandboxedContentDoc(cachedJson.html)');
        expect(bind).to.contain("el.attr('srcdoc'");
    });
});
