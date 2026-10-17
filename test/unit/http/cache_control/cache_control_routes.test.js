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
 * Every registered GET route resolves to exactly one cache class.
 *
 * Driven by the route tables and by the listeners a real app registers, the
 * way openapi_coverage holds the spec to the same tables: a route added
 * without a classification fails here by name instead of shipping as
 * no-store, and a classification whose route is gone fails as a dead entry.
 */

'use strict';

const { expect } = require('chai');

const { routeTables } = require('../../../../src/explorer/routes/index.js');
const { classifyRequest, CACHE_CLASSES, ROUTE_CLASSES, FAMILY_CLASSES, CATCH_ALL } =
    require('../../../../src/http/cache_control.js');
const { buildApp, getRoutes } = require('./support/app.js');

const urls = routeTables();
const TABLE_TEMPLATES = [
    ...Object.keys(urls.api).map(t => ['api', t]),
    ...Object.keys(urls.explorer).map(t => ['explorer', t])
];

// A concrete path for a route-table template.
function samplePath(template) {
    return template.replace('{COIN}', 'BTC').replace('{TYPE}', 'block')
        .replace(/\{[A-Z0-9_]+\}/g, 'X1');
}

// A concrete path for an express path string.
function sampleExpressPath(routePath) {
    return routePath.replace(':coin', 'BTC').replace(/:[A-Za-z]+/g, '1');
}

// Every class list a family appears in, so a duplicate shows up as two.
function familyClasses(family) {
    return Object.entries(FAMILY_CLASSES)
        .flatMap(([cls, families]) => families.filter(f => f === family).map(() => cls));
}

function registerTableTests(routes) {
    it('classifies every route-table template through exactly one family entry', () => {
        expect(TABLE_TEMPLATES.length).to.be.greaterThan(200, 'route table extraction looks broken');
        const problems = [];
        for (const [namespace, template] of TABLE_TEMPLATES) {
            const family = namespace + '/' + template.split('/')[3];
            const classes = familyClasses(family);
            if (classes.length !== 1)
                problems.push(template + ' -> ' + family + ' listed ' + classes.length + ' times');
        }
        expect(problems).to.deep.equal([]);
    });

    it('lets no express listener claim a route-table path ahead of the catch-all', () => {
        const shadowed = [];
        for (const [, template] of TABLE_TEMPLATES) {
            const path = samplePath(template);
            const claims = routes.filter(r => r.path !== CATCH_ALL && r.layer.match(path));
            if (claims.length) shadowed.push(template + ' -> ' + claims.map(r => r.path).join(', '));
        }
        expect(shadowed).to.deep.equal([]);
    });

    it('answers every route-table template with the class its family names', () => {
        for (const [namespace, template] of TABLE_TEMPLATES) {
            const family = namespace + '/' + template.split('/')[3];
            const expected = familyClasses(family)[0];
            expect(classifyRequest('GET', samplePath(template), CATCH_ALL), template).to.equal(expected);
            expect(classifyRequest('HEAD', samplePath(template), CATCH_ALL), template).to.equal(expected);
        }
    });

    it('names no family that the route tables do not register', () => {
        const registered = new Set(TABLE_TEMPLATES.map(([ns, t]) => ns + '/' + t.split('/')[3]));
        const dead = Object.values(FAMILY_CLASSES).flat().filter(f => !registered.has(f));
        expect(dead).to.deep.equal([]);
    });
}

function registerExpressTests(routes) {
    it('classifies every registered express GET listener exactly once', () => {
        const express = routes.map(r => r.path).filter(p => p !== CATCH_ALL);
        expect(express.length).to.be.greaterThan(15, 'listener extraction looks broken');
        const unclassified = express.filter(p => !Object.prototype.hasOwnProperty.call(ROUTE_CLASSES, p));
        expect(unclassified).to.deep.equal([]);
        const counts = {};
        for (const p of express) counts[p] = (counts[p] || 0) + 1;
        expect(Object.entries(counts).filter(([, n]) => n > 1)).to.deep.equal([]);
    });

    it('names no express route that the app does not register', () => {
        const registered = new Set(routes.map(r => r.path));
        expect(Object.keys(ROUTE_CLASSES).filter(p => !registered.has(p))).to.deep.equal([]);
    });

    it('resolves each express listener to its own entry, not to a family', () => {
        for (const [routePath, cls] of Object.entries(ROUTE_CLASSES)) {
            const path = sampleExpressPath(routePath);
            expect(classifyRequest('GET', path, routePath), routePath).to.equal(cls);
            const claims = routes.filter(r => r.path !== CATCH_ALL && r.layer.match(path));
            expect(claims.map(r => r.path), routePath).to.deep.equal([routePath]);
        }
    });

    it('uses only the declared classes', () => {
        const used = [...Object.values(ROUTE_CLASSES).filter(c => c !== null), ...Object.keys(FAMILY_CLASSES)];
        for (const cls of used) expect(CACHE_CLASSES, cls).to.have.property(cls);
    });
}

describe('cache control: route-table classification', function () {
    const routes = getRoutes(buildApp().app);
    registerTableTests(routes);
});

describe('cache control: express listener classification', function () {
    const routes = getRoutes(buildApp().app);
    registerExpressTests(routes);
});
