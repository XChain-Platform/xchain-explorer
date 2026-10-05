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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { parseDeclaredIndexes } = require('../../../../src/hub/hub_db_sync/ensure_tables.js');

function assertInlineIndexesAreNormalized() {
    const sql = [
        'CREATE TABLE widgets (',
        '  `id` BIGINT,',
        '  KEY `idx_addr_kind` (`ADDR`(62), `Kind`),',
        '  UNIQUE KEY uniq_code (`Code`)',
        ');'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredIndexes(sql, 'widgets'), [
        {
            unique: false,
            name: 'idx_addr_kind',
            columns: ['addr', 'kind'],
            cols: '`ADDR`(62), `Kind`'
        },
        { unique: true, name: 'uniq_code', columns: ['code'], cols: '`Code`' }
    ]);
}

function assertStandaloneIndexesAreScopedAndDeduplicated() {
    const sql = [
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_height ON widgets (`Height`);',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_height ON widgets (`Height`);',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_other ON other_table (`Height`);'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredIndexes(sql, 'widgets'), [
        { unique: true, name: 'idx_height', columns: ['height'], cols: '`Height`' }
    ]);
}

function assertCommentsAndUnsupportedIndexesAreIgnored() {
    const sql = [
        "SELECT 'kept -- text'; CREATE INDEX idx_quoted_dash ON widgets (`Quoted`);",
        'CREATE TABLE widgets (',
        '  `message` VARCHAR(64),',
        '  PRIMARY KEY (`id`),',
        '  FULLTEXT KEY idx_message (`message`),',
        '  -- KEY idx_commented (`hidden`)',
        '  KEY idx_visible (`message`)',
        ');'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredIndexes(sql, 'widgets'), [
        { unique: false, name: 'idx_visible', columns: ['message'], cols: '`message`' },
        { unique: false, name: 'idx_quoted_dash', columns: ['quoted'], cols: '`Quoted`' }
    ]);
}

describe('parseDeclaredIndexes', function () {
    it('normalizes inline key declarations', assertInlineIndexesAreNormalized);
    it('scopes standalone indexes and removes duplicate names', assertStandaloneIndexesAreScopedAndDeduplicated);
    it('ignores comments and unsupported index declarations', assertCommentsAndUnsupportedIndexesAreIgnored);
});
