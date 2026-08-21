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

describe('html template coverage', () => {

    const routes = sourceHtmlRoutes();

    it('extracts routes from the html table (source parsing did not break)', () => {
        expect(routes.size).to.be.greaterThan(50, 'html route extraction looks broken');
    });

    it('every urls.html file exists on disk in src/content/html/', () => {
        const missing = [];
        for (const [route, file] of routes)
            if (!fs.existsSync(path.join(HTML_DIR, file)))
                missing.push(`${route} -> ${file}`);
        expect(missing, 'routes whose mapped .html file is missing (serves the\n'
            + '"Error loading html file!" sentinel with a 200 status):\n  '
            + missing.join('\n  ')).to.deep.equal([]);
    });
});
