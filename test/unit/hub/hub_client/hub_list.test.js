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
 **********************************************************************/

'use strict';

const assert = require('assert');
const { parseHubList } = require('../../../../src/hub/hub_client/hub_list.js');

function assertInvalidContainersReturnEmpty(){
    assert.deepStrictEqual(parseHubList(null), []);
    assert.deepStrictEqual(parseHubList('not an object'), []);
    assert.deepStrictEqual(parseHubList({ status: 'ok' }), []);
}

function assertInvalidEntriesAreSkipped(){
    const result = parseHubList({
        hubs: [null, 'not an object', {}, { api_url: null }, { api_url: 42 }]
    });
    assert.deepStrictEqual(result, []);
}

function assertOriginsAreOrderedAndUnique(){
    const result = parseHubList({ hubs: [
        { api_url: 'http://one.example' },
        { api_url: 'https://two.example' },
        { api_url: 'http://one.example/' },
        { api_url: 'https://two.example/' }
    ] });
    assert.deepStrictEqual(result, ['http://one.example', 'https://two.example']);
}

function assertUnsupportedUrlShapesAreDropped(){
    const result = parseHubList({ hubs: [
        { api_url: 'https://user@host.example' },
        { api_url: 'https://host.example/path' },
        { api_url: 'https://host.example?query=yes' },
        { api_url: 'https://host.example#fragment' },
        { api_url: 'ftp://host.example' },
        { api_url: 'http://' },
        { api_url: 'not a url' }
    ] });
    assert.deepStrictEqual(result, []);
}

function assertWhitespaceIsTrimmed(){
    assert.deepStrictEqual(parseHubList({
        hubs: [{ api_url: '  https://trimmed.example/\t' }]
    }), ['https://trimmed.example']);
}

describe('parseHubList', function(){
    it('returns an empty list for invalid containers', assertInvalidContainersReturnEmpty);
    it('skips invalid hub entries', assertInvalidEntriesAreSkipped);
    it('returns unique HTTP origins in input order', assertOriginsAreOrderedAndUnique);
    it('drops unsupported URL shapes', assertUnsupportedUrlShapesAreDropped);
    it('trims surrounding API URL whitespace', assertWhitespaceIsTrimmed);
});
