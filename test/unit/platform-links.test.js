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
 * Platform switcher (offline half).
 *
 * Checks the shape of the vendored list and the markup rendered from it.
 * Whether the vendored copy still matches what xchain.io publishes is a
 * separate, network-dependent test:
 * test/smoke/connected/platform-links-drift.test.js
 *
 * Run: npm test
 **********************************************************************/

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const { LINKS, CURRENT, renderPlatformSwitcher } = require('../../src/platform_links.js');

describe('Platform switcher', function () {

    describe('the vendored link list', function () {

        it('is a generated artifact, and says so', function () {
            expect(LINKS.$comment).to.be.a('string');
            expect(LINKS.$comment).to.match(/GENERATED/);
            expect(LINKS.$comment).to.match(/xchain-websites/);
        });

        it('points every entry at an https xchain.io origin', function () {
            expect(LINKS.links).to.be.an('array').that.is.not.empty;
            for (const p of LINKS.links) {
                expect(p.key, 'key').to.be.a('string').that.is.not.empty;
                expect(p.label, 'label').to.be.a('string').that.is.not.empty;
                expect(p.href, `href for ${p.key}`).to.match(/^https:\/\/([a-z-]+\.)?xchain\.io\/$/);
            }
        });

        it('includes this host, so the switcher can mark it', function () {
            expect(LINKS.links.map((p) => p.key)).to.include(CURRENT);
        });

        it('omits the internal dashboard, and includes every live host', function () {
            const keys = LINKS.links.map((p) => p.key);
            expect(keys, 'dashboard.xchain.io is internal and is never listed').to.not.include('dashboard');
            // Liveness rule: a host joins the list only once it serves 200 over
            // HTTPS. mcp.xchain.io met that on 2026-07-29, so it is expected here.
            expect(keys, 'mcp.xchain.io is live').to.include('mcp');
        });

        it('is byte-identical to the file the renderer reads', function () {
            const onDisk = fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', 'content', 'json', 'platform-links.json'), 'utf8');
            expect(JSON.parse(onDisk)).to.deep.equal(LINKS);
        });
    });

    describe('the rendered markup', function () {

        const html = renderPlatformSwitcher();

        it('links every sibling host', function () {
            for (const p of LINKS.links.filter((l) => l.key !== CURRENT)) {
                expect(html, `${p.key} entry`).to.include(`href="${p.href}"`);
            }
        });

        it('marks this host as current and does not link to it', function () {
            const self = LINKS.links.find((p) => p.key === CURRENT);
            expect(html).to.include('aria-current="page"');
            expect(html).to.include('you are here');
            expect(html, 'the current entry must not be clickable').to.not.include(`href="${self.href}"`);
        });

        it('renders exactly one row per entry', function () {
            const rows = html.match(/<li>/g) || [];
            expect(rows).to.have.length(LINKS.links.length);
        });

        it('escapes label and href, so a bad vendored value cannot inject markup', function () {
            // The renderer is fed by a file on disk. If that file is ever
            // replaced with something hostile, the switcher must not become an
            // XSS sink on every explorer page: it renders into the chrome of
            // all of them.
            const hostile = renderPlatformSwitcher({ links: [{
                key: 'evil',
                label: '</a><script>alert(1)</script>',
                icon: 'fa" onload="alert(2)',
                href: 'javascript:alert(3)"><img src=x onerror=alert(4)>',
            }] });
            // The injected text survives as inert characters; what must not
            // survive is its ability to close an attribute or open an element.
            expect(hostile, 'no live script tag').to.not.match(/<script/i);
            expect(hostile, 'no element break-out').to.not.include('"><img');
            expect(hostile, 'no attribute break-out').to.not.match(/onload="/);
            expect(hostile, 'angle brackets escaped').to.include('&lt;script&gt;');
            expect(hostile, 'quotes escaped').to.include('&quot;');
        });
    });
});
