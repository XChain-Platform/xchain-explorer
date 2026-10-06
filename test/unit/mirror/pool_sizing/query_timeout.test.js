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
const {
    normalizeDbType,
    resolveQueryTimeout
} = require('../../../../src/mirror/pool_sizing.js');

describe('database type normalization', function () {

    it('defaults missing and empty values to indexer', function () {
        expect(normalizeDbType(undefined)).to.equal('indexer');
        expect(normalizeDbType(null)).to.equal('indexer');
        expect(normalizeDbType('')).to.equal('indexer');
    });

    it('trims and lowercases the type', function () {
        expect(normalizeDbType('  Decoder ')).to.equal('decoder');
    });

    it('preserves dashes', function () {
        expect(normalizeDbType('Hub-Mirror')).to.equal('hub-mirror');
    });
});

describe('query timeout resolution', function () {

    it('uses 30000 by default', function () {
        expect(resolveQueryTimeout('indexer', {})).to.equal(30000);
    });

    it('applies the flat timeout to every database type', function () {
        const env = { DB_QUERY_TIMEOUT: '5000' };
        expect(resolveQueryTimeout('indexer', env)).to.equal(5000);
        expect(resolveQueryTimeout('decoder', env)).to.equal(5000);
        expect(resolveQueryTimeout('hub-mirror', env)).to.equal(5000);
    });

    it('prefers a scoped timeout over the flat timeout', function () {
        const env = { DB_QUERY_TIMEOUT: '5000', DB_QUERY_TIMEOUT_INDEXER: '7000' };
        expect(resolveQueryTimeout('indexer', env)).to.equal(7000);
    });

    it('falls through a blank scoped timeout to the flat timeout', function () {
        const env = { DB_QUERY_TIMEOUT: '5000', DB_QUERY_TIMEOUT_INDEXER: '  ' };
        expect(resolveQueryTimeout('indexer', env)).to.equal(5000);
    });

    it('matches scoped timeout names case-insensitively', function () {
        const env = { DB_QUERY_TIMEOUT_DECODER: '7000' };
        expect(resolveQueryTimeout('DECODER', env)).to.equal(7000);
    });

    it('maps dashes to underscores in scoped timeout names', function () {
        const env = { DB_QUERY_TIMEOUT_HUB_MIRROR: '7000' };
        expect(resolveQueryTimeout('hub-mirror', env)).to.equal(7000);
    });

    it('ignores a scoped timeout for another database type', function () {
        const env = { DB_QUERY_TIMEOUT_INDEXER: '7000' };
        expect(resolveQueryTimeout('decoder', env)).to.equal(30000);
    });

    it('falls back when a timeout is not positive', function () {
        for(const value of ['abc', '0', '-5']) {
            expect(resolveQueryTimeout('indexer', { DB_QUERY_TIMEOUT: value })).to.equal(30000);
        }
    });

    it('parses a timeout with a unit suffix', function () {
        const env = { DB_QUERY_TIMEOUT: '2500ms' };
        expect(resolveQueryTimeout('indexer', env)).to.equal(2500);
    });
});
