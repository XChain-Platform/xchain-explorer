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
 * Platform switcher: vendored-copy drift.
 *
 * src/content/json/platform-links.json is a copy of a file generated in
 * xchain-websites and published at https://xchain.io/assets/platform-links.json.
 * This repo's CI cannot see that repo, so a file-to-file assertion is
 * impossible; instead we fetch the published copy and compare.
 *
 * SKIPS LOUDLY when the network or the host is unavailable. A silent skip
 * would make an offline runner look like a passing one, and this test exists
 * precisely to notice something nobody is watching.
 *
 * On failure: re-copy shared/platform-links.json out of xchain-websites (after
 * rebuilding it there) rather than editing the vendored file by hand.
 *
 * Run: npm run test:smoke:connected
 **********************************************************************/

const { expect } = require('chai');
const { LINKS }  = require('../../../src/platform_links.js');

const PUBLISHED = 'https://xchain.io/assets/platform-links.json';
const TIMEOUT_MS = 8000;

describe('Platform switcher: vendored copy vs published', function () {

    let published = null;
    let reason    = null;

    before(async function () {
        this.timeout(TIMEOUT_MS + 2000);
        const ctrl = new AbortController();
        const killer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(PUBLISHED, { signal: ctrl.signal });
            if (!res.ok) { reason = `HTTP ${res.status}`; return; }
            published = await res.json();
        } catch (err) {
            reason = err.name === 'AbortError' ? `no response in ${TIMEOUT_MS}ms` : err.message;
        } finally {
            clearTimeout(killer);
        }
    });

    it('matches the list published at xchain.io', function () {
        if (!published) {
            console.warn(`\n  ⚠  SKIPPED: could not fetch ${PUBLISHED} (${reason}).`);
            console.warn('     The vendored platform-links.json was NOT verified against the published copy.');
            console.warn('     Re-run with network access before trusting a green result here.\n');
            this.skip();
        }

        expect(published.links, 'published list').to.be.an('array');
        expect(
            published.links,
            'the vendored copy has drifted from the published list. Rebuild xchain-websites and '
            + 're-copy shared/platform-links.json into src/content/json/ (do not hand-edit it).',
        ).to.deep.equal(LINKS.links);
    });
});
