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
 * The client keeps TWO separately-written action-to-endpoint maps: one in
 * loadDatatablesData for list pages (pinned by
 * content-client-datatable-endpoints.test.js) and one in loadApiData for
 * single-record fetches. Nothing pinned the second one, and the two had
 * already drifted: loadDatatablesData special-cases 'validator_capability'
 * and 'consensus_state', loadApiData did not, so those names pluralized into
 * '/api/validator_capabilitys' and '/api/consensus_states' - routes that do
 * not exist. A loadApiData 404 is quieter than a list-page one: $.getJSON
 * fails silently and the callback never runs, so the detail card simply never
 * fills in.
 *
 * This pins loadApiData's mapping against the registered /{COIN}/api routes,
 * and pins the two maps to each other on every name they both handle, so the
 * next irregular name added to one side cannot be forgotten on the other.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const CONTENT  = path.resolve(__dirname, '../../src/content');
const CLIENT   = fs.readFileSync(path.join(CONTENT, 'js', 'xchain.js'), 'utf8');
const EXPLORER = fs.readFileSync(path.resolve(__dirname, '../../src/XChainExplorer.js'), 'utf8');

// The registered /{COIN}/api/* route names, read from the live urls table rather
// than restated here, so the assertion cannot drift from the source.
function registeredApiEndpoints() {
    const out = new Set();
    for (const m of EXPLORER.matchAll(/'\/\{COIN\}\/api\/([a-z_]+)/g))
        out.add(m[1]);
    return out;
}

// Slice one function body out of the client, up to the next top-level function.
function functionBody(name) {
    const start = CLIENT.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('function ' + name + ' was not found in xchain.js');
    const rest = CLIENT.slice(start + 1);
    const end  = rest.indexOf('\nfunction ');
    return end < 0 ? CLIENT.slice(start) : CLIENT.slice(start, start + 1 + end);
}

// Reimplementing either mapping would let the copy drift from the shipped rule,
// so both are read out of the shipped function bodies.
function esNames(body) {
    const m = body.match(/\}?\s*else if\(\[([^\]]+)\]\.includes\(action\)\)\{\s*(?:\/\/[^\n]*\n\s*)*endpoint = action \+ 'es';/);
    if (!m) throw new Error("the '-es' branch was not found");
    return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

// Every `else if(action=='x'){ ... endpoint = 'y'; }` single-name special case.
function specialCases(body) {
    const out = new Map();
    for (const m of body.matchAll(/else if\(action=='([a-z_\-]+)'\)\{\s*(?:\/\/[^\n]*\n\s*)*endpoint\s*=\s*'([a-z_]+)';/g))
        out.set(m[1], m[2]);
    return out;
}

// loadApiData's leading branch: names whose endpoint is the action itself.
function apiIdentityNames() {
    const m = functionBody('loadApiData').match(/if\(\[([^\]]+)\]\.includes\(action\)/);
    if (!m) throw new Error('the identity branch of loadApiData was not found');
    return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

function apiEndpointFor(action) {
    const body = functionBody('loadApiData');
    if (apiIdentityNames().includes(action)) return action;
    if (esNames(body).includes(action)) return action + 'es';
    const special = specialCases(body);
    if (special.has(action)) return special.get(action);
    return action + 's';
}

// Every loadApiData(XC.coin, '<action>', ...) call a shipped page or the client
// itself makes.
function apiCallSites() {
    const found = [];
    const files = [{ file: 'js/xchain.js', src: CLIENT }];
    const dir = path.join(CONTENT, 'html');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html')))
        files.push({ file: 'html/' + file, src: fs.readFileSync(path.join(dir, file), 'utf8') });
    for (const { file, src } of files)
        for (const m of src.matchAll(/loadApiData\(\s*XC\.coin\s*,\s*'([a-z_\-]+)'/g))
            found.push({ file, action: m[1] });
    return found;
}

describe('single-record api endpoints', function () {

    it('maps every loadApiData call site to a registered /api route', function () {
        const registered = registeredApiEndpoints();
        const broken     = [];
        const sites      = apiCallSites();
        expect(sites.length, 'no loadApiData call sites were found - the scan regex has drifted').to.be.greaterThan(0);
        for (const { file, action } of sites) {
            const endpoint = apiEndpointFor(action);
            if (!registered.has(endpoint))
                broken.push(file + " loadApiData('" + action + "') -> /api/" + endpoint);
        }
        expect(broken, 'these detail fetches resolve to unregistered routes:\n' + broken.join('\n')).to.deep.equal([]);
    });

    it('resolves the irregular names loadDatatablesData knows to registered /api routes', function () {
        // Names that do not simply take '-s'. A page reaching one of these through
        // loadApiData must land on a real route, not on the pluralized 404 that
        // shipped for validator_capability and consensus_state.
        const listBody = functionBody('loadDatatablesData');
        const registered = registeredApiEndpoints();
        const names = [...esNames(listBody), ...specialCases(listBody).keys()];
        const broken = [];
        for (const action of names) {
            const endpoint = apiEndpointFor(action);
            // 'search' and 'market-history' are list-page-only surfaces with no
            // single-record /api form; anything else must resolve.
            if (['market-history'].includes(action)) continue;
            if (!registered.has(endpoint))
                broken.push("loadApiData('" + action + "') -> /api/" + endpoint);
        }
        expect(broken, 'these irregular names still pluralize into unregistered routes:\n' + broken.join('\n')).to.deep.equal([]);
    });

    it('keeps the two endpoint maps in agreement on every name both handle', function () {
        const listBody = functionBody('loadDatatablesData');
        const apiBody  = functionBody('loadApiData');
        const listEs   = esNames(listBody);
        const apiEs    = esNames(apiBody);
        expect(apiEs.slice().sort(), "the '-es' names differ between loadDatatablesData and loadApiData")
            .to.deep.equal(listEs.slice().sort());
        const listSpecial = specialCases(listBody);
        const apiSpecial  = specialCases(apiBody);
        const disagreements = [];
        for (const [action, endpoint] of listSpecial) {
            // market-history rewrites the type as well, so it is deliberately
            // list-page-only; every other special case must be mirrored.
            if (action === 'market-history') continue;
            if (apiSpecial.get(action) !== endpoint)
                disagreements.push(action + ': list -> ' + endpoint + ', api -> ' + (apiSpecial.get(action) || 'MISSING'));
        }
        expect(disagreements, 'the two maps disagree:\n' + disagreements.join('\n')).to.deep.equal([]);
    });

    it('pins the two names that drifted', function () {
        expect(apiEndpointFor('validator_capability')).to.equal('validator_capabilities');
        expect(apiEndpointFor('consensus_state')).to.equal('consensus_state');
    });

});
