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
 * Every list page names an ACTION, and loadDatatablesData turns that name into
 * an /{COIN}/explorer/<endpoint> URL by pluralization. A name whose pluralized
 * form is not a registered route produces a 404 the page swallows: the table
 * simply stays empty, which reads as "no records" rather than as a defect.
 * cross_chain_matches.html shipped that way ('cross_chain_match' + 's' =
 * 'cross_chain_matchs'), unnoticed, because nothing compared the two sides.
 * This pins the mapping and the registration together, so any future page whose
 * action name does not resolve fails here instead of rendering blank.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const CONTENT  = path.resolve(__dirname, '../../src/content');
const CLIENT   = fs.readFileSync(path.join(CONTENT, 'js', 'xchain.js'), 'utf8');
const EXPLORER = fs.readFileSync(path.resolve(__dirname, '../../src/XChainExplorer.js'), 'utf8');

// The registered /{COIN}/explorer/* route names, read from the live urls table
// rather than restated here, so the assertion cannot drift from the source.
function registeredExplorerEndpoints() {
    const out = new Set();
    for (const m of EXPLORER.matchAll(/'\/\{COIN\}\/explorer\/([a-z_]+)/g))
        out.add(m[1]);
    return out;
}

// Reimplementing the mapping would let the copy drift from the shipped rule, so
// the branch list is read out of loadDatatablesData itself.
function irregularPlurals() {
    const body = CLIENT.slice(CLIENT.indexOf('function loadDatatablesData('));
    const m = body.match(/\}\s*else if\(\[([^\]]+)\]\.includes\(action\)\)\{\s*(?:\/\/[^\n]*\n\s*)*endpoint = action \+ 'es';/);
    if (!m) throw new Error("the '-es' branch of loadDatatablesData was not found");
    return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

function endpointFor(action, esNames) {
    if (['history', 'search'].includes(action)) return action;
    if (esNames.includes(action)) return action + 'es';
    if (action === 'validator_capability') return 'validator_capabilities';
    if (action === 'consensus_state') return 'consensus_state';
    if (action === 'market-history') return 'market';
    return action + 's';
}

// Every loadDatatablesData(XC.coin, '<action>', ...) call a shipped page makes.
function pageActions() {
    const dir = path.join(CONTENT, 'html');
    const found = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const m of src.matchAll(/loadDatatablesData\(\s*XC\.coin\s*,\s*'([a-z_\-]+)'/g))
            found.push({ file, action: m[1] });
    }
    return found;
}

describe('list-page datatable endpoints', function () {

    it('maps every page action name to a registered /explorer route', function () {
        const registered = registeredExplorerEndpoints();
        const esNames    = irregularPlurals();
        const broken     = [];
        for (const { file, action } of pageActions()) {
            const endpoint = endpointFor(action, esNames);
            if (!registered.has(endpoint))
                broken.push(`${file}: '${action}' -> /explorer/${endpoint}`);
        }
        expect(broken, 'page actions resolving to unregistered explorer routes:\n' + broken.join('\n')).to.deep.equal([]);
    });

    it("keeps the '-es' plurals covering the match tables", function () {
        const esNames = irregularPlurals();
        for (const name of ['order_match', 'swap_match', 'cross_chain_match'])
            expect(esNames, `${name} pluralizes to '${name}s', which is not a route`).to.include(name);
    });

    it('finds at least one page action to check', function () {
        expect(pageActions().length).to.be.greaterThan(10);
    });

});
