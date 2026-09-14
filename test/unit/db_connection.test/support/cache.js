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
 * Unit tests for Database connection management functions in src/db/index.js
 * Covers: constructor, setupConnectionPools, getConnection, releaseConnection
 */

'use strict';

const {
    sinon, expect, createConfigInfoStub, getFullConfig, Database, mockMariadb, setMockMariadb,
    createMockConnection, createMockPool, buildExplorer, freshDatabase, hubShapeConfig,
} = require('./helpers.js');


function cacheTestsOne() {
    it('_cacheGet returns undefined for missing key', function () {
        const db = freshDatabase();
        const cache = new Map();
        expect(db.cacheGet(cache, 'missing')).to.be.undefined;
    });

    it('_cacheSet and _cacheGet round-trip a value', function () {
        const db = freshDatabase();
        const cache = new Map();
        db.cacheSet(cache, 'key1', 'value1');
        expect(db.cacheGet(cache, 'key1')).to.equal('value1');
    });

    it('_cacheGet promotes key to most-recent (LRU behavior)', function () {
        const db = freshDatabase();
        const cache = new Map();
        db.cacheSet(cache, 'a', 1, 3);
        db.cacheSet(cache, 'b', 2, 3);
        db.cacheSet(cache, 'c', 3, 3);
        // Access 'a' to promote it
        db.cacheGet(cache, 'a');
        // Add a 4th entry, which should evict the LRU key ('b')
        db.cacheSet(cache, 'd', 4, 3);
        expect(db.cacheGet(cache, 'b')).to.be.undefined;
        expect(db.cacheGet(cache, 'a')).to.equal(1);
    });

    it('_cacheSet evicts oldest entry when maxSize exceeded', function () {
        const db = freshDatabase();
        const cache = new Map();
        db.cacheSet(cache, 'a', 1, 2);
        db.cacheSet(cache, 'b', 2, 2);
        // Adding 'c' should evict 'a'
        db.cacheSet(cache, 'c', 3, 2);
        expect(cache.size).to.equal(2);
        expect(db.cacheGet(cache, 'a')).to.be.undefined;
        expect(db.cacheGet(cache, 'b')).to.equal(2);
        expect(db.cacheGet(cache, 'c')).to.equal(3);
    });

    it('_cacheSet overwrites existing key without increasing size', function () {
        const db = freshDatabase();
        const cache = new Map();
        db.cacheSet(cache, 'a', 1, 2);
        db.cacheSet(cache, 'a', 99, 2);
        expect(cache.size).to.equal(1);
        expect(db.cacheGet(cache, 'a')).to.equal(99);
    });

}


function cacheTestsTwo() {
    it('_cacheGet returns correct value (not just truthy)', function () {
        const db = freshDatabase();
        const cache = new Map();
        db.cacheSet(cache, 'zero', 0);
        db.cacheSet(cache, 'false', false);
        db.cacheSet(cache, 'empty', '');
        expect(db.cacheGet(cache, 'zero')).to.equal(0);
        expect(db.cacheGet(cache, 'false')).to.equal(false);
        expect(db.cacheGet(cache, 'empty')).to.equal('');
    });


}

module.exports = { cacheTestsOne, cacheTestsTwo };
