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
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../../src/content');
const CLIENT_SRC = require('../../helpers/content-source.js').clientSource();

function bootPage(){
    const markup = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only'
    });
    const win = dom.window;
    Object.defineProperty(win, 'localStorage', { value: {
        getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}
    } });
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.eval(fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = { coin: 'RDOGE' };
    return win;
}

function manifest(status){
    return {
        action_index: 80, name: 'bundle', title: 'Bundle', type: 'image/png', memo: 'memo',
        multipart: {
            file_hash: 'a'.repeat(64), total_parts: 4, parts_received: status === 'pending' ? 2 : 4,
            total_bytes: 4096, status
        }
    };
}

describe('FILE multipart action detail page', function(){
    it('renders a part and links manifest index zero without a raw-file link', function(){
        const win = bootPage();
        win.showFileDetails({
            action_index: 81,
            file_part: { file_hash: 'b'.repeat(64), part_index: 0, manifest_action_index: 0 }
        });
        expect(win.jQuery('#info-file .file-part-row.d-none')).to.have.length(0);
        expect(win.jQuery('#info-file .file-meta-row:not(.d-none)')).to.have.length(0);
        expect(win.jQuery('#info-file .file-part-index').text()).to.equal('0');
        expect(win.jQuery('#info-file .file-part-manifest a').attr('href')).to.equal('/RDOGE/action/0');
        expect(win.jQuery('#info-file a[href$="/raw"]')).to.have.length(0);
        expect(win.jQuery('#info-file .file-viewer').text()).to.contain('assembled file');
    });

    it('states when a part has no indexed manifest', function(){
        const win = bootPage();
        win.showFileDetails({
            action_index: 82,
            file_part: { file_hash: 'c'.repeat(64), part_index: 3, manifest_action_index: null }
        });
        expect(win.jQuery('#info-file .file-part-manifest').text())
            .to.equal('No valid manifest indexed yet');
        expect(win.jQuery('#info-file .file-part-manifest a')).to.have.length(0);
    });

    it('renders pending and mismatched progress without media or raw links', function(){
        for(const status of ['pending', 'mismatch']){
            const win = bootPage();
            win.showFileDetails(manifest(status));
            expect(win.jQuery('#info-file .file-multipart-row.d-none'), status).to.have.length(0);
            expect(win.jQuery('#info-file .file-multipart-parts').text(), status).to.equal(
                status === 'pending' ? '2 of 4' : '4 of 4');
            expect(win.jQuery('#info-file .file-viewer img'), status).to.have.length(0);
            expect(win.jQuery('#info-file a[href$="/raw"]'), status).to.have.length(0);
        }
    });

    it('renders completed media through the raw endpoint', function(){
        const win = bootPage();
        win.showFileDetails(manifest('complete'));
        expect(win.jQuery('#info-file .file-viewer img').attr('src'))
            .to.equal('/RDOGE/api/file/80/raw');
        expect(win.jQuery('#info-file .file-multipart-status').text()).to.equal('Complete');
    });

    it('leaves an ordinary FILE in its existing viewer state', function(){
        const win = bootPage();
        win.showFileDetails({
            action_format: 0, action_index: 20, name: 'plain', title: 'Plain',
            type: 'text/plain', memo: 'note'
        });
        expect(win.jQuery('#info-file .file-name').text()).to.equal('plain');
        expect(win.jQuery('#info-file .file-meta-row.d-none')).to.have.length(0);
        expect(win.jQuery('#info-file .file-part-row:not(.d-none), #info-file .file-multipart-row:not(.d-none)'))
            .to.have.length(0);
        expect(win.jQuery('#info-file .file-viewer a').attr('href')).to.equal('/RDOGE/api/file/20/raw');
    });
});
