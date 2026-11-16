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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const readers = require('../../../../src/db/readers/entities/files_multipart.js');

function readerWith(rows) {
    const calls = [];
    return {
        calls,
        reader: {
            doQuery: async (...args) => {
                calls.push(args);
                return rows;
            },
        },
    };
}

describe('getFilePartDetail row mapping', function() {
    it('returns the part detail from exactly one query', async function() {
        const row = {
            action_index: 91, source: 'bc1qsource', tx_hash: 'a'.repeat(64),
            block_index: 200, status: 'valid', file_hash: 'b'.repeat(64),
            part_index: 3, manifest_action_index: 75,
        };
        const stub = readerWith([row]);

        const result = await readers.getFilePartDetail.call(stub.reader, { coin: 'BTC' }, 91);

        expect(result).to.deep.equal(row);
        expect(stub.calls).to.have.length(1);
    });
});

describe('getFilePartDetail without a valid manifest', function() {
    it('keeps the part and returns a null manifest index', async function() {
        const row = {
            action_index: 92, source: 'bc1qsource', tx_hash: 'c'.repeat(64),
            block_index: 201, status: 'valid', file_hash: 'd'.repeat(64),
            part_index: 4, manifest_action_index: null,
        };
        const stub = readerWith([row]);

        const result = await readers.getFilePartDetail.call(stub.reader, { coin: 'BTC' }, 92);

        expect(result).to.deep.equal(row);
        expect(stub.calls).to.have.length(1);
    });
});

describe('getFilePartDetail for a non-part index', function() {
    it('returns null after exactly one query', async function() {
        const stub = readerWith([]);

        const result = await readers.getFilePartDetail.call(stub.reader, { coin: 'BTC' }, 93);

        expect(result).to.equal(null);
        expect(stub.calls).to.have.length(1);
    });
});

describe('getFilePartDetail query binding', function() {
    it('binds the numeric index without placing it in SQL text', async function() {
        const stub = readerWith([]);
        const config = { coin: 'BTC' };

        await readers.getFilePartDetail.call(stub.reader, config, '987654321');

        const [seenConfig, sql, params] = stub.calls[0];
        expect(seenConfig).to.equal(config);
        expect(params).to.deep.equal([987654321]);
        expect(sql).to.include('WHERE fp.action_index=?');
        expect(sql).to.not.include('987654321');
    });
});
