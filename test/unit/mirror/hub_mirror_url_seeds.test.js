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

const { expect } = require('chai');
const { resolveHubSeeds, resolveHubMode } = require('../../../src/mirror/url.js');

describe('hub mirror URL seed resolution', function () {

    let savedEnv;

    beforeEach(function () {
        savedEnv = {
            seeds: process.env.HUB_SEED_URLS,
            url: process.env.HUB_API_URL
        };
        delete process.env.HUB_SEED_URLS;
        delete process.env.HUB_API_URL;
    });

    afterEach(function () {
        if(savedEnv.seeds === undefined) delete process.env.HUB_SEED_URLS;
        else process.env.HUB_SEED_URLS = savedEnv.seeds;
        if(savedEnv.url === undefined) delete process.env.HUB_API_URL;
        else process.env.HUB_API_URL = savedEnv.url;
    });

    it('prefers the checkpoint seed list over the environment', function () {
        process.env.HUB_SEED_URLS = 'http://env-hub:10000';
        expect(resolveHubSeeds({ hubSeedUrls: 'http://config-hub:10000' }))
            .to.deep.equal(['http://config-hub:10000']);
    });

    it('uses the environment when the checkpoint seed list is empty', function () {
        process.env.HUB_SEED_URLS = ' http://hub-a:10000, ,http://hub-b:10000,http://hub-a:10000 ';
        expect(resolveHubSeeds({ hubSeedUrls: ' , ' }))
            .to.deep.equal(['http://hub-a:10000', 'http://hub-b:10000']);
    });

    it('keeps the default selector unexpanded', function () {
        expect(resolveHubSeeds({ hubSeedUrls: ' default ' })).to.deep.equal(['default']);
    });

    it('selects seeds ahead of a pinned hub URL', function () {
        expect(resolveHubMode({
            hubSeedUrls: 'http://seed-hub:10000',
            hubUrl: 'http://pinned-hub:10000'
        })).to.equal('seeds');
    });

    it('selects pinned when only a hub URL is available', function () {
        expect(resolveHubMode({ hubUrl: 'http://pinned-hub:10000' })).to.equal('pinned');
    });

    it('selects none when neither seeds nor a hub URL are available', function () {
        expect(resolveHubMode(null)).to.equal('none');
    });
});
