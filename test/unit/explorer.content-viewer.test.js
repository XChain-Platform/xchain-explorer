'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// GET /content-viewer serves the host document for a token's custom HTML.
// It exists as a route, rather than the srcdoc string it replaced, for exactly
// one reason: a srcdoc/blob:/data: document INHERITS its embedder's CSP, so the
// app-wide frame-src ('self', youtube, soundcloud) refused every other embed and
// token art rendered as a broken-page placeholder. A fetched document is governed
// by its own response header instead. These tests hold that header to its bargain:
// permissive about what the art may LOAD, absolute about the opaque origin that
// contains it.

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

const { CONTENT_VIEWER_CSP } = require('../../src/XChainExplorer.js');

function makeExplorer() {
    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
        express:   { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        './db.js': function() { this.init = () => {}; }
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    return new XChainExplorer(app, createConfigInfoStub());
}

// The policy is one string of "directive value; directive value" pairs.
function directive(name) {
    const found = CONTENT_VIEWER_CSP.split(';')
        .map(s => s.trim())
        .find(s => s === name || s.startsWith(name + ' '));
    return found === undefined ? null : found.slice(name.length).trim();
}

// The token page frames a token's embed directly, so its own frame-src has to admit the
// host serving that embed. Widened on that ONE response, by rewriting the policy already
// set for it, so no other page loosens and the two policies cannot drift apart.
describe('token-page frame-src', function () {
    const { widenFrameSrc, TOKEN_PAGE_FRAME_SRC } = require('../../src/XChainExplorer.js');
    const APP_WIDE = "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-src 'self' https://www.youtube.com; object-src 'none'";

    function widened(policy) {
        const res = mockRes();
        if (policy !== null) res.set('Content-Security-Policy', policy);
        res.getHeader = (n) => res._headers[n];
        widenFrameSrc(res, TOKEN_PAGE_FRAME_SRC);
        return res._headers['Content-Security-Policy'];
    }

    it('replaces only the frame-src directive, leaving the rest of the policy alone', function () {
        const out = widened(APP_WIDE);
        expect(out).to.contain('frame-src https:');
        expect(out).to.not.contain('youtube');            // the narrow list is superseded
        expect(out).to.contain("default-src 'self'");     // everything else survives
        expect(out).to.contain("script-src 'self' 'unsafe-inline'");
        expect(out).to.contain("object-src 'none'");
    });

    it('states frame-src when the policy has none, rather than trusting default-src', function () {
        // Without a frame-src of its own a policy falls back to default-src, which would
        // still refuse the embed, so the directive has to be added and not assumed.
        expect(widened("default-src 'self'")).to.contain('frame-src https:');
    });

    it('does nothing when no policy was set', function () {
        expect(widened(null)).to.equal(undefined);
    });
});

describe('XChainExplorer#processContentViewerRequest', function () {

    it('serves the viewer document as html', function () {
        const res = mockRes();
        makeExplorer().processContentViewerRequest({ path: '/content-viewer' }, res);

        expect(res._type).to.equal('html');
        expect(res._body).to.contain('xchain-iframe-ready');    // the handshake the page waits on
        expect(res._body).to.contain('xchain-iframe-content');
    });

    it('replaces the app-wide CSP on this response', function () {
        const res = mockRes();
        makeExplorer().processContentViewerRequest({ path: '/content-viewer' }, res);

        // Helmet sets the app-wide policy on the way in; the header set here is what
        // the browser applies to the document, and it must be this one.
        expect(res._headers['Content-Security-Policy']).to.equal(CONTENT_VIEWER_CSP);
    });

    it('tells the CDN not to rewrite it, and does not ask for origin-keying', function () {
        const res = mockRes();
        makeExplorer().processContentViewerRequest({ path: '/content-viewer' }, res);

        // An edge that injects its script loader or analytics beacon into this document
        // runs that code in an opaque origin: it posts to a target origin that cannot
        // match and calls home to a path that refuses it, and every one of those lands
        // in the reader's console as an error against a page that asked for none of it.
        expect(res._headers['Cache-Control']).to.contain('no-transform');
        // Requesting origin-keying on an origin already site-keyed by every other page
        // is a guaranteed console warning and buys this document nothing.
        expect(res._headers['Origin-Agent-Cluster']).to.equal('?0');
    });

    it('forces an opaque origin, so a reader who opens the route directly is still contained', function () {
        // Without this the route would be a same-origin HTML document that renders
        // whatever a caller can get written into it - an XSS gadget on the explorer's
        // own origin. `sandbox` in the CSP holds even when there is no iframe attribute
        // to enforce, e.g. the URL pasted into a tab.
        const sandbox = directive('sandbox');
        expect(sandbox, 'the sandbox directive is the containment').to.not.equal(null);
        expect(sandbox).to.contain('allow-scripts');
        expect(sandbox).to.not.contain('allow-same-origin');  // would hand back the explorer origin
        expect(sandbox).to.not.contain('allow-top-navigation'); // would let art navigate the page away
    });

    it('admits third-party embeds and media, which is the whole point of the route', function () {
        // The regression this route fixes: frame-src refused everything but youtube
        // and soundcloud, so art embedding any other host showed a broken-page icon.
        for (const name of ['frame-src', 'img-src', 'media-src', 'style-src', 'script-src', 'connect-src'])
            expect(directive(name), name + ' must admit https').to.contain('https:');
        expect(directive('object-src')).to.equal("'none'");     // plugins stay off
    });

    it("keeps 'self' out of the fetch directives, which would read as protection it is not", function () {
        // In an opaque origin 'self' matches nothing, so a reader seeing it in this
        // policy would draw the wrong conclusion about what is restricted here.
        for (const pair of CONTENT_VIEWER_CSP.split(';').map(s => s.trim())) {
            if (pair.startsWith('frame-ancestors')) continue;   // matched against the URL, real here
            expect(pair, pair + " must not lean on 'self'").to.not.contain("'self'");
        }
        // frame-ancestors IS meaningful: it stops another site embedding the viewer
        // to borrow this policy for its own content.
        expect(directive('frame-ancestors')).to.equal("'self'");
    });
});
