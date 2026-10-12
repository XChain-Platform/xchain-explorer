// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const { parseDeclaredColumns } = require('../../../../src/hub/hub_db_sync/ensure_tables.js');

function assertColumnMetadataAndOrder() {
    const sql = [
        'CREATE TABLE `balances` (',
        '  `amount` DECIMAL(20,8) NOT NULL DEFAULT 0,',
        '  `primary_id` BIGINT PRIMARY KEY,',
        '  `sequence` BIGINT AUTO_INCREMENT,',
        "  `label` VARCHAR(20) DEFAULT 'ready',",
        '  `nullable_value` TEXT',
        ') ENGINE=InnoDB;'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredColumns(sql), [
        { name: 'amount', definition: '`amount` DECIMAL(20,8) NOT NULL DEFAULT 0', notNull: true, hasDefault: true },
        { name: 'primary_id', definition: '`primary_id` BIGINT PRIMARY KEY', notNull: true, hasDefault: false },
        { name: 'sequence', definition: '`sequence` BIGINT AUTO_INCREMENT', notNull: true, hasDefault: false },
        { name: 'label', definition: "`label` VARCHAR(20) DEFAULT 'ready'", notNull: false, hasDefault: true },
        { name: 'nullable_value', definition: '`nullable_value` TEXT', notNull: false, hasDefault: false }
    ]);
}

function assertTableConstructsAreSkipped() {
    const sql = [
        'CREATE TABLE records (',
        '  `kept` INT,',
        '  PRIMARY KEY (`kept`),',
        '  UNIQUE KEY `unique_kept` (`kept`),',
        '  INDEX `index_kept` (`kept`),',
        '  KEY `key_kept` (`kept`),',
        '  CHECK (`kept` > 0),',
        '  CONSTRAINT `positive_kept` CHECK (`kept` > 0),',
        '  FOREIGN KEY (`kept`) REFERENCES parents (`id`)',
        ') ENGINE=InnoDB;'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredColumns(sql), [
        { name: 'kept', definition: '`kept` INT', notNull: false, hasDefault: false }
    ]);
}

function assertInvalidAndCommentedSqlReturnsExpectedValues() {
    const commentedSql = [
        'CREATE TABLE comments (',
        '  -- `ignored` DECIMAL(20,8) NOT NULL DEFAULT 1,',
        '  `visible` INT',
        ') ENGINE=InnoDB;'
    ].join('\n');
    const constraintsOnlySql = [
        'CREATE TABLE empty_table (',
        '  PRIMARY KEY (`id`)',
        ') ENGINE=InnoDB;'
    ].join('\n');

    assert.deepStrictEqual(parseDeclaredColumns(commentedSql), [
        { name: 'visible', definition: '`visible` INT', notNull: false, hasDefault: false }
    ]);
    assert.strictEqual(parseDeclaredColumns('SELECT 1;'), null);
    assert.strictEqual(parseDeclaredColumns(constraintsOnlySql), null);
}

describe('parseDeclaredColumns', function () {
    it('returns column metadata in source order', assertColumnMetadataAndOrder);
    it('skips table-level keys, indexes, checks, and constraints', assertTableConstructsAreSkipped);
    it('ignores comments and rejects SQL without declared columns', assertInvalidAndCommentedSqlReturnsExpectedValues);
});
