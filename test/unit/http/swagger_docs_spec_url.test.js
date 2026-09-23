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
 * The API docs page must load the spec the coverage suite guards.
 *
 * /{COIN}/api renders Swagger UI, which fetches whatever URL
 * swagger-initializer.js names. openapi_coverage.test.js holds
 * docs/openapi.json to the route table, so this pins the initializer's URL
 * to the route that serves those exact bytes. Pointing the page anywhere
 * else forks the published docs from the tested spec again.
 *
 * The legacy docs-page URL is held to the same bytes, which also proves the
 * alias wins over the /json static mount registered after it.
 *********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const express    = require('express');
const request    = require('supertest');
const { expect } = require('chai');
const { methods: mounts } = require('../../../src/explorer/mount.js');

const REPO = path.join(__dirname, '..', '..', '..');
const INITIALIZER = path.join(REPO, 'src', 'content', 'js', 'swagger-initializer.js');
const SPEC_BYTES = fs.readFileSync(path.join(REPO, 'docs', 'openapi.json'));

// The `url:` string literal Swagger UI is configured with.
function initializerUrl() {
    const match = /\burl:\s*"([^"]+)"/.exec(fs.readFileSync(INITIALIZER, 'utf8'));
    expect(match, 'swagger-initializer.js no longer declares a url').to.not.equal(null);
    return match[1];
}

// Collect the body as bytes so the comparison is exact.
function rawBody(res, cb) {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
}

// A bare app carrying only the asset listeners, mounted as setupUrls mounts them.
function assetApp() {
    const host = { app: express(), processIconRequest() {}, processRelayRequest() {} };
    mounts.mountAssetRoutes.call(host, { express, fs }, { static: ['json', 'js'] });
    return host.app;
}

describe('API docs page spec URL', function () {
    it('points Swagger UI at /openapi.json', function () {
        expect(initializerUrl()).to.equal('/openapi.json');
    });

    it('serves the generated docs/openapi.json at the initializer URL', async function () {
        const res = await request(assetApp()).get(initializerUrl()).buffer(true).parse(rawBody);
        expect(res.status).to.equal(200);
        expect(res.headers['content-type']).to.match(/application\/json/);
        expect(res.body.equals(SPEC_BYTES), 'initializer URL does not serve docs/openapi.json').to.equal(true);
    });

    it('answers the legacy /json/xchain-platform-api.json URL with the same bytes', async function () {
        const res = await request(assetApp()).get('/json/xchain-platform-api.json').buffer(true).parse(rawBody);
        expect(res.status).to.equal(200);
        expect(res.body.equals(SPEC_BYTES), 'legacy URL serves a different document').to.equal(true);
    });
});
