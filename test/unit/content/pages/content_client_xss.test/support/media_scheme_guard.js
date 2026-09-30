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
 * A read-only review found the token metadata video URL reaching an iframe
 * (and a video/audio src) with only escapeHtml() applied. escapeHtml() does
 * not touch the five characters a javascript: URI needs, and the youtube/
 * soundcloud branches test the URL with a bare substring match, which a
 * "javascript:...//youtube" value also passes. This harness pins the fix: a
 * non-http(s) scheme must never reach the src/iframe, and a real http(s)
 * media URL must still render exactly as before.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'content');
const CLIENT_SRC = require('../../../../../helpers/content-source.js').clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');
const TOKEN      = path.join(CONTENT, 'html', 'token.html');

function bootPage(){
    const markup = fs.readFileSync(TOKEN, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/token/CAMPC'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    return win;
}

const EVIL_YOUTUBE    = 'javascript:alert(1)//youtube';
const EVIL_SOUNDCLOUD = 'javascript:alert(1)//soundcloud';
const EVIL_FILE       = 'javascript:alert(1)//grandma.mp4';

describe('token artwork: video/audio scheme guard @regression', function(){

    it('refuses a javascript: URI shaped to pass the youtube substring test', function(){
        const win = bootPage();
        win.tokenContent_displayArtwork(false, false, EVIL_YOUTUBE);
        expect(win.jQuery('#video-wrapper-youtube iframe').length, 'a hostile scheme reached an iframe').to.equal(0);
        expect(win.jQuery('#video-wrapper video').length, 'a hostile scheme reached a video element').to.equal(0);
    });

    it('refuses a javascript: URI on the plain (non-youtube) video branch', function(){
        const win = bootPage();
        win.tokenContent_displayArtwork(false, false, EVIL_FILE);
        expect(win.jQuery('#video-wrapper video').length, 'a hostile scheme reached a video element').to.equal(0);
    });

    it('refuses a javascript: URI shaped to pass the soundcloud substring test', function(){
        const win = bootPage();
        win.tokenContent_displayArtwork(false, EVIL_SOUNDCLOUD, false);
        expect(win.jQuery('#audio-wrapper-soundcloud iframe').length, 'a hostile scheme reached an iframe').to.equal(0);
        expect(win.jQuery('#audio-wrapper audio').length, 'a hostile scheme reached an audio element').to.equal(0);
    });

    it('still embeds a real youtube URL (positive control)', function(){
        const win = bootPage();
        win.tokenContent_displayArtwork(false, false, 'https://www.youtube.com/embed/abc123');
        expect(win.jQuery('#video-wrapper-youtube iframe').attr('src')).to.equal('https://www.youtube.com/embed/abc123');
    });

    it('still plays a real http(s) audio URL (positive control)', function(){
        const win = bootPage();
        win.tokenContent_displayArtwork(false, 'https://example.test/song.mp3', false);
        expect(win.jQuery('#audio-wrapper audio').attr('src')).to.equal('https://example.test/song.mp3');
    });

});
