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
 * Drift guard: every file the `html` route table in src/XChainExplorer.js
 * maps to must exist on disk. A missing template is not a routing error -
 * processRequest() falls back to the literal string 'Error loading html
 * file!' and still answers 200 (see the html-serving branch), so a plain
 * status-code smoke test cannot catch it. This is the OpenAPI coverage
 * gate's counterpart for the html table instead of the api table.
 */

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const SRC       = fs.readFileSync(path.join(__dirname, '../../src/XChainExplorer.js'), 'utf8');
const HTML_DIR  = path.join(__dirname, '../../src/content/html');

// Pull the `'html' : { ... }` table's '<route>' : '<file>.html' entries out of
// the source. Scoped to that one table (not a global .html scan) so an entry
// added to 'api' or 'explorer' that happens to end in .html can't slip in.
function sourceHtmlRoutes() {
    const tableMatch = SRC.match(/'html'\s*:\s*\{([\s\S]*?)\n {12}\},/);
    if (!tableMatch)
        throw new Error('could not locate the html route table in src/XChainExplorer.js');
    const out = new Map(); // route -> file
    for (const m of tableMatch[1].matchAll(/'([^']*)'\s*:\s*'([^']*\.html)'/g))
        out.set(m[1], m[2]);
    return out;
}

const SOURCE = require('../helpers/content-source.js');

describe('html template coverage', () => {

    const routes = sourceHtmlRoutes();

    it('extracts routes from the html table (source parsing did not break)', () => {
        expect(routes.size).to.be.greaterThan(50, 'html route extraction looks broken');
    });

    // A route's markup comes from one of two places now: a fragment on disk, or
    // the shared list-page composition, which 76 near-identical pages collapsed
    // onto (spec M2.3). What still matters is that EVERY route resolves to one
    // of them - a route that resolves to neither serves the "Error loading html
    // file!" sentinel with a 200, which is the failure this gate exists to
    // catch and which the collapse did nothing to make less likely.
    it('every urls.html route resolves to a fragment or the list-page composer', () => {
        const missing = [];
        for (const [route, file] of routes)
            if (!SOURCE.pageExists(file))
                missing.push(`${route} -> ${file}`);
        expect(missing, 'routes whose markup exists nowhere (serves the\n'
            + '"Error loading html file!" sentinel with a 200 status):\n  '
            + missing.join('\n  ')).to.deep.equal([]);
    });

    it('the collapsed routes really do come from the composer, not from disk', () => {
        const composed = [...routes.values()].filter((f) => SOURCE.isComposed(f));
        expect(composed.length, 'no route is served by the list-page composer, which\n'
            + 'means the collapse silently reverted to per-page fragments').to.be.greaterThan(50);
        const strays = composed.filter((f) => fs.existsSync(path.join(HTML_DIR, f)));
        expect(strays, 'fragments left behind for routes the composer now serves; the\n'
            + 'file is dead weight and the next reader will edit it expecting an effect:\n  '
            + strays.join('\n  ')).to.deep.equal([]);
    });
});
